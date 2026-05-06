import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { resolveProject } from "./projectFolder.js";
import { analyzeVideo, pickEvenMoments, type Moment } from "./analyze.js";
import { PlanSchema } from "./shorts.js";
import { config } from "./config.js";
import type { LLMProvider, ImageInput } from "./llm/index.js";

// Mode-agnostic AI tasks. The same functions back the MCP `*_with_host`
// tools (provider = MCP sampling) and the CLI subcommands `describe`,
// `plan-clips` (provider = claude-cli). The MCP-side caller is responsible
// for catching `HostSamplingUnavailable` and emitting chat-fallback content
// — these functions just propagate the exception.

export const DescriptionResponseSchema = z.object({
  summary: z.string(),
  key_moments: z.array(
    z.object({
      timestamp_ms: z.number().int().nonnegative(),
      description: z.string(),
    }),
  ),
});

export type DescribeResult = {
  outPath: string;
  summary: string;
  keyMomentCount: number;
};

export async function describeKeyframes(
  provider: LLMProvider,
  projectPath: string,
  frameCount = 6,
): Promise<DescribeResult> {
  const root = await resolveProject(projectPath);
  const { analysis } = await analyzeVideo(projectPath);
  const picked = pickEvenMoments(analysis.moments, frameCount);
  const { images, refs } = await loadKeyframes(root, picked);
  if (images.length === 0) throw new Error(`no keyframes available in ${root}/analysis/keyframes`);

  const prompt = buildDescribePrompt(refs.map((r) => r.ts_ms));
  const { parsed } = await provider.sampleJson<z.infer<typeof DescriptionResponseSchema>>({
    prompt,
    images,
    maxTokens: 1500,
  });
  const validated = DescriptionResponseSchema.parse(parsed);
  const data = {
    version: 1,
    summary: validated.summary,
    key_moments: validated.key_moments,
    created_at: new Date().toISOString(),
  };
  const out = path.join(root, "description.json");
  await writeFile(out, JSON.stringify(data, null, 2), "utf-8");
  return { outPath: out, summary: validated.summary, keyMomentCount: validated.key_moments.length };
}

export type ProposePlanArgs = {
  count?: number;
  target_duration_sec?: number;
  hint?: string;
};

export type ProposePlanResult = {
  outPath: string;
  clipCount: number;
  summary: string;
};

export async function proposeShortsPlan(
  provider: LLMProvider,
  projectPath: string,
  opts: ProposePlanArgs = {},
): Promise<ProposePlanResult> {
  const root = await resolveProject(projectPath);
  const transcriptPath = path.join(root, "transcript.json");
  const descriptionPath = path.join(root, "description.json");
  const transcript = existsSync(transcriptPath) ? await readFile(transcriptPath, "utf-8") : "";
  const description = existsSync(descriptionPath) ? await readFile(descriptionPath, "utf-8") : "";
  if (!transcript && !description) {
    throw new Error(
      `neither transcript.json nor description.json exists in ${root} — run transcribe and/or describe first`,
    );
  }

  const prompt = buildPlanPrompt({
    count: opts.count ?? 3,
    target_duration_sec: opts.target_duration_sec ?? 25,
    transcript: transcript.slice(0, 12000),
    description: description.slice(0, 4000),
    hint: opts.hint ?? "",
    captionLanguage: config.caption_language,
  });
  const { parsed } = await provider.sampleJson<unknown>({
    prompt,
    maxTokens: 2200,
  });
  const validated = PlanSchema.parse(parsed);
  const dir = path.join(root, "shorts");
  await mkdir(dir, { recursive: true });
  const out = path.join(dir, "plan.json");
  await writeFile(out, JSON.stringify(validated, null, 2), "utf-8");
  const summary = validated.clips
    .map((c) => `  ${c.id}  ${(c.start_ms / 1000).toFixed(0)}s–${(c.end_ms / 1000).toFixed(0)}s  ${c.title}`)
    .join("\n");
  return { outPath: out, clipCount: validated.clips.length, summary };
}

// ─── helpers ──────────────────────────────────────────────────────────

async function loadKeyframes(
  root: string,
  moments: Moment[],
): Promise<{ images: ImageInput[]; refs: { ts_ms: number; index: number }[] }> {
  const images: ImageInput[] = [];
  const refs: { ts_ms: number; index: number }[] = [];
  for (const m of moments) {
    const fullPath = path.join(root, m.frame);
    if (!existsSync(fullPath)) continue;
    const buf = await readFile(fullPath);
    images.push({ data: buf.toString("base64"), mimeType: "image/webp" });
    refs.push({ ts_ms: m.ts_ms, index: m.index });
  }
  return { images, refs };
}

function buildDescribePrompt(timestampsMs: number[]): string {
  return [
    `You are analyzing ${timestampsMs.length} keyframes from a video.`,
    `Frame timestamps in milliseconds, in order: ${timestampsMs.join(", ")}.`,
    ``,
    `Return a JSON object in this exact shape:`,
    `{`,
    `  "summary": "1-paragraph description of what the whole video shows / explains",`,
    `  "key_moments": [`,
    `    { "timestamp_ms": <number>, "description": "1 sentence describing this moment" },`,
    `    …`,
    `  ]`,
    `}`,
    ``,
    `One entry per frame, chronological order, using the exact timestamps provided. Be concrete; no marketing fluff.`,
  ].join("\n");
}

function buildPlanPrompt(args: {
  count: number;
  target_duration_sec: number;
  transcript: string;
  description: string;
  hint: string;
  captionLanguage: string;
}): string {
  const lines = [
    `You are generating a shorts plan for the video described below.`,
    `Target: ${args.count} non-overlapping clips, each roughly ${args.target_duration_sec} seconds long.`,
    `Caption language: ${args.captionLanguage}.`,
    args.hint ? `User hint: ${args.hint}` : "",
    ``,
    `Pick the most engaging moments. Use the transcript timestamps to bound each clip.`,
    `Generated caption_lines must be written in ${args.captionLanguage}; translate from the transcript language when needed without changing meaning.`,
    ``,
    `Return JSON in this exact shape (PlanSchema):`,
    `{`,
    `  "clips": [`,
    `    {`,
    `      "id": "clip_01",`,
    `      "start_ms": <number>, "end_ms": <number>,`,
    `      "title": "short title for the clip",`,
    `      "hook": "optional one-line hook",`,
    `      "reframe": "letterbox-blur",`,
    `      "aspect_ratio": "9:16",`,
    `      "caption_style": "tiktok-yellow-bottom",`,
    `      "caption_animation": "word-highlight",`,
    `      "caption_lines": ["3-6 short phrases derived from what's said in this clip"]`,
    `    }`,
    `  ]`,
    `}`,
    ``,
  ];
  if (args.description) {
    lines.push(`--- description.json ---\n${args.description}\n`);
  }
  if (args.transcript) {
    lines.push(`--- transcript.json (truncated) ---\n${args.transcript}\n`);
  }
  return lines.join("\n");
}
