import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { sampleJson as innerSampleJson } from "../host-llm.js";
import type { LLMProvider, SampleArgs } from "./types.js";

// Provider that routes through the MCP host's sampling/createMessage. Used
// when aicw-video runs as an MCP server. Behaviour is byte-identical to
// directly calling host-llm.ts::sampleJson — this class is just packaging
// so callers can be polymorphic between MCP and standalone modes.
export class McpSamplingProvider implements LLMProvider {
  readonly name = "mcp-sampling";
  constructor(private readonly server: McpServer) {}
  sampleJson<T>(args: SampleArgs): Promise<{ raw: string; parsed: T }> {
    return innerSampleJson<T>(this.server, args);
  }
}
