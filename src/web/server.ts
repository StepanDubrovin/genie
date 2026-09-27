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
import { ORCHESTRATOR, TeamBus } from "../team/bus.ts";
import { loadConfig, type MemberSpec, PACKAGE_ROOT } from "../team/config.ts";
import { addMembers, deleteTeam, reapClosedTeams, removeMember, stopTeam } from "../team/ops.ts";
import { type Actor, isMemberRole, MEMBER_ROLES, STATUSES, type Status, TASK_TYPES, isStatus } from "../tracker/model.ts";
import { GenieError, type Tracker } from "../tracker/store.ts";

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

export async function startWebServer(tracker: Tracker, opts: Options): Promise<void> {
  const bus = new TeamBus(tracker);
  const localUser = os.userInfo().username;
  const allowedHosts = new Set([`127.0.0.1:${opts.port}`, `localhost:${opts.port}`]);
  const addresses = ["127.0.0.1"];
  let tailnet: Awaited<ReturnType<typeof tailscaleInfo>> | undefined;
  if (opts.tailscale) {
    tailnet = await tailscaleInfo();
    addresses.push(tailnet.ip);
    for (const h of [tailnet.ip, tailnet.dnsName, tailnet.shortName]) if (h) allowedHosts.add(`${h}:${opts.port}`);
  }

  // Server-sent events: one data_version poll for all clients.
  const clients = new Set<http.ServerResponse>();
  let version = tracker.db.dataVersion();
  const broadcast = () => {
    for (const c of clients) c.write(`event: change\ndata: ${Date.now()}\n\n`);
  };
  setInterval(() => {
    const v = tracker.db.dataVersion();
    if (v !== version) {
      version = v;
      broadcast();
    }
  }, 700).unref();
  setInterval(() => {
    for (const c of clients) c.write(": ping\n\n");
  }, 20_000).unref();

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
  setInterval(reap, 20_000).unref();
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
      return send(res, 200, { ...tracker.meta(), counts: tracker.counts(), statuses: STATUSES, roles: MEMBER_ROLES, roleModels: cfg.roleModels ?? {}, types: TASK_TYPES, user: actor.name, tailnet: tailnet?.dnsName });
    }

    if (parts[0] === "tasks") {
      const id = parts[1];
      if (!id && method === "GET") {
        const status = (url.searchParams.get("status") ?? "").split(",").filter(isStatus) as Status[];
        return send(res, 200, tracker.list({ status: status.length ? status : undefined, includeClosed: url.searchParams.get("closed") === "1", search: url.searchParams.get("q") ?? undefined, parent: url.searchParams.get("parent") ?? undefined }));
      }
      if (!id && method === "POST") {
        const task = tracker.create(me!, {
          title: String(body.title ?? ""),
          description: body.description ? String(body.description) : undefined,
          acceptance: Array.isArray(body.acceptance) ? body.acceptance.map(String).filter(Boolean) : undefined,
          priority: body.priority !== undefined ? Number(body.priority) : undefined,
          labels: Array.isArray(body.labels) ? body.labels.map(String).filter(Boolean) : undefined,
          type: TASK_TYPES.includes(body.type as never) ? (body.type as never) : undefined,
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
      if (id && parts[2] === "artifacts" && parts[3] && method === "GET") {
        const a = tracker.readArtifact(id, Number(parts[3]));
        if (url.searchParams.get("download") === "1") {
          res.setHeader("content-disposition", `attachment; filename="${a.name.replace(/"/g, "")}"`);
          return send(res, 200, a.content, "application/octet-stream");
        }
        return send(res, 200, { name: a.name, kind: a.kind, size: a.content.byteLength, text: a.text });
      }
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

  await Promise.all(
    addresses.map(
      (host) =>
        new Promise<void>((resolve, reject) => {
          const server = http.createServer((req, res) => void handler(req, res));
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

