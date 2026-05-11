import type { LLMProvider } from "./llm/index.js";
import { defaultIllustrationPrompt, type IllustrationVideoMode } from "./illustration-video.js";

export type IllustrationSuggestionMoment = {
  index: number;
  ts_ms?: number;
  caption?: string;
  original_text?: string;
  has_video?: boolean;
};

export type IllustrationMomentSuggestion = {
  index: number;
  mode: Extract<IllustrationVideoMode, "side_by_side" | "animation_only">;
  prompt: string;
  duration_ms?: number;
  visual_type?: "graph" | "list";
};

export async function suggestIllustrationMoments(
  provider: LLMProvider,
  args: { moments: IllustrationSuggestionMoment[]; max?: number; clipTitle?: string },
): Promise<IllustrationMomentSuggestion[]> {
  const eligible = args.moments
    .filter((m) => Number.isFinite(m.index) && !m.has_video)
    .slice(0, 80);
  if (eligible.length === 0) return [];
  const max = Math.max(1, Math.min(8, Math.round(Number(args.max || 4))));
  const { parsed } = await provider.sampleJson<{
    selected?: Array<{ index?: number; mode?: string; prompt?: string; duration_ms?: number; visual_type?: string }>;
  }>({
    systemPrompt: "You select video moments that benefit from an extra generated illustration. Return JSON only.",
    maxTokens: 2400,
    prompt: buildSuggestionPrompt({ moments: eligible, max, clipTitle: args.clipTitle }),
  });
  const byIndex = new Map(eligible.map((m) => [m.index, m]));
  const seen = new Set<number>();
  const selected: IllustrationMomentSuggestion[] = [];
  for (const item of Array.isArray(parsed.selected) ? parsed.selected : []) {
    const index = Math.round(Number(item.index));
    const moment = byIndex.get(index);
    if (!moment || seen.has(index)) continue;
    seen.add(index);
    const mode = item.mode === "demo_only" || item.mode === "animation_only" ? "animation_only" : "side_by_side";
    const visualType = item.visual_type === "graph" ? "graph" : "list";
    const durationMs = normalizeDurationMs(item.duration_ms);
    const prompt = normalizePrompt(item.prompt) || defaultIllustrationPrompt({
      caption: moment.caption,
      originalText: moment.original_text,
      clipTitle: args.clipTitle,
      timestampMs: moment.ts_ms,
    });
    selected.push({ index, mode, prompt, visual_type: visualType, ...(durationMs ? { duration_ms: durationMs } : {}) });
    if (selected.length >= max) break;
  }
  return selected;
}

function buildSuggestionPrompt(args: { moments: IllustrationSuggestionMoment[]; max: number; clipTitle?: string }): string {
  const fullScript = args.moments
    .map((m) => `#${m.index} @ ${formatSeconds(m.ts_ms)}: ${compact(m.original_text || m.caption, 220)}`)
    .join("\n");
  return [
    `Choose up to ${Math.min(args.max, 4)} unique illustration spans for this clip.`,
    args.clipTitle ? `Clip title/context: ${args.clipTitle}` : "",
    ``,
    `Full clip captions:`,
    fullScript,
    ``,
    `Rules:`,
    `- Select only moments where an additional generated illustration would make the edited video clearer or more engaging.`,
    `- Think at the clip level first. Prefer a few logical spans over one asset for every caption moment.`,
    `- If the clip has multiple distinct ideas, return more than one span, up to the max.`,
    `- Do not start selected spans closer than about 5 seconds unless the source clip is shorter.`,
    `- Use the returned index as the start moment for the illustration span.`,
    `- Set duration_ms long enough to cover the connected idea, usually 5000-8000 ms, capped by the nearby caption context.`,
    `- Use only visual_type "graph" or "list" for now.`,
    `- Graph is for growth, metrics, usage, speed, progress, counts, rates, or explicit numbers. Use the actual numbers/units from captions when available.`,
    `- List is for key things, priorities, reasons, contrasts, definitions, or ordered ideas. Extract 2-4 meaningful labels from the whole clip; do not reuse random transcript words.`,
    `- Skip filler, greetings, short transitions, and moments that are already visually self-explanatory.`,
    `- Prefer mode "side_by_side". Use "animation_only" only when the animation can fully replace the camera/video while preserving the original audio and captions.`,
    `- The prompt must include: the full clip context, the selected span, "Visual type:", "Visual items:", and a short visual brief.`,
    `- Do not ask Hyperframes to paste the spoken sentence as a headline. Use graphics first, with only short readable labels.`,
    `- Good future types, but do not use them yet: flow/process diagram and comparison/before-after.`,
    ``,
    `Return JSON only in this exact shape:`,
    `{ "selected": [ { "index": 3, "mode": "side_by_side", "duration_ms": 5000, "visual_type": "list", "prompt": "..." } ] }`,
    ``,
    `Moment JSON for exact indexes:`,
    JSON.stringify(args.moments.map((m) => ({
      index: m.index,
      timestamp_ms: Math.round(Number(m.ts_ms || 0)),
      caption: compact(m.caption),
      spoken_context: compact(m.original_text),
    })), null, 2),
  ].filter(Boolean).join("\n");
}

function normalizePrompt(value: unknown): string {
  return String(value || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 4000);
}

function normalizeDurationMs(value: unknown): number | undefined {
  const ms = Math.round(Number(value || 0));
  if (!Number.isFinite(ms) || ms < 1000) return undefined;
  return Math.max(5000, Math.min(12000, ms));
}

function formatSeconds(value: unknown): string {
  const seconds = Math.max(0, Math.round(Number(value || 0)) / 1000);
  return `${seconds.toFixed(1)}s`;
}

function compact(value: unknown, max = 320): string {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}
