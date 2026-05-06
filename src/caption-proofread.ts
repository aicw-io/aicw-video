import { z } from "zod";
import { aiCliAvailable, getCliProvider, type LLMProvider } from "./llm/index.js";
import { config } from "./config.js";
import { cleanupTranscriptText } from "./transcript-text.js";

const ProofreadResponseSchema = z.object({
  captions: z.array(z.object({
    id: z.number().int().positive(),
    text: z.string(),
  })),
});

export async function proofreadCaptions(
  rawCaptions: string[],
  opts: { captionLanguage?: string; llmProvider?: LLMProvider; useAi?: boolean } = {},
): Promise<string[]> {
  const fallback = rawCaptions.map(cleanupTranscriptText);
  if (opts.useAi === false) return fallback;
  if (process.env.AICW_VIDEO_PROOFREAD_CAPTIONS === "0") return fallback;
  const provider = opts.llmProvider ?? (aiCliAvailable() ? getCliProvider() : null);
  if (!provider) return fallback;
  if (rawCaptions.every((s) => s.trim().length === 0)) return fallback;
  const captionLanguage = (opts.captionLanguage ?? config.caption_language).trim() || "English";

  const items = rawCaptions.map((text, i) => ({
    id: i + 1,
    text: cleanupTranscriptText(text),
  }));

  try {
    const { parsed } = await provider.sampleJson<unknown>({
      prompt: buildProofreadPrompt(items, captionLanguage),
      systemPrompt:
        `You proofread and translate transcript captions into ${captionLanguage}. Preserve meaning, order, and segment boundaries. Return JSON only.`,
      maxTokens: Math.max(800, Math.min(4000, rawCaptions.join("\n").length + 800)),
    });
    const validated = ProofreadResponseSchema.parse(parsed);
    const byId = new Map(validated.captions.map((c) => [c.id, cleanupTranscriptText(c.text)]));
    return items.map((item, i) => byId.get(item.id) || fallback[i] || "");
  } catch {
    return fallback;
  }
}

function buildProofreadPrompt(items: Array<{ id: number; text: string }>, captionLanguage: string): string {
  return [
    "Proofread these transcript caption segments.",
    `Target caption language: ${captionLanguage}.`,
    "",
    "Rules:",
    "- Keep exactly the same ids and number of captions.",
    "- Return every caption in the target caption language. Translate from the source language when needed.",
    "- Do not summarize or add new information.",
    "- Preserve meaning, order, names, technical terms, and spoken wording as closely as the target language allows.",
    "- Fix obvious transcription formatting artifacts: spaces before punctuation, split words like \"V ibe C oding\", capitalization, and punctuation.",
    "- If a caption is empty or unintelligible, return the best cleaned version without inventing content.",
    "",
    "Return JSON in this exact shape:",
    "{ \"captions\": [ { \"id\": 1, \"text\": \"...\" } ] }",
    "",
    JSON.stringify({ captions: items }, null, 2),
  ].join("\n");
}
