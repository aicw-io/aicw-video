// Shared types for the two LLM providers (mcp-sampling, claude-cli).
// Re-exports ImageInput / HostSamplingUnavailable from host-llm.ts so callers
// only import from one place.

export type { ImageInput, HostSamplingUnavailable } from "../host-llm.js";

export type SampleArgs = {
  prompt: string;
  images?: import("../host-llm.js").ImageInput[];
  systemPrompt?: string;
  maxTokens?: number;
  timeoutMs?: number;
};

export interface LLMProvider {
  // Identifier for diagnostics. "mcp-sampling" | "claude-cli".
  readonly name: string;
  // Sample and parse the response as JSON. Strips ```json fences,
  // extracts the first {...} block on prose-y replies, throws with a
  // diagnostic message on malformed responses.
  sampleJson<T>(args: SampleArgs): Promise<{ raw: string; parsed: T }>;
}
