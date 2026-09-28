// A small MCP server over stdio for genie's gateway tests. Its tools report
// what the server got (the arguments, its environment and directory); one asks
// its client for a completion, which the gateway refuses. With `--fail` it
// stops at once and says why on stderr.
import { createInterface } from "node:readline";

if (process.argv.includes("--fail")) {
  console.error("cannot log in: TRACKER_TOKEN is not set");
  process.exit(3);
}

const tools = ["get_issue", "list_issues", "delete_issue", "whoami", "ask_client", "fail"].map((name) => ({
  name,
  description: `The ${name.replace("_", " ")} tool`,
  inputSchema: { type: "object" },
}));

const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
let asked; // a tools/call waiting for the client's answer
let next = 1000;

createInterface({ input: process.stdin }).on("line", (line) => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  if (m.method === undefined) {
    if (asked && m.id === asked.request) {
      send({ jsonrpc: "2.0", id: asked.id, result: { content: [{ type: "text", text: `the client said: ${m.error ? m.error.message : "yes"}` }] } });
      asked = undefined;
    }
    return;
  }
  if (m.id === undefined) return;
  const reply = (result) => send({ jsonrpc: "2.0", id: m.id, result });
  switch (m.method) {
    case "initialize":
      return reply({
        protocolVersion: m.params.protocolVersion,
        capabilities: { tools: { listChanged: true }, resources: { subscribe: true }, logging: {} },
        serverInfo: { name: "fake-tracker", version: "1.0.0" },
        instructions: "Read issues with get_issue.",
      });
    case "tools/list":
      return reply({ tools });
    case "resources/list":
      return reply({ resources: [{ uri: "tracker://readme", name: "readme" }] });
    case "tools/call": {
      const { name, arguments: args = {} } = m.params;
      if (name === "whoami") {
        const me = { token: process.env.TRACKER_TOKEN ?? null, cwd: process.cwd(), pid: process.pid };
        return reply({ content: [{ type: "text", text: JSON.stringify(me) }] });
      }
      if (name === "ask_client") {
        asked = { id: m.id, request: next++ };
        return send({ jsonrpc: "2.0", id: asked.request, method: "sampling/createMessage", params: { messages: [], maxTokens: 1 } });
      }
      if (name === "fail") return reply({ content: [{ type: "text", text: "the tracker is down" }], isError: true });
      return reply({ content: [{ type: "text", text: `${name} ${JSON.stringify(args)}` }] });
    }
    default:
      return send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `no ${m.method}` } });
  }
});
