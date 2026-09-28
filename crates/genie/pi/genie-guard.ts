// genie-guard: keeps an agent within its role in the harness.
//
// genie serve loads this extension into every agent it runs (live sessions and
// one-shot turns) and points it at the agent's policy file (`GENIE_POLICY`),
// written from the role before the start and rewritten when the agent
// configuration changes — so a new rule applies to a running agent at its next
// tool call. On each tool call it blocks:
//
// - shell commands matching the role's `denyCommands` (glob patterns, matched
//   against every simple command of the line and inside quoted strings);
// - edit and write when the role or the job's workspace is read-only;
// - MCP calls through pi-mcp-adapter (the `mcp` proxy tool and the
//   `mcp__<server>` wrappers) to connections and tools the role was not
//   granted, and installing MCP servers.
//
// These are soft limits: an agent with a shell can work around them. The MCP
// config genie passes to pi-mcp-adapter (`--mcp-config`) already holds only the
// role's connections; the guard also covers an adapter started without it. The
// extension is written by genie serve into its data directory; edit
// crates/genie/pi/genie-guard.ts in the repository instead.

import { readFileSync, statSync } from "node:fs";

export interface Policy {
  role: string;
  /** `write`, `read` or `none`. */
  files: string;
  denyCommands: string[];
  /** Granted MCP connections: all their tools (`null`) or tool name patterns. */
  mcp: Record<string, string[] | null>;
}

const POLICY = process.env.GENIE_POLICY ?? "";
/** Commands that run another command, with their options that take a value (and leading operands). */
const WRAPPERS: Record<string, { valued: string[]; operands?: number }> = {
  sudo: { valued: ["-u", "-g", "-h", "-p", "-C", "-D", "-r", "-t", "-U", "-T"] },
  env: { valued: ["-u", "-C", "-S"] },
  nice: { valued: ["-n"] },
  timeout: { valued: ["-s", "-k"], operands: 1 },
  xargs: { valued: ["-I", "-n", "-P", "-d", "-L", "-s", "-E", "-a"] },
  time: { valued: ["-f", "-o"] },
  exec: { valued: ["-a"] },
  command: { valued: [] },
  builtin: { valued: [] },
  nohup: { valued: [] },
};

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_");

/** A glob (`*` any text, `?` one character) as an anchored regular expression. */
function glob(pattern: string): RegExp {
  const body = pattern
    .trim()
    .replace(/\s+/g, " ")
    .split("")
    .map((c) => (c === "*" ? ".*" : c === "?" ? "." : c.replace(/[.+^${}()|[\]\\]/g, "\\$&")))
    .join("");
  return new RegExp(`^${body}$`, "s");
}

/** The simple commands of a shell line, without leading assignments and wrappers (`sudo`, `env`…). */
export function simpleCommands(line: string): string[] {
  const out: string[] = [];
  for (const part of line.split(/\|\||&&|\$\(|[;&|\n()`{}]/)) {
    const words = part.trim().split(/\s+/).filter(Boolean);
    while (words.length) {
      const w = words[0];
      const wrapper = Object.hasOwn(WRAPPERS, w) ? WRAPPERS[w] : undefined;
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) words.shift();
      else if (wrapper) {
        words.shift();
        while (words.length && words[0].startsWith("-")) {
          const opt = words.shift() as string;
          if (wrapper.valued.includes(opt)) words.shift();
        }
        words.splice(0, wrapper.operands ?? 0);
      } else break;
    }
    if (words.length) {
      words[0] = words[0].replace(/^.*\//, ""); // /usr/bin/git → git
      out.push(words.join(" "));
    }
  }
  return out;
}

/** The denyCommands pattern a shell line hits, if any (quoted strings are checked too: `bash -c '…'`). */
export function deniedBy(line: string, patterns: string[], depth = 0): string | undefined {
  const rules = patterns.map((p) => [p, glob(p)] as const);
  for (const cmd of simpleCommands(line)) {
    const hit = rules.find(([, re]) => re.test(cmd));
    if (hit) return hit[0];
  }
  if (depth < 2) {
    for (const q of line.matchAll(/'([^']*)'|"((?:\\.|[^"\\])*)"/g)) {
      const hit = deniedBy(q[1] ?? q[2] ?? "", patterns, depth + 1);
      if (hit) return hit;
    }
  }
  return undefined;
}

/** Why an MCP call is outside the role's grants (undefined: allowed). */
export function mcpDenial(p: Policy, tool: string, input: Record<string, unknown>): string | undefined {
  const servers = Object.keys(p.mcp);
  const granted = (name: string) => servers.find((s) => norm(s) === norm(name));
  // pi-mcp-adapter names a server's tools `<server>_<tool>`.
  const owner = (name: string) => servers.find((s) => norm(name).startsWith(`${norm(s)}_`));
  const deny = (why: string) => `genie: ${why}. The role ${p.role} may use MCP connections: ${servers.join(", ") || "none"}`;
  let server: string | undefined;
  if (tool === "mcp") {
    if (input.action === "install") {
      return "genie: agents do not install MCP servers; ask a genie admin to add the server to mcp.json and grant it to the role";
    }
    for (const key of ["server", "connect", "instructions"]) {
      const v = input[key];
      if (typeof v === "string" && v && !granted(v)) return deny(`MCP connection ${v} is not granted`);
    }
    server = typeof input.server === "string" && input.server ? granted(input.server) : undefined;
  } else if (tool.startsWith("mcp__")) {
    const rest = tool.slice(5);
    server = granted(rest);
    // `mcp__<server>_<tool>` is a direct tool (`toolPrefix: "mcp"`): the adapter's config limits those.
    if (!server) return owner(rest) ? undefined : deny(`MCP connection ${rest} is not granted`);
  } else {
    return undefined;
  }
  const name = typeof input.tool === "string" ? input.tool : "";
  if (!name) return undefined;
  const s = server ?? owner(name);
  if (!s) return deny(`the MCP tool ${name} is not from a granted connection (name its server)`);
  const patterns = p.mcp[s];
  if (!patterns) return undefined;
  const base = norm(name).startsWith(`${norm(s)}_`) ? name.slice(s.length + 1) : name;
  if (patterns.some((pt) => glob(pt).test(name) || glob(pt).test(base))) return undefined;
  return `genie: the role ${p.role} may use only these tools of ${s}: ${patterns.join(", ")}`;
}

export default function genieGuard(pi: any) {
  if (!POLICY) return;

  let policy: Policy | undefined;
  let stamp = "";
  let reported = false;
  function current(): Policy | undefined {
    try {
      const st = statSync(POLICY);
      const s = `${st.mtimeMs}:${st.size}`;
      if (s !== stamp) {
        const raw = JSON.parse(readFileSync(POLICY, "utf8"));
        policy = {
          role: String(raw.role ?? "?"),
          files: String(raw.files ?? "write"),
          denyCommands: Array.isArray(raw.denyCommands) ? raw.denyCommands.map(String) : [],
          mcp: raw.mcp && typeof raw.mcp === "object" ? raw.mcp : {},
        };
        stamp = s;
        reported = false;
      }
    } catch (e) {
      // Keep the last rules read; without any, MCP stays closed (below).
      if (!reported) console.error(`[genie-guard] policy ${POLICY}: ${e instanceof Error ? e.message : String(e)}`);
      reported = true;
    }
    return policy;
  }
  current();

  pi.on("tool_call", (event: any) => {
    const tool = String(event?.toolName ?? "");
    const input = (event?.input ?? {}) as Record<string, unknown>;
    const p = current();
    if (!p) {
      return tool === "mcp" || tool.startsWith("mcp__") ? { block: true, reason: "genie: the agent's rules could not be read; MCP is closed" } : undefined;
    }
    if ((tool === "edit" || tool === "write") && p.files !== "write") {
      return { block: true, reason: `genie: the role ${p.role} works read-only here; ${tool} is not available` };
    }
    if ((tool === "bash" || tool === "powershell") && p.denyCommands.length) {
      const hit = deniedBy(String(input.command ?? ""), p.denyCommands);
      if (hit) return { block: true, reason: `genie: the role ${p.role} may not run \`${hit}\` (denyCommands)` };
    }
    const why = mcpDenial(p, tool, input);
    return why ? { block: true, reason: why } : undefined;
  });
}
