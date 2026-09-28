// A stand-in for pi-mcp-adapter's `mcp` proxy tool in genie's tests: it reports
// the call it got, so a test sees which MCP calls got past the genie guard.
export default function fakeMcp(pi: any) {
  pi.registerTool({
    name: "mcp",
    label: "MCP",
    description: "MCP gateway (test stand-in)",
    parameters: {
      type: "object",
      properties: {
        tool: { type: "string" },
        server: { type: "string" },
        action: { type: "string" },
        url: { type: "string" },
        args: { type: "object" },
      },
    },
    async execute(_id: string, params: unknown) {
      return { content: [{ type: "text", text: `FAKE-MCP ${JSON.stringify(params)}` }], details: {} };
    },
  });
}
