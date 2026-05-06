import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// Sampling = the MCP server asks the connected host (Claude Desktop, Claude Code, …)
// to perform an LLM inference on its behalf. Lets aicw-video describe screenshots,
// proofread captions, and propose plans without needing its own API key.

export class HostSamplingUnavailable extends Error {
  readonly prompt: string;
  readonly images: ImageInput[];
  constructor(message: string, prompt: string, images: ImageInput[]) {
    super(message);
    this.name = "HostSamplingUnavailable";
    this.prompt = prompt;
    this.images = images;
  }
}

export type ImageInput = { data: string; mimeType: string };

export interface SampleArgs {
  prompt: string;
  images?: ImageInput[];
  systemPrompt?: string;
  maxTokens?: number;
}

export async function sample(server: McpServer, args: SampleArgs): Promise<string> {
  const content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  > = [{ type: "text", text: args.prompt }];
  for (const img of args.images ?? []) {
    content.push({ type: "image", data: img.data, mimeType: img.mimeType });
  }
  try {
    const result = await server.server.createMessage({
      messages: [{ role: "user", content: content as never }],
      systemPrompt: args.systemPrompt,
      maxTokens: args.maxTokens ?? 1024,
    });
    // result.content is a single block (text or image); we only consume text.
    if (result.content && (result.content as { type?: string }).type === "text") {
      return (result.content as { text: string }).text ?? "";
    }
    throw new HostSamplingUnavailable(
      "host returned a non-text response",
      args.prompt,
      args.images ?? [],
    );
  } catch (e) {
    if (e instanceof HostSamplingUnavailable) throw e;
    // Most likely cause: the host hasn't advertised the sampling capability.
    const msg = e instanceof Error ? e.message : String(e);
    throw new HostSamplingUnavailable(
      `host doesn't support sampling (${msg})`,
      args.prompt,
      args.images ?? [],
    );
  }
}

// Sample and parse the model's response as JSON. Strips ```json fences and tries
// to be lenient about leading/trailing prose.
export async function sampleJson<T>(
  server: McpServer,
  args: SampleArgs & { hint?: string },
): Promise<{ raw: string; parsed: T }> {
  const raw = await sample(server, {
    ...args,
    prompt: args.prompt + "\n\nReply with JSON only. No prose, no markdown fences.",
  });
  const cleaned = stripJsonFences(raw);
  let parsed: T;
  try {
    parsed = JSON.parse(cleaned) as T;
  } catch {
    // Fallback: extract first {...} block
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (!m) throw new Error(`host response was not JSON:\n${raw.slice(0, 400)}`);
    parsed = JSON.parse(m[0]) as T;
  }
  return { raw, parsed };
}

function stripJsonFences(s: string): string {
  return s
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
}

// Build the "sampling unavailable → fall back to chat" tool result: send the
// prompt + images as content blocks the host LLM can read in chat, with explicit
// instructions on which save_* tool to invoke afterward.
export function fallbackContent(err: HostSamplingUnavailable, instruction: string): {
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
} {
  const content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  > = [
    {
      type: "text",
      text:
        `Sampling not available — please answer the request below in chat, ` +
        `then call the indicated save_* tool with the resulting JSON.\n\n` +
        `${instruction}\n\n${err.prompt}`,
    },
  ];
  for (const img of err.images) {
    content.push({ type: "image", data: img.data, mimeType: img.mimeType });
  }
  return { content };
}
