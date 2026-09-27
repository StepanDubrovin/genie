// genie web — local HTTP server for the Linear-style UI.
//
// Binds to 127.0.0.1; with --tailscale also to this machine's tailnet address.
// Protections: Host allowlist (DNS rebinding), a custom header on every write
// (cross-site forms cannot send it), no CORS. On the tailnet the author of
// comments/tasks is taken from `tailscale whois`.

import { execFile, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { DOC_STATUSES, DOC_TYPES, parseDoc, type DocStatus, type DocType } from "../docs/parser.ts";
import { DocsService } from "../docs/service.ts";
import { ORCHESTRATOR, TeamBus } from "../team/bus.ts";
import { loadConfig, type MemberSpec, PACKAGE_ROOT } from "../team/config.ts";
import { addMembers, deleteTeam, reapClosedTeams, removeMember, stopTeam } from "../team/ops.ts";
import { repoInfo } from "../tracker/fsutil.ts";
import { type Actor, isMemberRole, MEMBER_ROLES, STATUSES, type Status, TASK_TYPES, type TaskType, isStatus, ARTIFACT_KINDS, type ArtifactKind } from "../tracker/model.ts";
import { GenieError, type Tracker } from "../tracker/store.ts";
import { inlineDisposition, readRepoImage, RepoImageError } from "./artifacts.ts";
import { atomicWriteFile, docsFilesSignature, passesThroughSymlink } from "./docs.ts";
import { detectImageMime } from "./images.ts";

const execFileAsync = promisify(execFile);
const WEB_ROOT = path.join(PACKAGE_ROOT, "web", "dist");
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".map": "application/json",
  ".woff2": "font/woff2",
  ".png": "image/png",
};

interface Options {
  port: number;
  tailscale: boolean;
  open: boolean;
}

/** Options for the testable web app factory; startWebServer adds the bind/tailnet bits. */
export interface WebAppOptions {
  port: number;
  /** Extra `host:port` entries accepted by the Host allowlist (tailnet names). */
  hostnames?: string[];
  /** Tailnet DNS name echoed by /api/meta. */
  tailnet?: string;
  /** Directory used to resolve the main checkout for docs; defaults to process.cwd(). */
  cwd?: string;
}

export interface WebApp {
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;
  close: () => void;
}

/** Map a docs-service failure onto an HTTP status: missing pages are 404, everything else is a bad request. */
function docsErrorStatus(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);
  if (/not found|not indexed/.test(message)) return 404;
  return 400;
}

async function tailscaleInfo(): Promise<{ ip: string; dnsName: string; shortName: string }> {
  const { stdout: ip } = await execFileAsync("tailscale", ["ip", "-4"], { encoding: "utf8" });
  const { stdout: status } = await execFileAsync("tailscale", ["status", "--json"], { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
  const self = (JSON.parse(status) as { Self?: { DNSName?: string; HostName?: string } }).Self ?? {};
  const dnsName = (self.DNSName ?? "").replace(/\.$/, "");
  return { ip: ip.trim().split("\n")[0], dnsName, shortName: dnsName.split(".")[0] || (self.HostName ?? "") };
}

const whoisCache = new Map<string, string>();
async function tailnetUser(remote: string): Promise<string | undefined> {
  if (whoisCache.has(remote)) return whoisCache.get(remote);
  try {
    const { stdout } = await execFileAsync("tailscale", ["whois", "--json", remote], { encoding: "utf8", timeout: 3000 });
    const login = (JSON.parse(stdout) as { UserProfile?: { LoginName?: string; DisplayName?: string } }).UserProfile;
    const name = login?.DisplayName || login?.LoginName;
    if (name) whoisCache.set(remote, name);
    return name;
  } catch {
    return undefined;
  }
}

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function send(res: http.ServerResponse, status: number, body: unknown, type = "application/json; charset=utf-8"): void {
  const data = typeof body === "string" || body instanceof Uint8Array ? body : JSON.stringify(body);
  res.writeHead(status, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" });
  res.end(data);
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 1_000_000) throw new HttpError(413, "request too large");
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "invalid JSON");
  }
}

export function createWebApp(tracker: Tracker, opts: WebAppOptions): WebApp {
  const bus = new TeamBus(tracker);
  const localUser = os.userInfo().username;
  const allowedHosts = new Set([`127.0.0.1:${opts.port}`, `localhost:${opts.port}`]);
  for (const host of opts.hostnames ?? []) if (host) allowedHosts.add(`${host}:${opts.port}`);
  const tailnetName = opts.tailnet;
  const docsCwd = opts.cwd ?? process.cwd();
  // Repo images are served from the checkout the server runs in (docs use the
  // main checkout instead). A file that only exists in a linked worktree is
  // therefore not reachable and its reference degrades to text.
  const imageRoot = repoInfo(docsCwd)?.toplevel ?? docsCwd;

  // Server-sent events: one data_version poll for all clients.
  const clients = new Set<http.ServerResponse>();
  let version = tracker.db.dataVersion();
  const broadcast = () => {
    for (const c of clients) c.write(`event: change\ndata: ${Date.now()}\n\n`);
  };
  const timers: NodeJS.Timeout[] = [];
  timers.push(setInterval(() => {
    const v = tracker.db.dataVersion();
    if (v !== version) {
      version = v;
      broadcast();
    }
  }, 700));
  timers.push(setInterval(() => {
    for (const c of clients) c.write(": ping\n\n");
  }, 20_000));
  for (const timer of timers) timer.unref();
  const close = (): void => {
    for (const timer of timers) clearInterval(timer);
    timers.length = 0;
  };

  // Teams keep running only while their task is open: closing a task here (or
  // anywhere) stops its team. Checked right after status changes and periodically.
  const reap = () =>
    reapClosedTeams(tracker, bus)
      .then((ids) => {
        if (ids.length) {
          console.log(`genie web: stopped team(s) of closed tasks: ${ids.join(", ")}`);
          version = -1;
        }
      })
      .catch((err) => console.error(`genie web: reaping failed: ${err instanceof Error ? err.message : String(err)}`));
  const reapTimer = setInterval(reap, 20_000);
  reapTimer.unref();
  timers.push(reapTimer);
  void reap();

  async function actorFor(req: http.IncomingMessage): Promise<Actor> {
    const remote = req.socket.remoteAddress ?? "";
    const octets = remote.replace(/^::ffff:/, "").split(".").map(Number);
    // Tailscale addresses come from the CGNAT range 100.64.0.0/10.
    if (octets.length === 4 && octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127) {
      const who = await tailnetUser(remote.replace(/^::ffff:/, ""));
      if (who) return { name: who, role: "human" };
    }
    return { name: localUser, role: "human" };
  }

  function teamView(id: string) {
    const team = bus.get(id);
    let task: { id: string; title: string; status: Status } | undefined;
    try {
      const t = tracker.get(team.task);
      task = { id: t.id, title: t.title, status: t.status };
    } catch {
      // task gone
    }
    return { ...team, taskInfo: task, pending: Object.fromEntries(team.members.map((m) => [m.name, bus.pending(team.id, m.name)])) };
  }

  // Docs API over the G-8 core service. The web serves the main checkout's docs
  // (repoInfo(cwd).mainRoot), never an unmerged linked-worktree copy.
  let docs: DocsService | undefined;
  let docsSignature: string | undefined;
  const docsService = (): DocsService => {
    if (!docs) {
      const base = repoInfo(docsCwd)?.mainRoot ?? docsCwd;
      docs = new DocsService({ db: tracker.db, cwd: base, trackerDir: tracker.dir, docsRoot: loadConfig(tracker.dir).docs.root });
    }
    return docs;
  };
  /** Detection path for the docs-version poll: refresh the index when files changed. */
  const docsChangeSignal = (service: DocsService): string => {
    const signature = docsFilesSignature(service.docsRoot);
    if (signature !== docsSignature) {
      docsSignature = signature;
      service.refresh();
      version = tracker.db.dataVersion();
      broadcast();
    }
    return signature;
  };
  /** Write path: the index was just refreshed explicitly, so only the signal changes. */
  const notifyDocsChanged = (service: DocsService): void => {
    docsSignature = docsFilesSignature(service.docsRoot);
    version = tracker.db.dataVersion();
    broadcast();
  };

  async function api(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    const method = req.method ?? "GET";
    const parts = url.pathname.split("/").filter(Boolean).slice(1); // drop "api"
    const write = method !== "GET";
    if (write && req.headers["x-genie"] !== "1") throw new HttpError(403, "missing X-Genie header");
    const body = write ? await readBody(req) : {};
    const me = write ? await actorFor(req) : undefined;
    const changed = () => {
      version = tracker.db.dataVersion();
      broadcast();
    };

    // GET /api/meta
    if (parts[0] === "meta" && method === "GET") {
      const actor = await actorFor(req);
      const cfg = loadConfig(tracker.dir);
      return send(res, 200, { ...tracker.meta(), counts: tracker.counts(), statuses: STATUSES, roles: MEMBER_ROLES, roleModels: cfg.roleModels ?? {}, types: TASK_TYPES, user: actor.name, tailnet: tailnetName });
    }

    if (parts[0] === "tasks") {
      const id = parts[1];
      if (!id && method === "GET") {
        const status = (url.searchParams.get("status") ?? "").split(",").filter(isStatus) as Status[];
        const type = (url.searchParams.get("type") ?? "").split(",").filter((t) => TASK_TYPES.includes(t as never)) as TaskType[];
        return send(
          res,
          200,
          tracker.list({
            status: status.length ? status : undefined,
            type: type.length ? type : undefined,
            excludeEpics: url.searchParams.get("epics") === "0",
            includeClosed: url.searchParams.get("closed") === "1",
            search: url.searchParams.get("q") ?? undefined,
            parent: url.searchParams.get("parent") ?? undefined,
          }),
        );
      }
      if (!id && method === "POST") {
        const task = tracker.create(me!, {
          title: String(body.title ?? ""),
          description: body.description ? String(body.description) : undefined,
          acceptance: Array.isArray(body.acceptance) ? body.acceptance.map(String).filter(Boolean) : undefined,
          priority: body.priority !== undefined ? Number(body.priority) : undefined,
          labels: Array.isArray(body.labels) ? body.labels.map(String).filter(Boolean) : undefined,
          type: TASK_TYPES.includes(body.type as never) ? (body.type as never) : undefined,
          parent: body.parent ? String(body.parent) : undefined,
          status: "inbox",
        });
        changed();
        return send(res, 201, task);
      }
      if (id && !parts[2] && method === "GET") return send(res, 200, tracker.get(id));
      if (id && !parts[2] && method === "PATCH") {
        const task = tracker.update(me!, id, {
          title: body.title !== undefined ? String(body.title) : undefined,
          description: body.description !== undefined ? String(body.description) : undefined,
          priority: body.priority !== undefined ? Number(body.priority) : undefined,
          labels: Array.isArray(body.labels) ? body.labels.map(String) : undefined,
          mergeStrategy: body.mergeStrategy !== undefined ? String(body.mergeStrategy) : undefined,
          addAcceptance: Array.isArray(body.addAcceptance) ? body.addAcceptance.map(String) : undefined,
          plan: body.plan !== undefined ? String(body.plan) : undefined,
          parent: body.parent === undefined ? undefined : body.parent ? String(body.parent) : null,
        });
        changed();
        return send(res, 200, task);
      }
      if (id && parts[2] === "status" && method === "POST") {
        const to = String(body.status ?? "");
        if (!isStatus(to)) throw new HttpError(400, `unknown status ${to}`);
        const task = tracker.setStatus(me!, id, to, { note: body.note ? String(body.note) : undefined, force: true });
        if (to === "done" || to === "cancelled") await reap();
        changed();
        return send(res, 200, task);
      }
      if (id && parts[2] === "comments" && method === "POST") {
        const task = tracker.comment(me!, id, String(body.text ?? ""), "owner");
        changed();
        return send(res, 201, task);
      }
      if (id && parts[2] === "acceptance" && parts[3] && method === "POST") {
        const task = tracker.check(me!, id, Number(parts[3]), body.done !== false);
        changed();
        return send(res, 200, task);
      }
      if (id && parts[2] === "artifacts" && !parts[3] && method === "POST") {
        const kind = ARTIFACT_KINDS.includes(body.kind as never) ? (body.kind as ArtifactKind) : "doc";
        const task = tracker.addArtifact(me!, id, {
          kind,
          name: String(body.name ?? "").trim() || undefined,
          content: String(body.text ?? ""),
          note: body.note ? String(body.note) : undefined,
        });
        changed();
        return send(res, 201, task);
      }
      if (id && parts[2] === "artifacts" && parts[3] && method === "GET") {
        const a = tracker.readArtifact(id, Number(parts[3]));
        if (url.searchParams.get("download") === "1") {
          res.setHeader("content-disposition", `attachment; filename="${a.name.replace(/"/g, "")}"`);
          return send(res, 200, a.content, "application/octet-stream");
        }
        const mime = detectImageMime(a.content);
        if (url.searchParams.get("raw") === "1") {
          if (!mime) throw new HttpError(415, "artifact is not a supported raster image");
          res.setHeader("content-disposition", inlineDisposition(a.name));
          return send(res, 200, a.content, mime);
        }
        return send(res, 200, { name: a.name, kind: a.kind, size: a.content.byteLength, text: a.text, ...(mime ? { mime } : {}) });
      }
    }

    // GET /api/images?path=<repo-relative> — contained inline raster bytes.
    if (parts[0] === "images" && !parts[1] && method === "GET") {
      try {
        const { bytes, mime } = readRepoImage(imageRoot, url.searchParams.get("path") ?? "");
        res.setHeader("content-disposition", "inline");
        return send(res, 200, bytes, mime);
      } catch (error) {
        if (error instanceof RepoImageError) throw new HttpError(error.status, error.message);
        throw error;
      }
    }

    if (parts[0] === "docs") {
      const service = docsService();
      const section = parts[1] ?? "";

      // GET /api/docs/version — lightweight change signal an open UI can poll.
      if (section === "version" && method === "GET") return send(res, 200, { version: docsChangeSignal(service) });

      // GET /api/docs/tree — every page's metadata plus the per-file diagnostics (D1 badge data).
      if (section === "tree" && method === "GET") {
        const pages = service.list();
        docsSignature = docsFilesSignature(service.docsRoot);
        return send(res, 200, {
          version: docsSignature,
          pages,
          diagnostics: pages.filter((page) => page.diagnostics.length).map((page) => ({ path: page.path, diagnostics: page.diagnostics })),
        });
      }

      // GET /api/docs/search?q=&type=&status=&limit=
      if (section === "search" && method === "GET") {
        const query = url.searchParams.get("q") ?? "";
        const type = url.searchParams.get("type") ?? "";
        const status = url.searchParams.get("status") ?? "";
        if (type && !DOC_TYPES.includes(type as DocType)) throw new HttpError(400, `unknown docs type ${type}`);
        if (status && !DOC_STATUSES.includes(status as DocStatus)) throw new HttpError(400, `unknown docs status ${status}`);
        const rawLimit = url.searchParams.get("limit");
        let limit: number | undefined;
        if (rawLimit !== null) {
          limit = Number(rawLimit);
          if (!Number.isFinite(limit) || limit < 1) throw new HttpError(400, `invalid docs limit ${rawLimit}`);
        }
        const results = query.trim()
          ? service.search(query, { ...(type ? { type: type as DocType } : {}), ...(status ? { status: status as DocStatus } : {}), limit })
          : [];
        return send(res, 200, { query, results });
      }

      // GET /api/docs/page?path=&heading=&maxChars= — whole page by default, a section with `heading`.
      if (section === "page" && method === "GET") {
        const docPath = (url.searchParams.get("path") ?? "").trim();
        if (!docPath) throw new HttpError(400, "missing docs path");
        const headingParam = url.searchParams.get("heading");
        const heading = headingParam ? headingParam : undefined;
        const rawMax = url.searchParams.get("maxChars");
        let maxChars: number | undefined;
        if (rawMax !== null) {
          maxChars = Number(rawMax);
          if (!Number.isFinite(maxChars) || maxChars < 1) throw new HttpError(400, `invalid docs maxChars ${rawMax}`);
        }
        const limits = maxChars !== undefined ? { maxChars } : {};
        try {
          const page = heading !== undefined
            ? service.read(docPath, { heading, ...limits })
            : service.read(docPath, { wholePage: true, ...limits });
          return send(res, 200, page);
        } catch (error) {
          throw new HttpError(docsErrorStatus(error), error instanceof Error ? error.message : String(error));
        }
      }

      // POST /api/docs/page — create/save a page (X-Genie already enforced); validate metadata, write atomically, refresh.
      if (section === "page" && method === "POST") {
        const docPath = String(body.path ?? "").trim();
        const content = body.content !== undefined ? String(body.content) : body.text !== undefined ? String(body.text) : undefined;
        if (!docPath) throw new HttpError(400, "missing docs path");
        if (content === undefined) throw new HttpError(400, "missing docs content");
        if (content.trim().length === 0) throw new HttpError(400, "docs content must not be empty");
        const mode = body.mode === undefined || body.mode === "" ? "upsert" : String(body.mode);
        if (mode !== "create" && mode !== "update" && mode !== "upsert") throw new HttpError(400, `unknown docs mode ${mode}`);
        let file: string;
        try {
          file = service.resolvePath(docPath);
        } catch (error) {
          throw new HttpError(400, error instanceof Error ? error.message : String(error));
        }
        // Reject writing through an in-docs symlink alias; resolvePath canonicalizes it away otherwise.
        const lexical = path.resolve(service.docsRoot, path.extname(docPath) ? docPath : `${docPath}.md`);
        if (passesThroughSymlink(service.docsRoot, lexical)) throw new HttpError(400, "refusing to save through a symlinked docs path");
        const exists = fs.existsSync(file);
        if (mode === "create" && exists) throw new HttpError(409, "documentation page already exists");
        if (mode === "update" && !exists) throw new HttpError(404, "documentation page not found");
        const parsed = parseDoc(content, docPath);
        if (parsed.diagnostics.length) return send(res, 422, { error: "invalid documentation metadata", diagnostics: parsed.diagnostics });
        try {
          atomicWriteFile(file, content);
        } catch (error) {
          throw new HttpError(docsErrorStatus(error), error instanceof Error ? error.message : String(error));
        }
        service.refresh();
        notifyDocsChanged(service);
        return send(res, exists ? 200 : 201, { page: service.read(docPath, { wholePage: true }), diagnostics: parsed.diagnostics });
      }

      throw new HttpError(404, "not found");
    }

    if (parts[0] === "teams") {
      const id = parts[1];
      if (!id && method === "GET") return send(res, 200, bus.list({ includeStopped: url.searchParams.get("all") === "1" }).map((t) => teamView(t.id)));
      if (id && !parts[2] && method === "GET") return send(res, 200, { ...teamView(id), mail: bus.history(id, 200), log: bus.readLog(id, 200) });
      if (id && !parts[2] && method === "DELETE") {
        const out = await deleteTeam(tracker, bus, id, { by: me!.name, removeWorktree: url.searchParams.get("removeWorktree") === "1" });
        changed();
        return send(res, 200, { ok: true, report: out });
      }
      if (id && parts[2] === "stop" && method === "POST") {
        const out = await stopTeam(tracker, bus, id, { reason: "owner", by: me!.name, removeWorktree: !!body.removeWorktree });
        changed();
        return send(res, 200, { ok: true, report: out });
      }
      if (id && parts[2] === "members" && !parts[3] && method === "POST") {
        const role = String(body.role ?? "");
        if (!isMemberRole(role)) throw new HttpError(400, `unknown role ${role}`);
        const spec: MemberSpec = {
          role,
          name: body.name ? String(body.name).trim().toLowerCase() || undefined : undefined,
          model: body.model ? String(body.model).trim() || undefined : undefined,
          thinking: body.thinking ? String(body.thinking) : undefined,
          instructions: body.instructions ? String(body.instructions) : undefined,
        };
        const added = await addMembers(tracker, bus, id, [spec], { by: me!.name, note: spec.instructions });
        changed();
        return send(res, 201, added);
      }
      if (id && parts[2] === "members" && parts[3] && method === "DELETE") {
        await removeMember(tracker, bus, id, decodeURIComponent(parts[3]), me!.name);
        changed();
        return send(res, 200, { ok: true });
      }
      if (id && parts[2] === "mail" && method === "POST") {
        const to = String(body.to ?? "all");
        const sent = bus.send({ team: id, from: `owner (${me!.name})`, fromRole: "human", to: to === "orchestrator" ? ORCHESTRATOR : to, text: String(body.text ?? ""), urgent: !!body.urgent });
        changed();
        return send(res, 201, sent);
      }
    }
    throw new HttpError(404, "not found");
  }

  const handler = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    try {
      if (!allowedHosts.has(String(req.headers.host ?? ""))) throw new HttpError(421, "unexpected Host header");
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/api/events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        res.write("retry: 2000\n\n");
        clients.add(res);
        req.on("close", () => clients.delete(res));
        return;
      }
      if (url.pathname.startsWith("/api/")) return await api(req, res, url);
      if (req.method !== "GET") throw new HttpError(405, "method not allowed");
      if (!fs.existsSync(path.join(WEB_ROOT, "index.html"))) {
        return send(res, 503, "genie web UI is not built yet: run `npm install && npm run build:web` in the genie package", "text/plain; charset=utf-8");
      }
      // Client-side routes (/active, /team/G-7…) fall back to the SPA entry.
      const rel = !path.extname(url.pathname) ? "index.html" : decodeURIComponent(url.pathname.slice(1));
      const file = path.resolve(WEB_ROOT, rel);
      if (!file.startsWith(WEB_ROOT + path.sep) || !fs.existsSync(file)) throw new HttpError(404, "not found");
      const type = MIME[path.extname(file)] ?? "application/octet-stream";
      res.writeHead(200, { "content-type": type, "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", ...(rel.startsWith("assets/") ? { "cache-control": "public, max-age=31536000, immutable" } : { "cache-control": "no-store" }) });
      res.end(fs.readFileSync(file));
    } catch (err) {
      const status = err instanceof HttpError ? err.status : err instanceof GenieError ? 422 : 500;
      if (!res.headersSent) send(res, status, { error: err instanceof Error ? err.message : String(err) });
      else res.end();
    }
  };

  return { handler, close };
}

export async function startWebServer(tracker: Tracker, opts: Options): Promise<void> {
  const addresses = ["127.0.0.1"];
  const hostnames: string[] = [];
  let tailnet: Awaited<ReturnType<typeof tailscaleInfo>> | undefined;
  if (opts.tailscale) {
    tailnet = await tailscaleInfo();
    addresses.push(tailnet.ip);
    for (const h of [tailnet.ip, tailnet.dnsName, tailnet.shortName]) if (h) hostnames.push(h);
  }
  const app = createWebApp(tracker, { port: opts.port, hostnames, tailnet: tailnet?.dnsName, cwd: process.cwd() });
  await Promise.all(
    addresses.map(
      (host) =>
        new Promise<void>((resolve, reject) => {
          const server = http.createServer((req, res) => void app.handler(req, res));
          server.on("error", reject);
          server.listen(opts.port, host, () => resolve());
        }),
    ),
  );
  const local = `http://127.0.0.1:${opts.port}`;
  console.log(`genie web: ${local}  (tracker ${tracker.dir})`);
  if (tailnet) console.log(`genie web on the tailnet: http://${tailnet.dnsName || tailnet.ip}:${opts.port}  (http://${tailnet.ip}:${opts.port})`);
  if (opts.open) spawn("xdg-open", [local], { stdio: "ignore", detached: true }).unref();
}

