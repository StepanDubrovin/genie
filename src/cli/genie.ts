// genie — local task tracker CLI shared by humans and agents.

import * as fs from "node:fs";
import * as os from "node:os";
import { parseArgs } from "node:util";
import { type Actor, isMemberRole, ARTIFACT_KINDS, type ArtifactKind, COMMENT_KINDS, type CommentKind, isRole, isStatus, STATUSES, type Status, TASK_TYPES, type TaskType } from "../tracker/model.ts";
import { loadConfig } from "../team/config.ts";
import { oneLine, renderTask, statusIcon } from "../tracker/render.ts";
import { GenieError, Tracker } from "../tracker/store.ts";
import { defaultGenieDir } from "../tracker/fsutil.ts";
import { TeamBus } from "../team/bus.ts";
import { memberLabel } from "../team/names.ts";
import { addMembers, deleteTeam, removeMember, stopTeam } from "../team/ops.ts";
import { startWebServer } from "../web/server.ts";

const HELP = `genie — local task tracker for pi orchestrator + focus teams

Tasks
  genie init [--prefix G]                   create .genie/ in the main worktree (or cwd outside git)
  genie new <title> [-d text] [-a criterion]... [--type task|bug|spike|epic]
                    [-p 0-4] [--parent ID] [--dep ID]... [--label L]...
                                            (as the owner the task lands in the inbox; --draft to skip it)
  genie ls [--all] [--status s1,s2] [--team T] [--parent ID] [--label L]
  genie ready                               ready queue: ready, unblocked, deps done, no team
  genie show <ID> [--history]
  genie edit <ID> [--title t] [-d text] [--plan text] [--notes text] [-p N]
                  [-a criterion]... [--rm-ac N]... [--dep ID]... [--rm-dep ID]... [--label L]...
  genie status <ID> <status> [-m note] [--force]
                                            statuses: ${STATUSES.join(", ")}
  genie accept <ID> [-m summary]            shortcut for: status <ID> done
  genie comment <ID> <text> [--kind ${COMMENT_KINDS.join("|")}]
  genie check <ID> <N> [--undo]             tick acceptance criterion N
  genie artifact <ID> (--file PATH | --stdin) [--kind ${ARTIFACT_KINDS.join("|")}] [--name N] [--note text]
  genie artifact-show <ID> <N> [--out FILE] print (or save) artifact N of a task
  genie split <ID> <child title>...         slice a task into atomic children (parent becomes an epic)
  genie block <ID> <reason> | genie unblock <ID>
  genie board                               tasks grouped by status + active teams

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
  genie send <TEAM> <to|all> <text> [--urgent]
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
      prefix: { type: "string" },
      title: { type: "string" },
      description: { type: "string", short: "d" },
      acceptance: { type: "string", short: "a", multiple: true },
      "rm-ac": { type: "string", multiple: true },
      type: { type: "string" },
      priority: { type: "string", short: "p" },
      parent: { type: "string" },
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
  tracker.gates = loadConfig(tracker.dir).gates ?? {};
  const bus = new TeamBus(tracker);
  if (cmd === "web") {
    await startWebServer(tracker, { port: values.port ? Number(values.port) : loadConfig(tracker.dir).web.port, tailscale: !!values.tailscale, open: !!values.open });
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
        parent: values.parent,
        deps: asList(values.dep),
        labels: asList(values.label),
        status: me.role === "human" && !values.draft ? "inbox" : "draft",
      });
      out(json, task, () => `created ${task.id}: ${task.title} (${task.status})`);
      return;
    }
    case "ls":
    case "list": {
      const status = asList(values.status);
      for (const s of status) if (!isStatus(s)) throw new GenieError(`unknown status ${s}`);
      const tasks = tracker.list({ status: status as Status[], team: values.team, parent: values.parent, label: values.label?.[0], includeClosed: values.all });
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
      out(json, task, () => renderTask(task, { history: values.history }));
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
    case "board": {
      const tasks = tracker.list({ includeClosed: values.all });
      const teams = bus.list();
      out(json, { tasks, teams }, () => {
        const lines: string[] = [];
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
      need(3, "send <TEAM> <to|all> <text>");
      const sent = bus.send({ team: args[0], from: me.name, fromRole: me.role, to: args[1], text: args.slice(2).join(" "), urgent: values.urgent });
      out(json, sent, () => `sent to ${sent.map((m) => m.to).join(", ")}`);
      return;
    }
    case "mail": {
      need(1, "mail <TEAM>");
      const mails = bus.history(args[0], Number(values.n ?? 30));
      out(json, mails, () => mails.map((m) => `${m.at.slice(11, 19)} ${m.from} → ${m.to}${m.urgent ? " (urgent)" : ""}: ${m.text}`).join("\n\n") || "no mail");
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
