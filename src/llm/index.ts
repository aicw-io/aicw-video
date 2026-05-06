import { execSync } from "node:child_process";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpSamplingProvider } from "./mcp-sampling.js";
import { aiCliAvailable, getCliProvider } from "./cli-tools.js";
import type { LLMProvider } from "./types.js";

export type { LLMProvider, SampleArgs, ImageInput, HostSamplingUnavailable } from "./types.js";
export {
  aiCliAvailable,
  configuredAiCliToolLabels,
  firstAvailableAiCliToolLabel,
  getCliProvider,
  preflightAiCliTools,
  type AiCliPreflightResult,
} from "./cli-tools.js";

// Strict mode separation: if we have an MCP server, ALWAYS use MCP sampling.
// We never spawn `claude` from inside an MCP-spawned process — that would
// recursively launch Claude Code from inside Claude Code, with confusing
// auth and stdio implications. The MCP-mode caller is responsible for
// catching HostSamplingUnavailable and emitting the chat-fallback content.
//
// In CLI mode (no server), use the ordered ai_cli_tools fallback chain from
// config.json. We hard-fail only when none of the configured binaries exist.
export function getProvider(server?: McpServer): LLMProvider {
  if (server) return new McpSamplingProvider(server);
  if (!aiCliAvailable()) {
    throw new Error(
      "Standalone AI steps require one configured AI CLI tool from config.json (`ai_cli_tools`) on PATH.\n" +
        "Supported defaults: Claude Code (`claude`), Codex (`codex`), or Ollama (`ollama`).\n" +
        "Or run `aicw-video mcp` and let your AI host drive instead.",
    );
  }
  return getCliProvider();
}

export function claudeCliAvailable(): boolean {
  const which = process.env.AICW_VIDEO_CLAUDE_PATH;
  if (which) {
    try { execSync(`test -x "${which}"`, { stdio: "ignore" }); return true; }
    catch { return false; }
  }
  try {
    execSync("command -v claude", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
