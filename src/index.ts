import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerAicwVideoTools } from "./tools/aicwVideoTools.js";

export async function startMcpServer(): Promise<void> {
  const server = new McpServer({
    name: "aicw-video",
    version: "1.0.0",
  });

  registerAicwVideoTools(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
