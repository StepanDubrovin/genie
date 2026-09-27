// genie — local task tracker CLI shared by humans and agents.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { type Actor, isMemberRole, ARTIFACT_KINDS, type ArtifactKind, COMMENT_KINDS, type CommentKind, isRole, isStatus, STATUSES, type Status, type Task, TASK_TYPES, type TaskType } from "../tracker/model.ts";
import { loadConfig } from "../team/config.ts";
import { oneLine, renderTask, statusIcon } from "../tracker/render.ts";
import { GenieError, Tracker } from "../tracker/store.ts";
import { defaultGenieDir } from "../tracker/fsutil.ts";
import { MAIL_INTENTS, MAIL_LEVELS, TeamBus, type MailIntent, type MailLevel } from "../team/bus.ts";
import { memberLabel } from "../team/names.ts";
import { addMembers, deleteTeam, removeMember, stopTeam } from "../team/ops.ts";
import { startWebServer } from "../web/server.ts";
import { DocsService, DOC_STATUSES, DOC_TYPES, toDocRelative, type DocPage, type DocReadResult, type DocSearchResult, type DocStatus, type DocType } from "../docs/index.ts";
import { computeDocsImpact, IMPACT_STATUSES, renderDocsImpact, type DocsImpactInput } from "../docs/impact.ts";

const HELP = `genie — local task tracker for pi orchestrator + focus teams

Tasks
  genie init [--prefix G]                   create .genie/ in the main worktree (or cwd outside git)
  genie new <title> [-d text] [-a criterion]... [--type task|bug|spike|epic]
                    [-p 0-4] [--epic ID] [--parent ID] [--dep ID]... [--label L]...
                                            (as the owner the task lands in the inbox; --draft to skip it)
  genie epic <title> [-d goal] [-a success criterion]... [--plan roadmap]
                                            create an epic: a milestone with a goal, tasks and shared artifacts
  genie epics [--all]                       epics with progress
  genie ls [--all] [--status s1,s2] [--team T] [--epic ID] [--label L] [--no-epics]
  genie ready                               ready queue: ready, unblocked, deps done, no team
  genie show <ID> [--history]
  genie edit <ID> [--title t] [-d text] [--plan text] [--notes text] [-p N]
                  [-a criterion]... [--rm-ac N]... [--dep ID]... [--rm-dep ID]... [--label L]...
                  [--epic ID | --no-epic]      move the task into an epic or out of it
  genie status <ID> <status> [-m note] [--force]
                                            statuses: ${STATUSES.join(", ")}
  genie accept <ID> [-m summary]            shortcut for: status <ID> done
  genie comment <ID> <text> [--kind ${COMMENT_KINDS.join("|")}]
  genie check <ID> <N> [--undo]             tick acceptance criterion N
  genie artifact <ID> (--file PATH | --stdin) [--kind ${ARTIFACT_KINDS.join("|")}] [--name N] [--note text]
  genie artifact-show <ID> <N> [--out FILE] print (or save) artifact N of a task
  genie split <ID> <child title>...         slice a task into atomic children (parent becomes an epic)
  genie block <ID> <reason> | genie unblock <ID>
  genie board                               epics, tasks grouped by status, active teams

Docs
  genie docs tree [--json]                  indexed pages with draft/stale/diagnostic markers
  genie docs search <query> [--type T] [--status S] [--limit N] [--json]
                                            full-text search over the caller's project docs;
                                            deprecated pages are excluded unless --status asks for them
  genie docs read <path> (--heading H | --whole) [--max-chars N] [--json]
                                            read a page or one of its heading sections
  genie docs note <title> [-d body] [--tag T]... [--related ID]... [--json]
                                            capture a draft note under <docs root>/inbox
  genie docs rebuild [--json]               drop and recreate the docs index cache
  genie docs impact <ID> [--json]           non-blocking candidates for pages the task's changes
                                            may have made stale (review/done)

Web
  genie web [--port 7420] [--tailscale] [--open]
                                            Linear-style UI; --tailscale also serves it on this machine's tailnet address

Teams
  genie teams [--all]                       list teams
  genie team <TEAM>                         roster, statuses, recent events
  genie team <TEAM> stop [--rm-worktree]    stop all members (the task is released if still open)
  genie team <TEAM> delete [--rm-worktree]  stop and delete the team with its chat history
  genie team <TEAM> add <role> [name] [--model provider/id] [-m instructions]
  genie team <TEAM> remove <member>         stop a member and drop it from the team
  genie send <TEAM> <to|all> <text> [--urgent] [--level low|normal|high] [--intent question|blocker|verdict|done|fyi]
  genie mail <TEAM> [-n 30]                 message history

Common flags: --json (machine output), -h/--help.
Identity comes from GENIE_ROLE / GENIE_MEMBER (set for team members); otherwise you act as "human".`;

function actor(): Actor {
  const role = process.env.GENIE_ROLE ?? "human";
  if (!isRole(role)) throw new GenieError(`invalid GENIE_ROLE ${role}`);
  return { name: process.env.GENIE_MEMBER ?? (role === "human" ? os.userInfo().username : role), role };
}

function out(json: boolean, data: unknown, text: () => string): void {
  process.stdout.write(json ? `${JSON.stringify(data, null, 2)}\n` : `${text()}\n`);
}

/** Draft/stale/diagnostic markers shared by `docs tree`, search and read. */
function docMarkerList(page: DocPage): string[] {
  const markers: string[] = [];
  if (page.status === "draft" || page.status === "deprecated") markers.push(page.status);
  if (page.stale) markers.push("stale");
  if (page.diagnostics.length) markers.push(`diagnostics:${page.diagnostics.length}`);
  return markers;
}

function docLine(page: DocPage): string {
  const markers = docMarkerList(page);
  const suffix = markers.length ? ` [${markers.join(", ")}]` : "";
  return `${page.path}  ${page.title} (${page.type ?? "untyped"}, ${page.status ?? "status unknown"})${suffix}`;
}

function renderDocRead(page: DocReadResult): string {
  const lines: string[] = [`# ${page.title}`, `- path: ${page.path}`];
  lines.push(`- type: ${page.type ?? "untyped"}, status: ${page.status ?? "status unknown"}`);
  const markers = docMarkerList(page);
  if (markers.length) lines.push(`- markers: ${markers.join(", ")}`);
  if (page.summary) lines.push(`- summary: ${page.summary}`);
  if (page.tags.length) lines.push(`- tags: ${page.tags.join(", ")}`);
  if (page.aliases.length) lines.push(`- aliases: ${page.aliases.join(", ")}`);
  if (page.related.length) lines.push(`- related: ${page.related.join(", ")}`);
  lines.push(`- verified: ${page.verified ?? "never"}, updated: ${page.updated ?? "unknown"}`);
  if (page.staleReasons.length) {
    lines.push(`- stale reasons (${page.staleReasons.length}):`);
    for (const reason of page.staleReasons) lines.push(`  - ${reason}`);
  }
  if (page.diagnostics.length) {
    lines.push(`- frontmatter diagnostics (${page.diagnostics.length}):`);
    for (const diagnostic of page.diagnostics) lines.push(`  - ${diagnostic}`);
  }
  if (page.heading) lines.push(`- heading: ${page.heading}`);
  if (page.links.length) {
    lines.push("- links:");
    for (const link of page.links) lines.push(`  - ${link.target} -> ${link.resolution}${link.targetPath ? ` (${link.targetPath})` : ""}`);
  }
  if (page.backlinks.length) lines.push(`- backlinks: ${page.backlinks.join(", ")}`);
  lines.push("", page.content);
  return lines.join("\n");
}

function slugifyTitle(title: string): string {
  const slug = title.normalize("NFKD").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/g, "");
  return slug || "note";
}

/** Write a unique draft note under <docs root>/inbox; never overwrites an existing file. */
function writeDocsNote(
  docs: DocsService,
  input: { title: string; body: string; tags: string[]; related: string[] },
): { path: string; title: string; type: string; status: string; tags: string[]; related: string[] } {
  const date = new Date().toISOString().slice(0, 10);
  const inbox = path.join(docs.docsRoot, "inbox");
  fs.mkdirSync(inbox, { recursive: true });
  const base = `${date}-${slugifyTitle(input.title)}`;
  let target = path.join(inbox, `${base}.md`);
  for (let counter = 2; fs.existsSync(target); counter++) target = path.join(inbox, `${base}-${counter}.md`);
  const quoted = (value: string) => JSON.stringify(value);
  const list = (items: string[]) => `[${items.map(quoted).join(", ")}]`;
  const frontmatter = ["---", `title: ${quoted(input.title)}`, "type: note", "status: draft"];
  if (input.tags.length) frontmatter.push(`tags: ${list(input.tags)}`);
  if (input.related.length) frontmatter.push(`related: ${list(input.related)}`);
  frontmatter.push("---");
  const body = input.body.trim();
  const content = `${frontmatter.join("\n")}\n\n${body ? `${body}\n` : ""}`;
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, target);
  docs.refresh();
  return { path: toDocRelative(docs.docsRoot, target), title: input.title, type: "note", status: "draft", tags: input.tags, related: input.related };
}

function asList(v: unknown): string[] {
  if (v === undefined) return [];
  return (Array.isArray(v) ? v : [v]).flatMap((x) => String(x).split(",")).map((s) => s.trim()).filter(Boolean);
}

async function main(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      help: { type: "boolean", short: "h" },
      json: { type: "boolean" },
      all: { type: "boolean" },
      history: { type: "boolean" },
      force: { type: "boolean" },
      undo: { type: "boolean" },
      stdin: { type: "boolean" },
      draft: { type: "boolean" },
      tailscale: { type: "boolean" },
      open: { type: "boolean" },
      port: { type: "string" },
      out: { type: "string" },
      model: { type: "string" },
      "rm-worktree": { type: "boolean" },
      urgent: { type: "boolean" },
      level: { type: "string" },
      intent: { type: "string" },
      prefix: { type: "string" },
      title: { type: "string" },
      description: { type: "string", short: "d" },
      acceptance: { type: "string", short: "a", multiple: true },
      "rm-ac": { type: "string", multiple: true },
      type: { type: "string" },
      priority: { type: "string", short: "p" },
      parent: { type: "string" },
      epic: { type: "string" },
      "no-epic": { type: "boolean" },
      "no-epics": { type: "boolean" },
      dep: { type: "string", multiple: true },
      "rm-dep": { type: "string", multiple: true },
      label: { type: "string", multiple: true },
      status: { type: "string" },
      team: { type: "string" },
      plan: { type: "string" },
      notes: { type: "string" },
      message: { type: "string", short: "m" },
      kind: { type: "string" },
      file: { type: "string" },
      name: { type: "string" },
      note: { type: "string" },
      n: { type: "string", short: "n" },
      heading: { type: "string" },
      whole: { type: "boolean" },
      "max-chars": { type: "string" },
      limit: { type: "string" },
      tag: { type: "string", multiple: true },
      related: { type: "string", multiple: true },
    },
  });
  const [cmd, ...args] = positionals;
  if (values.help || !cmd || cmd === "help") {
    console.log(HELP);
    return;
  }
  const json = !!values.json;
  const me = actor();

  if (cmd === "init") {
    const dir = defaultGenieDir(process.cwd());
    const tracker = Tracker.init(dir, { prefix: values.prefix });
    out(json, { dir: tracker.dir, meta: tracker.meta() }, () => `genie tracker ready at ${tracker.dir} (prefix ${tracker.meta().prefix})`);
    return;
  }

  const tracker = Tracker.open(process.cwd());
  const config = loadConfig(tracker.dir);
  tracker.gates = config.gates ?? {};
  const bus = new TeamBus(tracker);
  let docs: DocsService | undefined;
  const docsService = (): DocsService =>
    (docs ??= new DocsService({ db: tracker.db, cwd: process.cwd(), trackerDir: tracker.dir, docsRoot: config.docs?.root ?? "docs" }));
  /** Impact input: the task's worktree plus the team-record base commit (guarded). */
  const impactInput = (task: Task): DocsImpactInput => {
    let base: string | undefined;
    if (task.team) {
      try {
        base = bus.get(task.team)?.worktree?.base;
      } catch {
        // team record gone: degrade to a base-less (dirty-only) diff
      }
    }
    const worktree = task.worktree
      ? { path: task.worktree.path, ...(task.worktree.branch ? { branch: task.worktree.branch } : {}), ...(base ? { base } : {}) }
      : undefined;
    return { id: task.id, status: task.status, relatedIds: [task.id, ...(task.parent ? [task.parent] : [])], ...(worktree ? { worktree } : {}) };
  };
  if (cmd === "web") {
    await startWebServer(tracker, { port: values.port ? Number(values.port) : config.web.port, tailscale: !!values.tailscale, open: !!values.open });
    return;
  }
  const need = (n: number, usage: string) => {
    if (args.length < n) throw new GenieError(`usage: genie ${usage}`);
  };

  switch (cmd) {
    case "new":
    case "add": {
      need(1, "new <title>");
      const type = (values.type ?? "task") as TaskType;
      if (!TASK_TYPES.includes(type)) throw new GenieError(`type must be one of ${TASK_TYPES.join(", ")}`);
      const task = tracker.create(me, {
        title: args.join(" "),
        type,
        description: values.description,
        acceptance: values.acceptance,
        priority: values.priority !== undefined ? Number(values.priority) : undefined,
        parent: values.epic ?? values.parent,
        deps: asList(values.dep),
        labels: asList(values.label),
        status: me.role === "human" && !values.draft ? "inbox" : "draft",
      });
      out(json, task, () => `created ${task.id}: ${task.title} (${task.status})`);
      return;
    }
    case "epic": {
      need(1, "epic <title>");
      const epic = tracker.create(me, {
        title: args.join(" "),
        type: "epic",
        description: values.description,
        acceptance: values.acceptance,
        priority: values.priority !== undefined ? Number(values.priority) : undefined,
        labels: asList(values.label),
        status: me.role === "human" && !values.draft ? "inbox" : "draft",
      });
      if (values.plan) tracker.update(me, epic.id, { plan: values.plan });
      out(json, tracker.get(epic.id), () => `created epic ${epic.id}: ${epic.title} (${epic.status})`);
      return;
    }
    case "epics": {
      const epics = tracker.list({ type: ["epic"], includeClosed: values.all });
      out(json, epics, () => (epics.length ? epics.map(oneLine).join("\n") : "no epics"));
      return;
    }
    case "ls":
    case "list": {
      const status = asList(values.status);
      for (const s of status) if (!isStatus(s)) throw new GenieError(`unknown status ${s}`);
      const tasks = tracker.list({
        status: status as Status[],
        team: values.team,
        parent: values.epic ?? values.parent,
        label: values.label?.[0],
        includeClosed: values.all,
        excludeEpics: values["no-epics"],
      });
      out(json, tasks, () => (tasks.length ? tasks.map(oneLine).join("\n") : "no tasks"));
      return;
    }
    case "ready": {
      const tasks = tracker.readyQueue();
      out(json, tasks, () => (tasks.length ? tasks.map(oneLine).join("\n") : "ready queue is empty"));
      return;
    }
    case "show": {
      need(1, "show <ID>");
      const task = tracker.get(args[0]);
      // `out` only runs the text closure in text mode, so --json stays the raw task object.
      out(json, task, () => {
        const base = renderTask(task, { history: values.history, ...tracker.epicContext(task.id) });
        const impact = IMPACT_STATUSES.includes(task.status) ? `\n\n${renderDocsImpact(computeDocsImpact(docsService(), impactInput(task)))}` : "";
        return `${base}${impact}`;
      });
      return;
    }
    case "edit": {
      need(1, "edit <ID> [flags]");
      const type = values.type as TaskType | undefined;
      const task = tracker.update(me, args[0], {
        title: values.title,
        type,
        description: values.description,
        plan: values.plan,
        appendNotes: values.notes,
        priority: values.priority !== undefined ? Number(values.priority) : undefined,
        labels: values.label ? asList(values.label) : undefined,
        addAcceptance: values.acceptance,
        removeAcceptance: values["rm-ac"]?.map(Number),
        addDeps: asList(values.dep),
        removeDeps: asList(values["rm-dep"]),
        parent: values["no-epic"] ? null : values.epic,
      });
      out(json, task, () => `updated ${task.id}`);
      return;
    }
    case "status":
    case "move":
    case "accept": {
      const to = cmd === "accept" ? "done" : args[1];
      need(cmd === "accept" ? 1 : 2, cmd === "accept" ? "accept <ID>" : "status <ID> <status>");
      if (!isStatus(to)) throw new GenieError(`unknown status ${to}; one of ${STATUSES.join(", ")}`);
      const task = tracker.setStatus(me, args[0], to, { note: values.message, force: values.force });
      out(json, task, () => `${task.id} → ${task.status}`);
      return;
    }
    case "comment": {
      need(2, "comment <ID> <text>");
      const kind = (values.kind ?? "note") as CommentKind;
      const task = tracker.comment(me, args[0], args.slice(1).join(" "), kind);
      out(json, task.comments.at(-1), () => `commented on ${task.id}`);
      return;
    }
    case "check": {
      need(2, "check <ID> <N>");
      const task = tracker.check(me, args[0], Number(args[1]), !values.undo);
      out(json, task.acceptance, () => task.acceptance.map((a) => `[${a.done ? "x" : " "}] #${a.id} ${a.text}`).join("\n"));
      return;
    }
    case "artifact": {
      need(1, "artifact <ID> (--file PATH | --stdin)");
      const kind = (values.kind ?? "other") as ArtifactKind;
      const content = values.stdin ? fs.readFileSync(0, "utf8") : undefined;
      const task = tracker.addArtifact(me, args[0], { kind, file: values.file, content, name: values.name, note: values.note });
      const art = task.artifacts.at(-1)!;
      out(json, art, () => `attached artifact #${art.id} ${art.name} to ${task.id}`);
      return;
    }
    case "artifact-show": {
      need(2, "artifact-show <ID> <N>");
      const a = tracker.readArtifact(args[0], Number(args[1]));
      if (values.out) {
        fs.writeFileSync(values.out, a.content);
        out(json, { saved: values.out }, () => `saved ${a.name} to ${values.out}`);
      } else if (a.text !== undefined) {
        process.stdout.write(json ? `${JSON.stringify({ name: a.name, kind: a.kind, text: a.text })}\n` : a.text.endsWith("\n") ? a.text : `${a.text}\n`);
      } else {
        throw new GenieError(`artifact is binary (${a.content.byteLength} bytes); use --out FILE`);
      }
      return;
    }
    case "split": {
      need(2, "split <ID> <child title>...");
      const children = tracker.split(me, args[0], args.slice(1).map((title) => ({ title })));
      out(json, children, () => children.map((c) => `created ${c.id}: ${c.title}`).join("\n"));
      return;
    }
    case "block": {
      need(2, "block <ID> <reason>");
      const task = tracker.block(me, args[0], args.slice(1).join(" "));
      out(json, task, () => `${task.id} blocked`);
      return;
    }
    case "unblock": {
      need(1, "unblock <ID>");
      const task = tracker.unblock(me, args[0]);
      out(json, task, () => `${task.id} unblocked`);
      return;
    }
    case "docs": {
      const action = args[0];
      const rest = args.slice(1);
      const docs = docsService();
      if (action === "tree") {
        const pages = docs.list();
        out(json, pages, () => (pages.length ? pages.map(docLine).join("\n") : "no documentation pages"));
        return;
      }
      if (action === "search") {
        need(2, "docs search <query>");
        const type = values.type as DocType | undefined;
        if (type && !DOC_TYPES.includes(type)) throw new GenieError(`type must be one of ${DOC_TYPES.join(", ")}`);
        const status = values.status as DocStatus | undefined;
        if (status && !DOC_STATUSES.includes(status)) throw new GenieError(`status must be one of ${DOC_STATUSES.join(", ")}`);
        const limit = values.limit !== undefined ? Number(values.limit) : undefined;
        if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) throw new GenieError("--limit must be a positive integer");
        const query = rest.join(" ");
        const results = docs.search(query, { type, status, limit });
        out(json, results, () => (results.length
          ? results.map((result) => `${docLine(result)}\n    ${result.snippet.replace(/\s+/g, " ").trim()}`).join("\n\n")
          : `no documentation matches "${query}"`));
        return;
      }
      if (action === "read") {
        need(2, "docs read <path>");
        const heading = values.heading;
        const wholePage = !!values.whole;
        if (heading === undefined && !wholePage) throw new GenieError("docs read needs --heading <heading> or --whole");
        const maxChars = values["max-chars"] !== undefined ? Number(values["max-chars"]) : undefined;
        const page = docs.read(rest[0], { heading, wholePage, maxChars });
        out(json, page, () => renderDocRead(page));
        return;
      }
      if (action === "note") {
        need(2, "docs note <title>");
        const created = writeDocsNote(docs, {
          title: rest.join(" "),
          body: values.description ?? "",
          tags: asList(values.tag),
          related: asList(values.related),
        });
        out(json, created, () => `created ${created.path}`);
        return;
      }
      if (action === "rebuild") {
        const result = docs.rebuild();
        out(json, result, () => `rebuilt docs index: ${result.pages} pages (${result.changed} changed, ${result.deleted} deleted, ${result.diagnostics} diagnostics)`);
        return;
      }
      if (action === "impact") {
        need(2, "docs impact <ID>");
        const task = tracker.get(rest[0]);
        const result = computeDocsImpact(docs, impactInput(task));
        out(json, result, () => renderDocsImpact(result));
        return;
      }
      throw new GenieError("usage: genie docs tree|search|read|note|rebuild|impact");
    }
    case "board": {
      const tasks = tracker.list({ includeClosed: values.all, excludeEpics: true });
      const epics = tracker.list({ type: ["epic"], includeClosed: values.all });
      const teams = bus.list();
      out(json, { epics, tasks, teams }, () => {
        const lines: string[] = [];
        if (epics.length) {
          lines.push(`◆ EPICS (${epics.length})`);
          for (const e of epics) lines.push(`   ${oneLine(e)}`);
          lines.push("");
        }
        for (const s of STATUSES) {
          const group = tasks.filter((t) => t.status === s);
          if (!group.length) continue;
          lines.push(`${statusIcon(s)} ${s.toUpperCase()} (${group.length})`);
          for (const t of group) lines.push(`   ${oneLine(t)}`);
        }
        if (teams.length) {
          lines.push("", "TEAMS");
          for (const t of teams) lines.push(`   ${t.id} → ${t.task}: ${t.members.map((m) => `${m.name}[${m.status}]`).join(" · ")}`);
        }
        return lines.join("\n") || "board is empty";
      });
      return;
    }
    case "teams": {
      const teams = bus.list({ includeStopped: values.all });
      out(json, teams, () =>
        teams.length
          ? teams.map((t) => `${t.id} (${t.state}) task ${t.task}${t.worktree ? ` @ ${t.worktree.branch}` : ""}: ${t.members.map((m) => `${m.name}/${m.model ?? "default"}`).join(", ")}`).join("\n")
          : "no teams",
      );
      return;
    }
    case "team": {
      need(1, "team <TEAM> [stop|delete|add <role> [name]|remove <member>]");
      const action = args[1];
      if (action === "stop") {
        console.log((await stopTeam(tracker, bus, args[0], { reason: "owner", by: me.name, removeWorktree: values["rm-worktree"] })).join("\n"));
        return;
      }
      if (action === "delete") {
        console.log((await deleteTeam(tracker, bus, args[0], { by: me.name, removeWorktree: values["rm-worktree"] })).join("\n"));
        return;
      }
      if (action === "add") {
        need(3, "team <TEAM> add <role> [name] [--model provider/id]");
        if (!isMemberRole(args[2])) throw new GenieError(`unknown role ${args[2]}`);
        const added = await addMembers(tracker, bus, args[0], [{ role: args[2], name: args[3], model: values.model }], { by: me.name, note: values.message });
        out(json, added, () => `added ${added.map((a) => `${memberLabel(a.name, a.role)} [${a.name}]`).join(", ")} to team ${args[0]}`);
        return;
      }
      if (action === "remove") {
        need(3, "team <TEAM> remove <member>");
        await removeMember(tracker, bus, args[0], args[2], me.name);
        out(json, { removed: args[2] }, () => `removed ${args[2]} from team ${args[0]}`);
        return;
      }
      if (action) throw new GenieError(`unknown team action ${action}`);
      const team = bus.get(args[0]);
      const log = bus.readLog(team.id, 20);
      out(json, { team, log }, () =>
        [
          `team ${team.id} (${team.state}) for ${team.task}${team.template ? ` [${team.template}]` : ""}`,
          `cwd: ${team.cwd}${team.worktree ? ` (branch ${team.worktree.branch}, base ${team.worktree.base?.slice(0, 8)})` : ""}`,
          ...team.members.map((m) => `  ${m.name.padEnd(12)} ${m.role.padEnd(9)} ${String(m.model ?? "default").padEnd(32)} ${m.state.padEnd(8)} ${m.status}  ✉${bus.pending(team.id, m.name)}`),
          "",
          ...log.map((e) => `  ${String(e.at).slice(11, 19)} ${e.event} ${JSON.stringify({ ...e, at: undefined, event: undefined })}`),
        ].join("\n"),
      );
      return;
    }
    case "send": {
      need(3, "send <TEAM> <to|all> <text> [--level low|normal|high] [--intent question|blocker|verdict|done|fyi] [--urgent]");
      // An explicit --level wins; otherwise --urgent means high, otherwise normal (bus default).
      const level = values.level === undefined ? undefined : (values.level as MailLevel);
      if (level !== undefined && !MAIL_LEVELS.includes(level)) throw new GenieError(`invalid --level ${values.level}; expected ${MAIL_LEVELS.join("|")}`);
      const intent = values.intent === undefined ? undefined : (values.intent as MailIntent);
      if (intent !== undefined && !MAIL_INTENTS.includes(intent)) throw new GenieError(`invalid --intent ${values.intent}; expected ${MAIL_INTENTS.join("|")}`);
      const sent = bus.send({ team: args[0], from: me.name, fromRole: me.role, to: args[1], text: args.slice(2).join(" "), level, intent, urgent: values.urgent });
      out(json, sent, () => `sent to ${sent.map((m) => m.to).join(", ")}`);
      return;
    }
    case "mail": {
      need(1, "mail <TEAM>");
      const mails = bus.history(args[0], Number(values.n ?? 30));
      out(json, mails, () => mails.map((m) => `${m.at.slice(11, 19)} ${m.from} → ${m.to} [${m.level}${m.intent ? `/${m.intent}` : ""}]: ${m.text}`).join("\n\n") || "no mail");
      return;
    }
    default:
      throw new GenieError(`unknown command ${cmd}; see genie --help`);
  }
}

main(process.argv.slice(2)).catch((err) => {
  console.error(`genie: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
