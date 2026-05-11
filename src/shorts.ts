import { z } from "zod";
import { mkdir, readFile, writeFile, symlink, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { resolveProject, sourceVideoPath } from "./projectFolder.js";
import { runProc } from "./run.js";
import { config } from "./config.js";
import {
  DEFAULT_FACE_EMOJI,
  DEFAULT_FACE_EMOJI_FALLBACK_DIAMETER_NORM,
  DEFAULT_FACE_EMOJI_SCALE,
  FACE_EMOJI_NONE,
  faceEmojiAssetPath,
  faceEmojiPresentation,
  faceMouthAssetPath,
  normalizeFaceEmojiSelection,
} from "./face-emojis.js";
import { generateVoiceoverTrack } from "./voiceover.js";
import { getVideoInfo, resolveFfmpegPath } from "./ffmpeg.js";

// Pick a video encoder. Default: VideoToolbox on macOS (uses the media engine,
// dramatically faster than libx264 with comparable quality for short uploads),
// libx264 elsewhere. Override with AICW_VIDEO_ENCODER (e.g. "libx264", "hevc_videotoolbox").
function videoEncoderArgs(): string[] {
  const override = process.env.AICW_VIDEO_ENCODER;
  if (override) return ["-c:v", override];
  if (process.platform === "darwin") {
    return ["-c:v", "h264_videotoolbox", "-b:v", "6M", "-allow_sw", "1"];
  }
  return ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20"];
}

// A point is a key moment on the source-video timeline (typically derived from
// analysis/moments.json). Plan v2 lets clips reference points by index instead
// of raw ms ranges; the plan UI's snap trackbar uses them.
const NormalizedVisualRegionSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  width: z.number().min(0).max(1),
  height: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1).optional(),
  label: z.string().optional(),
}).passthrough();

const VisualMomentMetadataSchema = z.object({
  main_focus: NormalizedVisualRegionSchema.nullable().optional(),
  faces: z.array(NormalizedVisualRegionSchema).optional(),
  text_regions: z.array(NormalizedVisualRegionSchema).optional(),
  crop_regions: z.array(NormalizedVisualRegionSchema).optional(),
  privacy_risks: z.array(NormalizedVisualRegionSchema).optional(),
  safe_caption_zones: z.array(NormalizedVisualRegionSchema).optional(),
}).passthrough();

export type NormalizedVisualRegion = z.infer<typeof NormalizedVisualRegionSchema>;
export type VisualMomentMetadata = z.infer<typeof VisualMomentMetadataSchema>;

const MomentCropSchema = z.object({
  left: z.number().min(0).max(0.95).optional(),
  top: z.number().min(0).max(0.95).optional(),
  right: z.number().min(0).max(0.95).optional(),
  bottom: z.number().min(0).max(0.95).optional(),
}).passthrough();

const IllustrationModeSchema = z.preprocess(
  (value) => value === "demo_only" ? "animation_only" : value,
  z.enum(["none", "side_by_side", "animation_only"]),
);

export const PointSchema = z.object({
  index: z.number().int().nonnegative(),
  ts_ms: z.number().int().nonnegative(),
  // Raw Whisper/window text used for sync/debugging. The user-facing caption
  // below can be proofread or edited without losing the original timing source.
  original_text: z.string().optional(),
  caption: z.string().default(""),
  visual_metadata: VisualMomentMetadataSchema.optional(),
  // Optional per-moment extra crop margins, expressed as fractions of the
  // already-reframed output frame. Used for quick privacy cleanup.
  crop: MomentCropSchema.optional(),
  // Optional per-moment generated illustration video. The asset is generated
  // explicitly from the plan UI and cached under cache/illustrations; render
  // only composes an existing cached asset.
  illustration: z.object({
    mode: IllustrationModeSchema.default("none"),
    prompt: z.string().optional(),
    video_path: z.string().optional(),
    cache_key: z.string().optional(),
    duration_ms: z.number().optional(),
    generated_at: z.string().optional(),
    source_point_index: z.number().optional(),
    source_ts_ms: z.number().optional(),
    asset_label: z.string().optional(),
    explicit: z.boolean().optional(),
  }).passthrough().optional(),
});
export type Point = z.infer<typeof PointSchema>;

export const CAPTION_STYLE_IDS = [
  "plain-top",
  "plain-bottom",
  "tiktok-yellow-top",
  "tiktok-yellow-bottom",
  "bold-white-top",
  "bold-white-bottom",
  "neon-top",
  "neon-bottom",
  "pastel-top",
  "pastel-bottom",
  "beast-impact-top",
  "beast-impact-bottom",
  "creator-thin-top",
  "creator-thin-bottom",
  "karaoke-top",
  "karaoke-bottom",
] as const;
export type CaptionStyleId = (typeof CAPTION_STYLE_IDS)[number];

const CAPTION_STYLE_SET = new Set<string>(CAPTION_STYLE_IDS);

export function normalizeCaptionStyle(value: unknown): CaptionStyleId {
  const raw = typeof value === "string" ? value.trim() : "";
  const aliases: Record<string, CaptionStyleId> = {
    "plain": "plain-bottom",
    "plain-top": "plain-bottom",
    "tiktok-yellow": "tiktok-yellow-bottom",
    "tiktok-yellow-top": "tiktok-yellow-bottom",
    "bold-white": "bold-white-bottom",
    "bold-white-top": "bold-white-bottom",
    "neon": "neon-bottom",
    "neon-top": "neon-bottom",
    "pastel": "pastel-bottom",
    "pastel-top": "pastel-bottom",
    "mrbeast-impact": "beast-impact-bottom",
    "beast-impact": "beast-impact-bottom",
    "beast-impact-top": "beast-impact-bottom",
    "creator-thin": "creator-thin-bottom",
    "creator-thin-top": "creator-thin-bottom",
    "karaoke": "karaoke-bottom",
    "karaoke-top": "karaoke-bottom",
  };
  const mapped = aliases[raw] ?? raw;
  return CAPTION_STYLE_SET.has(mapped) ? mapped as CaptionStyleId : "plain-bottom";
}

export function captionStylePlacement(style: unknown): "top" | "bottom" {
  return normalizeCaptionStyle(style).endsWith("-top") ? "top" : "bottom";
}

const CaptionStyleSchema = z.preprocess((value) => normalizeCaptionStyle(value), z.enum(CAPTION_STYLE_IDS));
const FaceBlurSchema = z.enum(["none", "soft", "strong"]);
type FaceBlurMode = z.infer<typeof FaceBlurSchema>;

export const ClipSchema = z.object({
  id: z.string(),
  start_ms: z.number().int().nonnegative(),
  end_ms: z.number().int().positive(),
  // V2 additions — point indices into the plan's points[]. Optional so v1
  // (raw-ms) clips still validate. When set, the UI's snap trackbar uses these.
  start_point: z.number().int().nonnegative().optional(),
  end_point: z.number().int().nonnegative().optional(),
  title: z.string(),
  // Optional render-output title. This is separate from the editor clip title
  // so users can name exported files without changing the planning label.
  render_title: z.string().optional(),
  hook: z.string().optional(),
  reframe: z.enum(["crop", "letterbox-blur"]).default("crop"),
  crop_x_norm: z.number().min(0).max(1).optional(),
  // Output frame aspect ratio. 9:16 = vertical (TikTok/Shorts), 1:1 = Instagram square,
  // 4:5 = Instagram feed, 16:9 = standard landscape.
  aspect_ratio: z.enum(["9:16", "1:1", "4:5", "16:9"]).default("9:16"),
  // Optional manual captions. If provided, these win over transcript.srt.
  // Phrases are auto-distributed evenly across the clip.
  caption_lines: z.array(z.string()).optional(),
  // Visual preset. Every style encodes placement as -top or -bottom.
  // Legacy names such as "bold-white" and "mrbeast-impact" are normalized.
  // Rendered captions use ASS so placement and safe margins stay consistent.
  // "karaoke" reads transcript.words.json for true word-level highlight timing.
  caption_style: CaptionStyleSchema.default("plain-bottom"),
  // Alpha privacy feature. Uses per-point visual_metadata.faces when present.
  face_emoji_enabled: z.boolean().default(false),
  face_emoji: z.preprocess((value) => normalizeFaceEmojiSelection(value), z.string().max(8)).default(DEFAULT_FACE_EMOJI),
  face_blur: FaceBlurSchema.default("none"),
  face_imitate_speaking: z.boolean().default(false),
  // Alpha per-clip voice-over. When enabled, render-time audio is synthesized
  // from this clip's captions and replaces/adds the output audio track.
  voiceover_enabled: z.boolean().default(false),
  voiceover_voice: z.string().optional(),
  // Animation, orthogonal to caption_style:
  //   static          — show the cue text statically (default).
  //   word-pop        — TikTok-style: reveal one word at a time, cumulative.
  //   word-highlight  — show the full cue text; scale the currently-spoken word
  //                     larger (uses transcript.words.json when present, else
  //                     evenly distributes within the cue).
  // For caption_style="plain" any non-static animation forces ASS output (SRT
  // can't animate). Ignored for caption_style="karaoke" (karaoke does its own).
  caption_animation: z.enum(["static", "word-pop", "word-highlight"]).default("static"),
});
export const PlanSchema = z.object({
  version: z.literal(2).optional(),
  points: z.array(PointSchema).optional(),
  clips: z.array(ClipSchema).min(1),
});
export type Clip = z.infer<typeof ClipSchema>;
export type Plan = z.infer<typeof PlanSchema>;

type Cue = { startMs: number; endMs: number; text: string };
type WordTiming = { startMs: number; endMs: number; text: string };
type Captions = { type: "none" } | { type: "srt" | "ass"; path: string };
type FaceEmojiEvent = NormalizedVisualRegion & { startMs: number; endMs: number; fallback?: boolean; fallbackDiameterNorm?: number };
type IllustrationMode = "none" | "side_by_side" | "animation_only";
type IllustrationSegment = { startMs: number; endMs: number; mode: IllustrationMode; path?: string; inputIndex?: number; pointIndex?: number };
const ILLUSTRATION_MIN_SEGMENT_MS = 5000;
type FacePrivacyInput = {
  path?: string;
  baseInputIndex?: number;
  mouthSpeakingPath?: string;
  mouthSpeakingInputIndex?: number;
  events: FaceEmojiEvent[];
  speakingWindows: SpeakingWindow[];
  scale: number;
  yOffsetNorm: number;
  blur: FaceBlurMode;
  emojiOpacity: number;
};
type SpeakingWindow = { startMs: number; endMs: number };
type RenderFilter = { filterComplex: string; extraInputArgs: string[]; extraInputCount: number };
type VoiceoverAudio = { path: string };

const BOTTOM_CAPTION_SAFE_MARGIN_V = 380;

// ASS Style: line tail (everything after "Style: Default,").
// Format: Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding
const ASS_STYLE_BASES: Record<string, string> = {
  // Black bold text inside a SEMI-transparent yellow box (alpha 0x60 ≈ 62% opaque).
  // Outline=4 keeps the box tight to the text so wrapped-line boxes don't overlap each
  // other vertically (which previously caused a darker yellow stripe between lines).
  "tiktok-yellow":
    "Arial,84,&H00000000,&H000000FF,&H6000FFFF,&H6000FFFF,1,0,0,0,100,100,0,0,3,4,0,2,80,80,260,1",
  // Big bold white text with thick black outline, no box.
  "bold-white":
    "Arial,90,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,6,3,2,80,80,260,1",
  // Magenta primary text with thick cyan outline + glow shadow.
  neon:
    "Arial,80,&H00FF00FF,&H000000FF,&H00FFFF00,&H00000000,1,0,0,0,100,100,0,0,1,8,8,2,80,80,260,1",
  // Dark text inside a soft semi-transparent pink box (matching pink outline so
  // BorderStyle=3 doesn't paint a white ring), smaller font, friendly look.
  pastel:
    "Arial,72,&H00000000,&H000000FF,&H00C1B6FF,&H80C1B6FF,1,0,0,0,100,100,0,0,3,4,0,2,80,80,260,1",
  // Huge yellow text with thick black outline.
  "beast-impact":
    "Arial,130,&H0000FFFF,&H000000FF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,12,4,2,80,80,200,1",
  // Minimal small white text with thin outline, no bold — clean creator look.
  "creator-thin":
    "Arial,56,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,1,2,80,80,200,1",
  // Karaoke base: white text (SecondaryColour, unsung), highlights to yellow (PrimaryColour, sung).
  // The cuesToAss "karaoke" branch builds Dialogue events with \k<cs> per word for the wipe.
  karaoke:
    "Arial,84,&H0000FFFF,&H00FFFFFF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,6,2,2,80,80,260,1",
  // Default ASS style used when caption_style="plain" but an animation forces ASS output.
  // Mirrors the look of ffmpeg's built-in SRT renderer: white text, thin black outline.
  plain:
    "Arial,72,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,1,2,40,40,40,1",
};

function placeAssStyle(tail: string, placement: "top" | "bottom"): string {
  const parts = tail.split(",");
  if (parts.length < 22) return tail;
  parts[17] = placement === "top" ? "8" : "2";
  if (placement === "bottom") {
    const currentMargin = parseInt(parts[20] || "0", 10);
    parts[20] = String(Math.max(BOTTOM_CAPTION_SAFE_MARGIN_V, Number.isFinite(currentMargin) ? currentMargin : 0));
  }
  return parts.join(",");
}

function buildAssStyles(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [base, tail] of Object.entries(ASS_STYLE_BASES)) {
    out[`${base}-top`] = placeAssStyle(tail, "top");
    out[`${base}-bottom`] = placeAssStyle(tail, "bottom");
  }
  // Legacy aliases remain readable for older cached plans/previews.
  out.plain = out["plain-bottom"]!;
  out["tiktok-yellow"] = out["tiktok-yellow-bottom"]!;
  out["bold-white"] = out["bold-white-bottom"]!;
  out.neon = out["neon-bottom"]!;
  out.pastel = out["pastel-bottom"]!;
  out["mrbeast-impact"] = out["beast-impact-bottom"]!;
  out["beast-impact"] = out["beast-impact-bottom"]!;
  out["creator-thin"] = out["creator-thin-bottom"]!;
  out.karaoke = out["karaoke-bottom"]!;
  return out;
}

export const ASS_STYLES: Record<string, string> = buildAssStyles();

export async function saveShortsPlan(projectPath: string, plan: unknown): Promise<string> {
  const validated = PlanSchema.parse(plan);
  const root = await resolveProject(projectPath);
  const dir = path.join(root, "shorts");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, "plan.json");
  await writeFile(file, JSON.stringify(validated, null, 2));
  return file;
}

export async function renderShort(projectPath: string, clipId: string): Promise<string> {
  const { root, plan } = await loadPlan(projectPath);
  const idx = plan.clips.findIndex((c) => c.id === clipId);
  if (idx < 0) throw new Error(`no clip with id '${clipId}' in plan`);
  const dir = await prepareRenderDir(root);
  const out = await renderClipAt(root, plan.clips[idx]!, idx + 1, dir, plan.points);
  await updateLatestLink(root, dir);
  return out;
}

// Catalog of render variants the "Render…" dialog offers per clip.
// `for` is a short use-case label for the picker UI. `name` is the
// platform shorthand baked into output filenames as `<name>[<W>x<H>]`
// (e.g. `instagram[1080x1350]`). The render dialog may expose
// platform-specific IDs such as "youtube-shorts" or "linkedin" while
// saved plan clips keep their simpler editing aspect ratio.
export interface RenderVariant {
  aspect_ratio: "9:16" | "youtube-shorts" | "1:1" | "4:5" | "linkedin" | "16:9";
  name: string;
  w: number;
  h: number;
  for: string;
}
export const RENDER_VARIANTS: RenderVariant[] = [
  { aspect_ratio: "9:16",           name: "tiktok",           w: 1080, h: 1920, for: "TikTok / Instagram Reels" },
  { aspect_ratio: "youtube-shorts", name: "youtube-shorts",   w: 1080, h: 1920, for: "YouTube Shorts vertical" },
  { aspect_ratio: "1:1",            name: "instagram-square", w: 1080, h: 1080, for: "Instagram square feed" },
  { aspect_ratio: "4:5",            name: "instagram",        w: 1080, h: 1350, for: "Instagram tall feed" },
  { aspect_ratio: "linkedin",       name: "linkedin",         w: 1080, h: 1080, for: "LinkedIn square video" },
  { aspect_ratio: "16:9",           name: "youtube",          w: 1920, h: 1080, for: "YouTube landscape" },
];

// `instagram[1080x1350]` etc. — the human-readable label used in render
// filenames + the Rendered tab's size filter dropdown.
export function formatLabel(v: { name: string; w: number; h: number }): string {
  return `${v.name}[${v.w}x${v.h}]`;
}

function fileFormatLabel(v: { name: string; w: number; h: number }): string {
  return `${slug(v.name)}-${v.w}x${v.h}`;
}

function renderOptionSuffix(clip: Pick<Clip, "face_emoji_enabled" | "face_emoji" | "face_blur" | "voiceover_enabled">): string {
  const tags: string[] = [];
  if (clip.face_emoji_enabled && normalizeFaceBlur(clip.face_blur) !== "none") tags.push("face_blur");
  if (clip.face_emoji_enabled && normalizeFaceEmojiSelection(clip.face_emoji) !== FACE_EMOJI_NONE) tags.push("face_emoji");
  if (clip.voiceover_enabled) tags.push("voice_over");
  return tags.length > 0 ? `-${tags.join("-")}` : "";
}

function normalizeFaceBlur(value: unknown): FaceBlurMode {
  return value === "soft" || value === "strong" ? value : "none";
}

function facePrivacyEnabled(clip: Pick<Clip, "face_emoji_enabled" | "face_emoji" | "face_blur">): boolean {
  if (!clip.face_emoji_enabled) return false;
  return normalizeFaceBlur(clip.face_blur) !== "none" || normalizeFaceEmojiSelection(clip.face_emoji) !== FACE_EMOJI_NONE;
}

export function variantForAspect(ar: string): RenderVariant | undefined {
  return RENDER_VARIANTS.find((v) => v.aspect_ratio === ar);
}

export type RenderStreamEvent =
  | { type: "start"; total: number }
  | { type: "variant-start"; clip_id: string; aspect_ratio: string; w: number; h: number; out_basename: string }
  | { type: "variant-progress"; clip_id: string; aspect_ratio: string; percent: number }
  | { type: "variant-done"; clip_id: string; aspect_ratio: string; file: string; elapsed_ms: number }
  | { type: "variant-error"; clip_id: string; aspect_ratio: string; message: string }
  | { type: "done"; rendered: number; files: string[] };

// Render a clip in the picked aspect ratios, yielding per-variant
// progress events for the Render… dialog. Output filenames follow
// `<projectSlug>-<clipId>-<titleSlug>-<W>x<H>.mp4`. ffmpeg is invoked
// directly here (instead of via runProc) so we can capture its
// `-progress` stream in real time.
export async function* renderClipVariants(
  projectPath: string,
  clipId: string,
  aspectRatios: Array<RenderVariant["aspect_ratio"]>,
  opts: { targetDir?: string; updateLatest?: boolean; outputTitle?: string } = {},
): AsyncGenerator<RenderStreamEvent> {
  const { root, plan } = await loadPlan(projectPath);
  const idx = plan.clips.findIndex((c) => c.id === clipId);
  if (idx < 0) throw new Error(`no clip with id '${clipId}' in plan`);
  const baseClip = plan.clips[idx]!;
  const dir = opts.targetDir ?? (await prepareRenderDir(root));
  if (opts.targetDir) await mkdir(dir, { recursive: true });
  const updateLatest = opts.updateLatest ?? !opts.targetDir;
  const projectSlug = path.basename(root);
  const src = await sourceVideoPath(root);
  const sourceInfo = await getVideoInfo(src);
  const sourceDims = { w: sourceInfo.width, h: sourceInfo.height };
  const transcriptWords = await loadTranscriptWords(root);

  yield { type: "start", total: aspectRatios.length };
  const files: string[] = [];

  for (const ar of aspectRatios) {
    const dims = targetDims(ar);
    const variant = variantForAspect(ar);
    const fmt = variant ? formatLabel(variant) : `${dims.w}x${dims.h}`;
    const fileFmt = variant ? fileFormatLabel(variant) : `${dims.w}x${dims.h}`;
    const clip = { ...baseClip, aspect_ratio: ar as Clip["aspect_ratio"] };
    const titleSlug = slug(clip.title);
    const outputTitle = opts.outputTitle?.trim() || clip.render_title?.trim() || "";
    const outputTitleSlug = outputTitle ? slug(outputTitle) : "";
    const optionSuffix = renderOptionSuffix(clip);
    const outBase = outputTitleSlug
      ? `${outputTitleSlug}-${projectSlug}-${clip.id}${optionSuffix}-${fileFmt}`
      : `${projectSlug}-${clip.id}-${titleSlug}${optionSuffix}-${fileFmt}`;
    const outPath = path.join(dir, `${outBase}.mp4`);
    yield {
      type: "variant-start",
      clip_id: clip.id,
      aspect_ratio: ar,
      w: dims.w,
      h: dims.h,
      out_basename: outBase + ".mp4",
    };

    try {
      const captions = await prepareCaptions(root, clip, dir, outBase, plan.points);
      const ffmpeg = await resolveFfmpegPath({ requiredFilters: captions.type === "none" ? [] : ["subtitles"] });
      const startSec = (clip.start_ms / 1000).toFixed(3);
      const endSec = (clip.end_ms / 1000).toFixed(3);
      const renderFilter = await buildRenderFilter(root, clip, captions, plan.points, sourceDims, transcriptWords);
      const durationMs = Math.max(1, clip.end_ms - clip.start_ms);
      const voiceover = await prepareVoiceoverAudio(root, clip, dir, outBase, plan.points);
      const voiceoverInputIndex = 1 + renderFilter.extraInputCount;
      const audioArgs = voiceover
        ? [
            "-map", `${voiceoverInputIndex}:a:0`,
            "-af", `apad,atrim=duration=${(durationMs / 1000).toFixed(3)}`,
          ]
        : ["-map", "0:a?"];

      const args = [
        "-y",
        "-ss", startSec, "-to", endSec, "-i", src,
        ...renderFilter.extraInputArgs,
        ...(voiceover ? ["-i", voiceover.path] : []),
        "-filter_complex", renderFilter.filterComplex,
        "-map", "[v]", ...audioArgs,
        ...videoEncoderArgs(),
        "-c:a", "aac", "-b:a", "128k",
        "-movflags", "+faststart",
        "-progress", "pipe:1", "-nostats",
        outPath,
      ];

      const startedAt = Date.now();
      const child = spawn(ffmpeg, args, { stdio: ["ignore", "pipe", "pipe"] });
      // ffmpeg's -progress writes key=value lines; we care about
      // out_time_ms (microseconds rendered into the output). Convert
      // to a percentage of the clip's duration.
      let progressBuf = "";
      let stderr = "";
      let spawnError: Error | undefined;
      let lastEmittedPct = -1;
      const emit: RenderStreamEvent[] = [];
      child.stdout.setEncoding("utf-8");
      child.stderr?.setEncoding("utf-8");
      child.stderr?.on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(-6000);
      });
      child.stdout.on("data", (chunk: string) => {
        progressBuf += chunk;
        let nl;
        while ((nl = progressBuf.indexOf("\n")) >= 0) {
          const line = progressBuf.slice(0, nl).trim();
          progressBuf = progressBuf.slice(nl + 1);
          const eq = line.indexOf("=");
          if (eq < 0) continue;
          const key = line.slice(0, eq);
          const val = line.slice(eq + 1);
          if (key === "out_time_ms") {
            const us = parseInt(val, 10);
            if (Number.isFinite(us)) {
              const ms = us / 1000;
              const pct = Math.max(0, Math.min(100, Math.floor((ms / durationMs) * 100)));
              if (pct !== lastEmittedPct && pct > lastEmittedPct) {
                lastEmittedPct = pct;
                emit.push({ type: "variant-progress", clip_id: clip.id, aspect_ratio: ar, percent: pct });
              }
            }
          }
        }
      });
      // The child runs concurrently with our generator; we drain events
      // by yielding inside a polling loop driven by setImmediate.
      const done = new Promise<number | null>((resolve) => {
        child.on("error", (error) => { spawnError = error; resolve(null); });
        child.on("exit", (code) => resolve(code));
      });
      while (true) {
        // Drain pending progress events first.
        while (emit.length > 0) yield emit.shift()!;
        const settled = await Promise.race([
          done,
          new Promise<"tick">((r) => setTimeout(() => r("tick"), 200)),
        ]);
        if (settled !== "tick") {
          // Drain any remaining buffered events post-exit.
          while (emit.length > 0) yield emit.shift()!;
          if (settled === 0) {
            // Sidecar metadata for /api/renders to group + filter by
            // clip without parsing the filename. Filename pattern can
            // change later without breaking the per-clip Rendered tab.
            try {
              await writeFile(
                outPath.replace(/\.mp4$/, ".json"),
                JSON.stringify({
                  clip_id: clip.id,
                  title_slug: titleSlug,
                  output_title: outputTitle || clip.title,
                  aspect_ratio: ar,
                  format_name: variant?.name ?? "",
                  format_label: fmt,
                  w: dims.w,
                  h: dims.h,
                  face_emoji: Boolean(clip.face_emoji_enabled && normalizeFaceEmojiSelection(clip.face_emoji) !== FACE_EMOJI_NONE),
                  face_blur: clip.face_emoji_enabled ? normalizeFaceBlur(clip.face_blur) : "none",
                  face_replaced: facePrivacyEnabled(clip),
                  voice_over: Boolean(clip.voiceover_enabled),
                  rendered_at: new Date().toISOString(),
                }, null, 2),
              );
            } catch { /* best-effort sidecar; renders still work without it */ }
            yield { type: "variant-progress", clip_id: clip.id, aspect_ratio: ar, percent: 100 };
            yield {
              type: "variant-done",
              clip_id: clip.id,
              aspect_ratio: ar,
              file: outPath,
              elapsed_ms: Date.now() - startedAt,
            };
            files.push(outPath);
          } else {
            yield {
              type: "variant-error",
              clip_id: clip.id,
              aspect_ratio: ar,
              message: ffmpegFailureMessage(settled, spawnError, stderr),
            };
          }
          break;
        }
      }
    } catch (e) {
      yield {
        type: "variant-error",
        clip_id: clip.id,
        aspect_ratio: ar,
        message: e instanceof Error ? e.message : String(e),
      };
    }
  }

  if (updateLatest) await updateLatestLink(root, dir);
  yield { type: "done", rendered: files.length, files };
}

export async function renderAllShorts(
  projectPath: string,
  opts: { concurrency?: number } = {},
): Promise<string[]> {
  const { root, plan } = await loadPlan(projectPath);
  const fromEnv = process.env.AICW_VIDEO_RENDER_CONCURRENCY
    ? parseInt(process.env.AICW_VIDEO_RENDER_CONCURRENCY, 10)
    : undefined;
  const conc = Math.max(1, Math.min(plan.clips.length, opts.concurrency ?? fromEnv ?? 4));

  const dir = await prepareRenderDir(root);
  const queue = plan.clips.map((c, i) => ({ c, num: i + 1, idx: i }));
  const results: string[] = new Array(plan.clips.length);
  async function worker(): Promise<void> {
    while (true) {
      const item = queue.shift();
      if (!item) return;
      results[item.idx] = await renderClipAt(root, item.c, item.num, dir, plan.points);
    }
  }
  await Promise.all(Array.from({ length: conc }, () => worker()));
  await updateLatestLink(root, dir);
  return results;
}

// Each render run lands in shorts/render-<YYYYMMDD-HHMM>/ so that re-rendering
// with a tweaked plan.json doesn't clobber prior results — the user can review
// past renders in the project folder. shorts/latest is a symlink to the most
// recent one.
async function prepareRenderDir(root: string): Promise<string> {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const dir = path.join(root, "shorts", `render-${stamp}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function updateLatestLink(root: string, dir: string): Promise<void> {
  const link = path.join(root, "shorts", "latest");
  const target = path.relative(path.dirname(link), dir);
  try { await unlink(link); } catch { /* missing is fine */ }
  try { await symlink(target, link, "dir"); } catch { /* symlinks may fail on some filesystems; non-fatal */ }
}

async function loadPlan(projectPath: string): Promise<{ root: string; plan: Plan }> {
  const root = await resolveProject(projectPath);
  const file = path.join(root, "shorts", "plan.json");
  if (!existsSync(file)) throw new Error(`no shorts/plan.json in ${root} (create a clip plan first)`);
  const plan = PlanSchema.parse(JSON.parse(await readFile(file, "utf8")));
  return { root, plan };
}

async function renderClipAt(
  root: string,
  clip: Clip,
  num: number,
  outDir?: string,
  points?: Plan["points"],
): Promise<string> {
  const src = await sourceVideoPath(root);
  const dir = outDir ?? path.join(root, "shorts");
  await mkdir(dir, { recursive: true });
  const outputTitle = clip.render_title?.trim() || clip.title;
  const name = `${String(num).padStart(2, "0")}-${slug(outputTitle)}${renderOptionSuffix(clip)}`;
  const outPath = path.join(dir, `${name}.mp4`);

  const captions = await prepareCaptions(root, clip, dir, name, points);
  const sourceInfo = await getVideoInfo(src);
  const sourceDims = { w: sourceInfo.width, h: sourceInfo.height };
  const transcriptWords = await loadTranscriptWords(root);

  const startSec = (clip.start_ms / 1000).toFixed(3);
  const endSec = (clip.end_ms / 1000).toFixed(3);
  const ffmpeg = await resolveFfmpegPath({ requiredFilters: captions.type === "none" ? [] : ["subtitles"] });
  const renderFilter = await buildRenderFilter(root, clip, captions, points, sourceDims, transcriptWords);
  const durationMs = Math.max(1, clip.end_ms - clip.start_ms);
  const voiceover = await prepareVoiceoverAudio(root, clip, dir, name, points);
  const voiceoverInputIndex = 1 + renderFilter.extraInputCount;
  const audioArgs = voiceover
    ? [
        "-map", `${voiceoverInputIndex}:a:0`,
        "-af", `apad,atrim=duration=${(durationMs / 1000).toFixed(3)}`,
      ]
    : ["-map", "0:a?"];

  await runProc(ffmpeg, [
    "-y",
    "-ss", startSec, "-to", endSec, "-i", src,
    ...renderFilter.extraInputArgs,
    ...(voiceover ? ["-i", voiceover.path] : []),
    "-filter_complex", renderFilter.filterComplex,
    "-map", "[v]", ...audioArgs,
    ...videoEncoderArgs(),
    "-c:a", "aac", "-b:a", "128k",
    "-movflags", "+faststart",
    outPath,
  ]);
  return outPath;
}

async function prepareCaptions(
  root: string,
  clip: Clip,
  dir: string,
  base: string,
  points?: Plan["points"],
): Promise<Captions> {
  let cues = await collectCaptionCues(root, clip, points);
  if (cues.length === 0) return { type: "none" };

  // Split any cue whose text would wrap at fontsize 84 inside a 1080-wide canvas,
  // so each visible cue fits on ONE visual row (avoids the stacked-rows overlap
  // artifact even with semi-transparent box backgrounds).
  cues = cues.flatMap((c) => splitLongCue(c, 18));

  const captionStyle = normalizeCaptionStyle(clip.caption_style);
  // Use ASS for every rendered caption style, including plain/static, so the
  // bottom control-safe margin is applied consistently.
  // Karaoke needs word-level timing (clip-local). Try transcript.words.json first;
  // cuesToAss falls back to even distribution if absent.
  let words: WordTiming[] | undefined;
  if (captionStyle === "karaoke-bottom" || captionStyle === "karaoke-top") {
    const wordsPath = path.join(root, "transcript.words.json");
    if (existsSync(wordsPath)) {
      const all: WordTiming[] = JSON.parse(await readFile(wordsPath, "utf8"));
      words = all
        .filter((w) => w.endMs > clip.start_ms && w.startMs < clip.end_ms)
        .map((w) => ({
          startMs: Math.max(0, w.startMs - clip.start_ms),
          endMs: Math.min(clip.end_ms - clip.start_ms, w.endMs - clip.start_ms),
          text: w.text,
        }));
    }
  }

  const p = path.join(dir, `${base}.ass`);
  await writeFile(p, cuesToAss(cues, captionStyle, clip.caption_animation, words));
  return { type: "ass", path: p };
}

async function prepareVoiceoverAudio(
  root: string,
  clip: Clip,
  dir: string,
  base: string,
  points?: Plan["points"],
): Promise<VoiceoverAudio | undefined> {
  if (!clip.voiceover_enabled) return undefined;
  const cues = await collectCaptionCues(root, clip, points);
  const entries = cues
    .map((c) => ({ ...c, text: c.text.trim() }))
    .filter((c) => c.text);
  if (entries.length === 0) {
    throw new Error(`clip ${clip.id}: voice-over is enabled, but there is no caption text to read`);
  }
  const outPath = path.join(dir, `${base}.voiceover.wav`);
  await generateVoiceoverTrack({
    entries,
    durationMs: clip.end_ms - clip.start_ms,
    voice: clip.voiceover_voice,
    outPath,
    workDir: dir,
  });
  return { path: outPath };
}

async function collectCaptionCues(
  root: string,
  clip: Clip,
  points?: Plan["points"],
): Promise<Cue[]> {
  // Preferred path (V2 plans): use source-timed points inside the selected
  // [start_ms..end_ms] range so free Shift-dragged markers keep captions synced.
  // Point anchors are only metadata for snapped handles; they must not decide
  // caption timing when a marker is between points.
  const cuesFromPoints = pointCuesForClip(clip, points);
  if (cuesFromPoints.length > 0) return cuesFromPoints;
  if (clip.caption_lines && clip.caption_lines.length > 0) {
    return distributeCues(clip.caption_lines, clip.end_ms - clip.start_ms);
  }
  const sourceSrt = path.join(root, "transcript.srt");
  if (!existsSync(sourceSrt)) return [];
  const sliced = sliceSrt(await readFile(sourceSrt, "utf8"), clip.start_ms, clip.end_ms);
  return sliced.trim() ? parseSrtToCues(sliced) : [];
}

const ASPECT_DIMS: Record<string, { w: number; h: number }> = {
  "9:16": { w: 1080, h: 1920 },
  "youtube-shorts": { w: 1080, h: 1920 },
  "1:1": { w: 1080, h: 1080 },
  "4:5": { w: 1080, h: 1350 },
  "linkedin": { w: 1080, h: 1080 },
  "16:9": { w: 1920, h: 1080 },
};

export function targetDims(ar: string): { w: number; h: number } {
  return ASPECT_DIMS[ar] ?? ASPECT_DIMS["9:16"]!;
}

// Centered crop to the requested aspect ratio. xNorm biases the horizontal center
// for 9:16 (e.g. 0.7 to keep the right side of a screen recording).
function cropExpr(ar: string, xNorm: number): string {
  const ratios: Record<string, [number, number]> = {
    "9:16": [9, 16],
    "youtube-shorts": [9, 16],
    "1:1": [1, 1],
    "4:5": [4, 5],
    "linkedin": [1, 1],
    "16:9": [16, 9],
  };
  const [w, h] = ratios[ar] ?? ratios["9:16"]!;
  const cw = `min(iw,ih*${w}/${h})`;
  const ch = `min(ih,iw*${h}/${w})`;
  const cx = `max(0,min(iw-${cw},iw*${xNorm}-${cw}/2))`;
  const cy = `(ih-${ch})/2`;
  return `crop='${cw}':'${ch}':'${cx}':'${cy}'`;
}

type MomentCropMargins = { left: number; top: number; right: number; bottom: number };
type MomentCropSegment = { startMs: number; endMs: number; crop: MomentCropMargins | null };
type VideoDims = { w: number; h: number };

function normalizeMomentCrop(input: unknown): MomentCropMargins | null {
  const raw = input && typeof input === "object" ? input as Partial<Record<keyof MomentCropMargins, unknown>> : {};
  const left = clampCropMargin(raw.left);
  const top = clampCropMargin(raw.top);
  const right = clampCropMargin(raw.right);
  const bottom = clampCropMargin(raw.bottom);
  if (left <= 0 && top <= 0 && right <= 0 && bottom <= 0) return null;
  const hTotal = left + right;
  const vTotal = top + bottom;
  if (hTotal >= 0.95 || vTotal >= 0.95) return null;
  return { left, top, right, bottom };
}

function clampCropMargin(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(0.9, n));
}

function momentCropSegmentsForClip(clip: Clip, points: Plan["points"] | undefined): MomentCropSegment[] {
  if (!points || points.length === 0) return [];
  const sorted = [...points].sort((a, b) => a.ts_ms - b.ts_ms);
  const segments: MomentCropSegment[] = [];
  const clipDur = Math.max(0, clip.end_ms - clip.start_ms);
  if (clipDur <= 0) return [];
  for (let i = 0; i < sorted.length; i++) {
    const point = sorted[i]!;
    if (point.ts_ms >= clip.end_ms) break;
    const nextTs = i + 1 < sorted.length ? sorted[i + 1]!.ts_ms : clip.end_ms;
    const startMs = Math.max(0, point.ts_ms - clip.start_ms);
    const endMs = Math.min(clipDur, nextTs - clip.start_ms);
    if (endMs <= 0 || startMs >= clipDur) continue;
    segments.push({
      startMs,
      endMs,
      crop: normalizeMomentCrop(point.crop),
    });
  }
  const filled: MomentCropSegment[] = [];
  let cursor = 0;
  for (const segment of segments.sort((a, b) => a.startMs - b.startMs)) {
    if (segment.startMs > cursor) filled.push({ startMs: cursor, endMs: segment.startMs, crop: null });
    filled.push(segment);
    cursor = Math.max(cursor, segment.endMs);
  }
  if (cursor < clipDur) filled.push({ startMs: cursor, endMs: clipDur, crop: null });
  return mergeMomentCropSegments(filled);
}

function mergeMomentCropSegments(segments: MomentCropSegment[]): MomentCropSegment[] {
  const out: MomentCropSegment[] = [];
  for (const segment of segments) {
    const prev = out[out.length - 1];
    if (prev && sameMomentCrop(prev.crop, segment.crop) && Math.abs(prev.endMs - segment.startMs) <= 1) {
      prev.endMs = segment.endMs;
    } else {
      out.push({ ...segment, crop: segment.crop ? { ...segment.crop } : null });
    }
  }
  return out;
}

function sameMomentCrop(a: MomentCropMargins | null, b: MomentCropMargins | null): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom;
}

async function buildRenderFilter(
  root: string,
  clip: Clip,
  captions: Captions,
  points: Plan["points"] | undefined,
  sourceDims: VideoDims,
  transcriptWords: WordTiming[],
): Promise<RenderFilter> {
  const faceInput = await prepareFacePrivacyInput(clip, points, transcriptWords);
  const illustrationSegments = illustrationSegmentsForClip(root, clip, points);
  const extraInputArgs: string[] = [];
  let extraInputCount = 0;
  for (const segment of illustrationSegments) {
    if (segment.mode === "none" || !segment.path) continue;
    segment.inputIndex = 1 + extraInputCount;
    extraInputArgs.push("-stream_loop", "-1", "-i", segment.path);
    extraInputCount++;
  }
  if (faceInput?.path) {
    faceInput.baseInputIndex = 1 + extraInputCount;
    extraInputArgs.push("-loop", "1", "-i", faceInput.path);
    extraInputCount++;
  }
  if (faceInput?.mouthSpeakingPath) {
    faceInput.mouthSpeakingInputIndex = 1 + extraInputCount;
    extraInputArgs.push("-loop", "1", "-i", faceInput.mouthSpeakingPath);
    extraInputCount++;
  }
  return {
    filterComplex: buildFilter(clip, captions, points, faceInput, illustrationSegments, sourceDims),
    extraInputArgs,
    extraInputCount,
  };
}

function illustrationSegmentsForClip(root: string, clip: Clip, points: Plan["points"] | undefined): IllustrationSegment[] {
  if (!points || points.length === 0) return [];
  const clipDur = Math.max(0, clip.end_ms - clip.start_ms);
  if (clipDur <= 0) return [];
  const sorted = [...points].sort((a, b) => a.ts_ms - b.ts_ms);
  const events = sorted
    .filter((point) => point.ts_ms < clip.end_ms && isIllustrationTimelineEvent(point.illustration))
    .map((point) => {
      const mode = normalizeIllustrationMode(point.illustration?.mode);
      const durationMs = Math.max(1000, Math.round(Number(point.illustration?.duration_ms || ILLUSTRATION_MIN_SEGMENT_MS)));
      return { point, mode, durationMs };
    });
  const raw: IllustrationSegment[] = [];
  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;
    if (event.mode === "none") continue;
    const point = event.point;
    const nextEventTs = i + 1 < events.length ? events[i + 1]!.point.ts_ms : Infinity;
    const startAbs = Math.max(clip.start_ms, point.ts_ms);
    const endAbs = Math.min(clip.end_ms, point.ts_ms + Math.max(ILLUSTRATION_MIN_SEGMENT_MS, event.durationMs), nextEventTs);
    if (endAbs <= clip.start_ms || startAbs >= clip.end_ms || endAbs <= startAbs) continue;
    const asset = resolveIllustrationAsset(root, point.illustration?.video_path);
    if (!asset) {
      throw new Error(`point #${point.index} is set to ${event.mode}, but no cached illustration video exists. Generate or select an asset in the Illustrations tab first.`);
    }
    raw.push({
      startMs: Math.max(0, startAbs - clip.start_ms),
      endMs: Math.min(clipDur, endAbs - clip.start_ms),
      mode: event.mode,
      path: asset,
      pointIndex: point.index,
    });
  }
  if (raw.length === 0) return [];
  const filled: IllustrationSegment[] = [];
  let cursor = 0;
  for (const segment of raw.sort((a, b) => a.startMs - b.startMs)) {
    if (segment.startMs > cursor) filled.push({ startMs: cursor, endMs: segment.startMs, mode: "none" });
    filled.push(segment);
    cursor = Math.max(cursor, segment.endMs);
  }
  if (cursor < clipDur) filled.push({ startMs: cursor, endMs: clipDur, mode: "none" });
  return filled.some((s) => s.mode !== "none") ? mergeIllustrationSegments(filled) : [];
}

function normalizeIllustrationMode(value: unknown): IllustrationMode {
  if (value === "demo_only") return "animation_only";
  return value === "side_by_side" || value === "animation_only" ? value : "none";
}

function isIllustrationTimelineEvent(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const illustration = value as { mode?: unknown; explicit?: unknown };
  return normalizeIllustrationMode(illustration.mode) !== "none" || illustration.explicit === true;
}

function resolveIllustrationAsset(root: string, relOrAbs: unknown): string | undefined {
  const raw = typeof relOrAbs === "string" ? relOrAbs.trim() : "";
  if (!raw) return undefined;
  const resolved = path.resolve(path.isAbsolute(raw) ? raw : path.join(root, raw));
  const rootResolved = path.resolve(root);
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) return undefined;
  return existsSync(resolved) ? resolved : undefined;
}

function mergeIllustrationSegments(segments: IllustrationSegment[]): IllustrationSegment[] {
  const out: IllustrationSegment[] = [];
  for (const segment of segments) {
    const prev = out[out.length - 1];
    if (
      prev &&
      prev.mode === segment.mode &&
      prev.path === segment.path &&
      Math.abs(prev.endMs - segment.startMs) <= 1
    ) {
      prev.endMs = segment.endMs;
    } else {
      out.push({ ...segment });
    }
  }
  return out;
}

async function prepareFacePrivacyInput(
  clip: Clip,
  points: Plan["points"] | undefined,
  transcriptWords: WordTiming[],
): Promise<FacePrivacyInput | undefined> {
  if (!facePrivacyEnabled(clip)) return undefined;
  const events = faceEmojiEventsForClip(clip, points);
  if (events.length === 0) return undefined;
  const blur = normalizeFaceBlur(clip.face_blur);
  const emoji = normalizeFaceEmojiSelection(clip.face_emoji);
  let file: string | undefined;
  if (emoji !== FACE_EMOJI_NONE) {
    file = faceEmojiAssetPath(emoji);
    if (!existsSync(file)) {
      throw new Error(`face emoji asset is missing: ${file}. Run npm run generate-assets or npm run build.`);
    }
  }
  const speakingWindows = clip.face_imitate_speaking === false ? [] : speakingWindowsForClip(clip, points, transcriptWords);
  const mouthSpeakingPath = speakingWindows.length > 0 ? faceMouthAssetPath("speaking") : undefined;
  if (mouthSpeakingPath && !existsSync(mouthSpeakingPath)) {
    throw new Error(`face mouth asset is missing. Run npm run generate-assets or npm run build.`);
  }
  const presentation = faceEmojiPresentation(emoji);
  const scale = config.faceEmojiScale * presentation.scale;
  const emojiOpacity = blur === "none" ? 1 : 0.82;
  return {
    path: file,
    mouthSpeakingPath,
    events,
    speakingWindows,
    scale,
    yOffsetNorm: presentation.yOffset,
    blur,
    emojiOpacity,
  };
}

function buildFilter(
  clip: Clip,
  captions: Captions,
  points: Plan["points"] | undefined,
  faceInput: FacePrivacyInput | undefined,
  illustrationSegments: IllustrationSegment[],
  sourceDims: VideoDims,
): string {
  const dims = targetDims(clip.aspect_ratio);
  const subtitleFilter = captions.type === "none" ? "null" : `subtitles=${escapeFilterPath(captions.path)}`;
  const faceBlur = faceBlurChain("[0:v]", faceInput, "face_blur_src");
  const faceEmoji = faceEmojiChain(faceBlur ? "[face_blur_src]" : "[0:v]", faceInput, "face_src");
  const faceMouth = faceMouthChain(faceEmoji ? "[face_src]" : faceBlur ? "[face_blur_src]" : "[0:v]", faceInput, "face_mouth_src");
  const faceInputLabel = faceMouth ? "[face_mouth_src]" : faceEmoji ? "[face_src]" : faceBlur ? "[face_blur_src]" : "[0:v]";
  const sourceCropChain = momentCropChain(faceInputLabel, clip, points, sourceDims, "source_crop");
  const sourceInput = sourceCropChain ? "[source_crop]" : faceInputLabel;
  const sourcePrefix = [faceBlur, faceEmoji, faceMouth, sourceCropChain].filter(Boolean).join(";");
  const withPrefix = (chain: string): string => sourcePrefix ? `${sourcePrefix};${chain}` : chain;
  const finalize = (baseChain: string): string => `${baseChain};[base]${subtitleFilter}[v]`;
  const sourceOutLabel = illustrationSegments.length > 0 ? "source_base" : "base";
  const finish = (sourceChain: string): string => {
    const prefixed = withPrefix(sourceChain);
    if (illustrationSegments.length === 0) return finalize(prefixed);
    return `${prefixed};${illustrationCompositeChain("[source_base]", illustrationSegments, dims, "v", subtitleFilter)}`;
  };
  if (clip.reframe === "letterbox-blur") {
    return finish(
      `${sourceInput}split[bg][fg];` +
      `[bg]scale=${dims.w}:${dims.h}:force_original_aspect_ratio=increase,crop=${dims.w}:${dims.h},boxblur=20:5[bgb];` +
      `[fg]scale=${dims.w}:${dims.h}:force_original_aspect_ratio=decrease[fgs];` +
      `[bgb][fgs]overlay=(W-w)/2:(H-h)/2[${sourceOutLabel}]`,
    );
  }
  const x = clip.crop_x_norm ?? 0.5;
  return finish(`${sourceInput}${cropExpr(clip.aspect_ratio, x)},scale=${dims.w}:${dims.h}[${sourceOutLabel}]`);
}

function illustrationCompositeChain(
  sourceInputLabel: string,
  segments: IllustrationSegment[],
  dims: { w: number; h: number },
  outputLabel: string,
  subtitleFilter: string,
): string {
  if (segments.length === 0) return `${sourceInputLabel}copy[${outputLabel}]`;
  if (segments.length === 1) return illustrationSegmentChain(sourceInputLabel, segments[0]!, dims, outputLabel, subtitleFilter);
  const parts: string[] = [];
  const sourceLabels: string[] = [];
  const splitLabels = segments.map((_, idx) => `[ill_src_${idx}]`).join("");
  parts.push(`${sourceInputLabel}split=${segments.length}${splitLabels}`);
  for (let i = 0; i < segments.length; i++) sourceLabels.push(`[ill_src_${i}]`);
  const outLabels: string[] = [];
  segments.forEach((segment, idx) => {
    const out = `ill_seg_${idx}`;
    outLabels.push(`[${out}]`);
    parts.push(illustrationSegmentChain(sourceLabels[idx]!, segment, dims, out, subtitleFilter));
  });
  parts.push(`${outLabels.join("")}concat=n=${segments.length}:v=1:a=0[${outputLabel}]`);
  return parts.join(";");
}

function illustrationSegmentChain(
  sourceInputLabel: string,
  segment: IllustrationSegment,
  dims: { w: number; h: number },
  outputLabel: string,
  subtitleFilter: string,
): string {
  const start = (segment.startMs / 1000).toFixed(3);
  const end = (segment.endMs / 1000).toFixed(3);
  const duration = Math.max(0.001, (segment.endMs - segment.startMs) / 1000).toFixed(3);
  const subtitlePrefix = subtitleFilter === "null" ? "" : `${subtitleFilter},`;
  const subtitleStep = subtitleFilter === "null" ? "" : `,${subtitleFilter}`;
  const sourceTrim = `${sourceInputLabel}trim=start=${start}:end=${end},setpts=PTS-STARTPTS`;
  const sourceCaptionTrim = `${sourceInputLabel}${subtitlePrefix}trim=start=${start}:end=${end},setpts=PTS-STARTPTS`;
  if (segment.mode === "none") {
    return `${sourceCaptionTrim},setsar=1[${outputLabel}]`;
  }
  if (segment.inputIndex == null) {
    throw new Error(`illustration segment for point #${segment.pointIndex ?? "?"} has no ffmpeg input`);
  }
  if (segment.mode === "animation_only") {
    return `${sourceTrim},nullsink;` +
      `[${segment.inputIndex}:v]trim=duration=${duration},setpts=PTS+${start}/TB,scale=${dims.w}:${dims.h}:force_original_aspect_ratio=increase,crop=${dims.w}:${dims.h}${subtitleStep},trim=start=${start}:end=${end},setpts=PTS-STARTPTS,setsar=1[${outputLabel}]`;
  }
  const halfW = Math.max(2, Math.floor(dims.w / 2 / 2) * 2);
  const srcOut = `ill_src_side_${outputLabel}`;
  const demoOut = `ill_demo_side_${outputLabel}`;
  return `${sourceCaptionTrim},scale=${halfW}:${dims.h}:force_original_aspect_ratio=increase,crop=${halfW}:${dims.h},setsar=1[${srcOut}];` +
    `[${segment.inputIndex}:v]trim=duration=${duration},setpts=PTS-STARTPTS,scale=${halfW}:${dims.h}:force_original_aspect_ratio=increase,crop=${halfW}:${dims.h},setsar=1[${demoOut}];` +
    `[${srcOut}][${demoOut}]hstack=inputs=2[${outputLabel}]`;
}

function momentCropChain(
  inputLabel: string,
  clip: Clip,
  points: Plan["points"] | undefined,
  dims: { w: number; h: number },
  outputLabel: string,
): string {
  const segments = momentCropSegmentsForClip(clip, points);
  if (segments.length === 0 || !segments.some((s) => s.crop)) return "";
  if (segments.length === 1) {
    return segmentCropChain(inputLabel, segments[0]!, dims, outputLabel);
  }
  const splitLabels = segments.map((_, idx) => `[mc_src_${idx}]`).join("");
  const parts = [`${inputLabel}split=${segments.length}${splitLabels}`];
  const outLabels: string[] = [];
  segments.forEach((segment, idx) => {
    const out = `mc_seg_${idx}`;
    outLabels.push(`[${out}]`);
    parts.push(segmentCropChain(`[mc_src_${idx}]`, segment, dims, out));
  });
  parts.push(`${outLabels.join("")}concat=n=${segments.length}:v=1:a=0[${outputLabel}]`);
  return parts.join(";");
}

function segmentCropChain(
  inputLabel: string,
  segment: MomentCropSegment,
  dims: { w: number; h: number },
  outputLabel: string,
): string {
  const start = (segment.startMs / 1000).toFixed(3);
  const end = (segment.endMs / 1000).toFixed(3);
  const trim = `${inputLabel}trim=start=${start}:end=${end},setpts=PTS-STARTPTS`;
  const crop = segment.crop ? `,${momentCropFilter(segment.crop, dims)}` : `,scale=${dims.w}:${dims.h},setsar=1`;
  return `${trim}${crop}[${outputLabel}]`;
}

function momentCropFilter(crop: MomentCropMargins, dims: { w: number; h: number }): string {
  const keepW = Math.max(0.05, 1 - crop.left - crop.right);
  const keepH = Math.max(0.05, 1 - crop.top - crop.bottom);
  const cw = `max(2,trunc(iw*${keepW.toFixed(6)}/2)*2)`;
  const ch = `max(2,trunc(ih*${keepH.toFixed(6)}/2)*2)`;
  const x = `max(0,min(iw-${cw},iw*${crop.left.toFixed(6)}))`;
  const y = `max(0,min(ih-${ch},ih*${crop.top.toFixed(6)}))`;
  return `crop='${cw}':'${ch}':'${x}':'${y}',scale=${dims.w}:${dims.h}:force_original_aspect_ratio=increase,crop=${dims.w}:${dims.h},setsar=1`;
}

function faceBlurChain(
  inputLabel: string,
  faceInput: FacePrivacyInput | undefined,
  outputLabel: string,
): string {
  if (!faceInput || faceInput.blur === "none" || faceInput.events.length === 0) return "";
  const radius = faceInput.blur === "strong" ? 42 : 24;
  let current = inputLabel;
  const parts: string[] = [];
  faceInput.events.forEach((ev, idx) => {
    const next = idx + 1 === faceInput.events.length ? outputLabel : `face_blur_${idx}`;
    const base = `face_blur_base_${idx}`;
    const cropSrc = `face_blur_crop_src_${idx}`;
    const blurred = `face_blur_crop_${idx}`;
    const geom = faceBlurGeometry(ev);
    const start = (ev.startMs / 1000).toFixed(3);
    const end = (ev.endMs / 1000).toFixed(3);
    parts.push(
      `${current}split[${base}][${cropSrc}];` +
      `[${cropSrc}]crop='${geom.w}':'${geom.h}':'${geom.cropX}':'${geom.cropY}',boxblur=${radius}:2[${blurred}];` +
      `[${base}][${blurred}]overlay=x='${geom.overlayX}':y='${geom.overlayY}':enable='between(t\\,${start}\\,${end})':shortest=1[${next}]`,
    );
    current = `[${next}]`;
  });
  return parts.join(";");
}

function faceBlurGeometry(ev: FaceEmojiEvent): { cropX: string; cropY: string; overlayX: string; overlayY: string; w: string; h: string } {
  if (ev.fallback) {
    const diameter = Math.max(0.1, Math.min(1, ev.fallbackDiameterNorm || DEFAULT_FACE_EMOJI_FALLBACK_DIAMETER_NORM));
    const size = `max(8,trunc(min(iw\\,ih)*${diameter.toFixed(4)}/2)*2)`;
    return {
      cropX: `max(0,min(iw-${size},iw*0.5-${size}/2))`,
      cropY: `max(0,min(ih-${size},ih*0.5-${size}/2))`,
      overlayX: `max(0,min(W-w,W*0.5-w/2))`,
      overlayY: `max(0,min(H-h,H*0.5-h/2))`,
      w: size,
      h: size,
    };
  }
  const cx = Math.max(0, Math.min(1, ev.x + ev.width / 2));
  const cy = Math.max(0, Math.min(1, ev.y + ev.height / 2));
  const wNorm = Math.max(0.02, Math.min(1, ev.width * 1.35));
  const hNorm = Math.max(0.02, Math.min(1, ev.height * 1.45));
  const w = `max(8,trunc(iw*${wNorm.toFixed(6)}/2)*2)`;
  const h = `max(8,trunc(ih*${hNorm.toFixed(6)}/2)*2)`;
  return {
    cropX: `max(0,min(iw-${w},iw*${cx.toFixed(6)}-${w}/2))`,
    cropY: `max(0,min(ih-${h},ih*${cy.toFixed(6)}-${h}/2))`,
    overlayX: `max(0,min(W-w,W*${cx.toFixed(6)}-w/2))`,
    overlayY: `max(0,min(H-h,H*${cy.toFixed(6)}-h/2))`,
    w,
    h,
  };
}

function faceEmojiChain(
  inputLabel: string,
  faceInput: FacePrivacyInput | undefined,
  outputLabel: string,
): string {
  if (!faceInput?.path || faceInput.baseInputIndex == null) return "";
  return faceEmojiOverlayChain(inputLabel, faceInput.baseInputIndex, faceInput.events, faceInput, "face_idle", outputLabel);
}

function faceEmojiOverlayChain(
  inputLabel: string,
  inputIndex: number,
  events: FaceEmojiEvent[],
  faceInput: FacePrivacyInput,
  prefix: string,
  outputLabel: string,
): string {
  if (events.length === 0) return "";
  const splitLabels = events.map((_, idx) => `[${prefix}_png_${idx}]`).join("");
  const scale = Math.max(0.5, Math.min(3, faceInput.scale || DEFAULT_FACE_EMOJI_SCALE));
  const opacity = Math.max(0.2, Math.min(1, faceInput.emojiOpacity || 1));
  let chain = `[${inputIndex}:v]format=rgba${opacity < 0.999 ? `,colorchannelmixer=aa=${opacity.toFixed(3)}` : ""},split=${events.length}${splitLabels}`;
  let current = inputLabel;
  events.forEach((ev, idx) => {
    const next = idx + 1 === events.length ? outputLabel : `face_${idx}`;
    const ref = `face_ref_${idx}`;
    const img = `face_img_${idx}`;
    const isFallback = ev.fallback === true;
    const fallbackDiameter = Math.max(0.1, Math.min(1, ev.fallbackDiameterNorm || DEFAULT_FACE_EMOJI_FALLBACK_DIAMETER_NORM));
    const cx = isFallback ? 0.5 : Math.max(0, Math.min(1, ev.x + ev.width / 2));
    const cyBase = isFallback ? 0.5 : Math.max(0, Math.min(1, ev.y + ev.height / 2));
    const widthNorm = Math.max(0.02, Math.min(1, ev.width));
    const heightNorm = Math.max(0.02, Math.min(1, ev.height));
    const box = Math.max(widthNorm, heightNorm);
    const cy = Math.max(0, Math.min(1, cyBase + Math.max(-0.25, Math.min(0.25, faceInput.yOffsetNorm || 0)) * box));
    const size = isFallback
      ? `max(48\\,min(720\\,rw*${fallbackDiameter.toFixed(4)}))`
      : `max(48\\,min(720\\,max(rw*${widthNorm.toFixed(4)}\\,rh*${heightNorm.toFixed(4)})*${scale.toFixed(3)}))`;
    const start = (ev.startMs / 1000).toFixed(3);
    const end = (ev.endMs / 1000).toFixed(3);
    chain += `;[${prefix}_png_${idx}]${current}scale2ref=w='${size}':h='${size}'[${img}][${ref}];` +
      `[${ref}][${img}]overlay=x='W*${cx.toFixed(4)}-w/2':y='H*${cy.toFixed(4)}-h/2':enable='between(t\\,${start}\\,${end})':shortest=1[${next}]`;
    current = `[${next}]`;
  });
  return chain;
}

function faceMouthChain(
  inputLabel: string,
  faceInput: FacePrivacyInput | undefined,
  outputLabel: string,
): string {
  if (!faceInput || faceInput.mouthSpeakingInputIndex == null) return "";
  const talkingEvents = speakingMouthPulseEvents(faceInput.events, faceInput.speakingWindows);
  if (talkingEvents.length === 0) return "";
  return faceMouthOverlayChain(inputLabel, faceInput.mouthSpeakingInputIndex, talkingEvents, faceInput, "mouth_talk", outputLabel);
}

function faceMouthOverlayChain(
  inputLabel: string,
  inputIndex: number,
  events: FaceEmojiEvent[],
  faceInput: FacePrivacyInput,
  prefix: string,
  outputLabel: string,
): string {
  if (events.length === 0) return "";
  const splitLabels = events.map((_, idx) => `[${prefix}_png_${idx}]`).join("");
  let chain = `[${inputIndex}:v]format=rgba,split=${events.length}${splitLabels}`;
  let current = inputLabel;
  events.forEach((ev, idx) => {
    const next = idx + 1 === events.length ? outputLabel : `${prefix}_${idx}`;
    const ref = `${prefix}_ref_${idx}`;
    const img = `${prefix}_img_${idx}`;
    const geom = mouthGeometry(ev, faceInput);
    const start = (ev.startMs / 1000).toFixed(3);
    const end = (ev.endMs / 1000).toFixed(3);
    chain += `;[${prefix}_png_${idx}]${current}scale2ref=w='${geom.size}':h='${geom.size}'[${img}][${ref}];` +
      `[${ref}][${img}]overlay=x='W*${geom.cx}-w/2':y='H*${geom.cy}-h/2':enable='between(t\\,${start}\\,${end})':shortest=1[${next}]`;
    current = `[${next}]`;
  });
  return chain;
}

function mouthGeometry(ev: FaceEmojiEvent, faceInput: FacePrivacyInput): { cx: string; cy: string; size: string } {
  const isFallback = ev.fallback === true;
  const fallbackDiameter = Math.max(0.1, Math.min(1, ev.fallbackDiameterNorm || DEFAULT_FACE_EMOJI_FALLBACK_DIAMETER_NORM));
  const widthNorm = Math.max(0.02, Math.min(1, ev.width));
  const heightNorm = Math.max(0.02, Math.min(1, ev.height));
  const box = Math.max(widthNorm, heightNorm);
  const cx = isFallback ? "0.5000" : (Math.max(0, Math.min(1, ev.x + ev.width / 2))).toFixed(4);
  const cyBase = isFallback ? 0.5 : Math.max(0, Math.min(1, ev.y + ev.height / 2));
  const yOffset = Math.max(-0.25, Math.min(0.25, faceInput.yOffsetNorm || 0));
  const mouthCy = Math.max(0, Math.min(1, cyBase + (yOffset + 0.2) * (isFallback ? fallbackDiameter : box)));
  const scale = Math.max(0.5, Math.min(3, faceInput.scale || DEFAULT_FACE_EMOJI_SCALE));
  const size = isFallback
    ? `max(20\\,min(360\\,rw*${(fallbackDiameter * 0.34).toFixed(4)}))`
    : `max(20\\,min(360\\,max(rw*${widthNorm.toFixed(4)}\\,rh*${heightNorm.toFixed(4)})*${(scale * 0.34).toFixed(3)}))`;
  return { cx, cy: mouthCy.toFixed(4), size };
}

function speakingMouthPulseEvents(events: FaceEmojiEvent[], windows: SpeakingWindow[]): FaceEmojiEvent[] {
  if (events.length === 0 || windows.length === 0) return [];
  const out: FaceEmojiEvent[] = [];
  const cycleMs = 220;
  const openMs = 120;
  for (const ev of events) {
    for (const win of windows) {
      const from = Math.max(ev.startMs, win.startMs, 120);
      const to = Math.min(ev.endMs, win.endMs);
      if (to <= from) continue;
      for (let startMs = from; startMs < to; startMs += cycleMs) {
        const endMs = Math.min(to, startMs + openMs);
        if (endMs > startMs) out.push({ ...ev, startMs, endMs });
      }
    }
  }
  return out;
}

async function loadTranscriptWords(root: string): Promise<WordTiming[]> {
  const wordsPath = path.join(root, "transcript.words.json");
  if (!existsSync(wordsPath)) return [];
  try {
    const words = JSON.parse(await readFile(wordsPath, "utf8")) as WordTiming[];
    return Array.isArray(words) ? words.filter(validWordTiming) : [];
  } catch {
    return [];
  }
}

function validWordTiming(w: WordTiming): boolean {
  return w && Number.isFinite(w.startMs) && Number.isFinite(w.endMs) && w.endMs > w.startMs && typeof w.text === "string";
}

function speakingWindowsForClip(
  clip: Clip,
  points: Plan["points"] | undefined,
  transcriptWords: WordTiming[],
): SpeakingWindow[] {
  void points;
  const wordWindows = transcriptWords
    .filter((w) => w.endMs > clip.start_ms && w.startMs < clip.end_ms && w.text.trim())
    .map((w) => ({
      startMs: Math.max(0, w.startMs - clip.start_ms),
      endMs: Math.min(clip.end_ms - clip.start_ms, w.endMs - clip.start_ms),
    }))
    .filter((w) => w.endMs > w.startMs);
  return wordWindows;
}

function faceEmojiEventsForClip(clip: Clip, points: Plan["points"] | undefined): FaceEmojiEvent[] {
  if (!points || points.length === 0) return [fallbackFaceEmojiEventForClip(clip)];
  const sorted = [...points].sort((a, b) => a.ts_ms - b.ts_ms);
  const events: FaceEmojiEvent[] = [];
  let lastFaces: NormalizedVisualRegion[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const point = sorted[i]!;
    if (point.ts_ms >= clip.end_ms) break;
    const nextTs = i + 1 < sorted.length ? sorted[i + 1]!.ts_ms : clip.end_ms;
    const startMs = Math.max(0, point.ts_ms - clip.start_ms);
    const endMs = Math.min(clip.end_ms - clip.start_ms, nextTs - clip.start_ms);
    if (endMs <= 0 || startMs >= clip.end_ms - clip.start_ms) continue;
    const detectedFaces = (point.visual_metadata?.faces ?? []).filter(validRegion);
    if (detectedFaces.length > 0) lastFaces = detectedFaces;
    for (const face of lastFaces) {
      pushOrExtendFaceEmojiEvent(events, { ...face, startMs, endMs });
    }
  }
  return events.length > 0 ? events : [fallbackFaceEmojiEventForClip(clip)];
}

function pushOrExtendFaceEmojiEvent(events: FaceEmojiEvent[], next: FaceEmojiEvent): void {
  const prev = events[events.length - 1];
  if (prev && !prev.fallback && !next.fallback && prev.endMs === next.startMs && similarFaceRegion(prev, next)) {
    prev.endMs = next.endMs;
    return;
  }
  events.push(next);
}

function similarFaceRegion(a: FaceEmojiEvent, b: FaceEmojiEvent): boolean {
  const acx = a.x + a.width / 2;
  const acy = a.y + a.height / 2;
  const bcx = b.x + b.width / 2;
  const bcy = b.y + b.height / 2;
  return Math.abs(acx - bcx) <= 0.035 &&
    Math.abs(acy - bcy) <= 0.035 &&
    Math.abs(a.width - b.width) <= 0.06 &&
    Math.abs(a.height - b.height) <= 0.06;
}

function fallbackFaceEmojiEventForClip(clip: Clip): FaceEmojiEvent {
  return {
    x: 0.5,
    y: 0.5,
    width: 0,
    height: 0,
    startMs: 0,
    endMs: Math.max(0, clip.end_ms - clip.start_ms),
    fallback: true,
    fallbackDiameterNorm: DEFAULT_FACE_EMOJI_FALLBACK_DIAMETER_NORM,
  };
}

function validRegion(r: NormalizedVisualRegion): boolean {
  return Number.isFinite(r.x) && Number.isFinite(r.y) &&
    Number.isFinite(r.width) && Number.isFinite(r.height) &&
    r.width > 0.01 && r.height > 0.01;
}

function distributeCues(lines: string[], clipDurationMs: number): Cue[] {
  const per = clipDurationMs / lines.length;
  return lines.map((text, i) => ({
    startMs: Math.round(i * per),
    endMs: Math.round((i + 1) * per),
    text: text.trim(),
  }));
}

// Build cues from the plan's source-timed points, anchored to the clip range.
// Each cue's start is the point's source ts converted to clip-local ms. Cues are
// included by source timestamp, not point index, because Shift-dragged markers
// intentionally clear start_point/end_point and can land between moments.
function pointCuesForClip(clip: Clip, points: Plan["points"]): Cue[] {
  if (!points || points.length === 0) return [];
  const inRange = points
    .filter((p) => p.ts_ms >= clip.start_ms && p.ts_ms < clip.end_ms)
    .sort((a, b) => a.ts_ms - b.ts_ms);
  if (inRange.length === 0) return [];
  const clipDur = clip.end_ms - clip.start_ms;
  const cues: Cue[] = [];
  for (let i = 0; i < inRange.length; i++) {
    const p = inRange[i]!;
    const text = (p.caption ?? "").trim();
    if (!text) continue;
    const next = nextPointAfter(points, p.ts_ms);
    const rawStart = p.ts_ms - clip.start_ms;
    const rawEnd = next ? next.ts_ms - clip.start_ms : clipDur;
    const startMs = Math.max(0, Math.min(clipDur, rawStart));
    const endMs = Math.max(startMs + 1, Math.min(clipDur, rawEnd));
    cues.push({ startMs, endMs, text });
  }
  return cues;
}

function nextPointAfter(points: NonNullable<Plan["points"]>, tsMs: number): Point | undefined {
  let best: Point | undefined;
  for (const p of points) {
    if (p.ts_ms <= tsMs) continue;
    if (!best || p.ts_ms < best.ts_ms) best = p;
  }
  return best;
}

// Greedy-split a cue's text into chunks that each fit within `maxChars`,
// distributing the cue's duration evenly across the chunks. Returns the
// original cue unchanged if it already fits or can't be split (single long word).
function splitLongCue(cue: Cue, maxChars: number): Cue[] {
  if (cue.text.length <= maxChars) return [cue];
  const words = cue.text.split(/\s+/);
  const chunks: string[] = [];
  let cur = "";
  for (const w of words) {
    if (!cur) { cur = w; continue; }
    if (cur.length + 1 + w.length > maxChars) {
      chunks.push(cur);
      cur = w;
    } else {
      cur = cur + " " + w;
    }
  }
  if (cur) chunks.push(cur);
  if (chunks.length <= 1) return [cue];
  const dur = cue.endMs - cue.startMs;
  const per = dur / chunks.length;
  return chunks.map((text, i) => ({
    startMs: cue.startMs + Math.round(i * per),
    endMs: i + 1 < chunks.length ? cue.startMs + Math.round((i + 1) * per) : cue.endMs,
    text,
  }));
}

function parseSrtToCues(srt: string): Cue[] {
  const cues: Cue[] = [];
  for (const entry of srt.replace(/\r\n/g, "\n").split(/\n\n+/)) {
    const lines = entry.split("\n").filter(Boolean);
    const tsLine = lines.find((l) => /-->/.test(l));
    if (!tsLine) continue;
    const [a, b] = tsLine.split("-->").map((x) => parseSrtTs(x.trim()));
    const text = lines.slice(lines.indexOf(tsLine) + 1).join("\n");
    cues.push({ startMs: a, endMs: b, text });
  }
  return cues;
}

function cuesToAss(
  cues: Cue[],
  style: string,
  animation: "static" | "word-pop" | "word-highlight",
  words?: WordTiming[],
): string {
  const normalizedStyle = normalizeCaptionStyle(style);
  const tail = ASS_STYLES[normalizedStyle] ?? ASS_STYLES["bold-white-bottom"]!;
  const events: string[] = [];
  for (const c of cues) {
    const text = c.text.trim();
    if (!text) continue;
    if (normalizedStyle === "karaoke-bottom" || normalizedStyle === "karaoke-top") {
      const ev = buildKaraokeDialogue(c, wordsInCue(words, c));
      if (ev) events.push(ev);
      continue;
    }
    if (animation === "word-highlight") {
      events.push(...buildWordHighlightDialogues(c, wordsInCue(words, c)));
      continue;
    }
    if (animation === "word-pop") {
      // Brisk typing rhythm (~280 ms/word, ~3.5 words/sec). If the cue is too short to
      // fit that pace, fall back to evenly distributing across the cue. The final word
      // event always extends to the cue end so the full line lingers for the viewer.
      const WORD_POP_PER_WORD_MS = 280;
      const words = text.split(/\s+/);
      const cueDur = c.endMs - c.startMs;
      const per = Math.min(WORD_POP_PER_WORD_MS, cueDur / words.length);
      for (let i = 0; i < words.length; i++) {
        const wStart = c.startMs + Math.round(i * per);
        const wEnd =
          i + 1 < words.length ? c.startMs + Math.round((i + 1) * per) : c.endMs;
        const visible = words.slice(0, i + 1).join(" ");
        events.push(
          `Dialogue: 0,${fmtAssTs(wStart)},${fmtAssTs(wEnd)},Default,,0,0,0,,${escapeAssText(visible)}`,
        );
      }
    } else {
      events.push(
        `Dialogue: 0,${fmtAssTs(c.startMs)},${fmtAssTs(c.endMs)},Default,,0,0,0,,${escapeAssText(text)}`,
      );
    }
  }
  return `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${tail}

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${events.join("\n")}
`;
}

// Build one Dialogue per word's "active" range showing the FULL cue text but
// with the active word scaled up via inline {\fscx120\fscy120} overrides.
// Falls back to evenly distributing the cue's tokens if no word timing is given.
function buildWordHighlightDialogues(c: Cue, cueWords: WordTiming[]): string[] {
  type Part = { startMs: number; text: string };
  let parts: Part[];
  if (cueWords.length > 0) {
    parts = cueWords.map((w) => ({ startMs: w.startMs, text: w.text }));
  } else {
    const tokens = c.text.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return [];
    const per = (c.endMs - c.startMs) / tokens.length;
    parts = tokens.map((t, i) => ({ startMs: c.startMs + Math.round(i * per), text: t }));
  }
  if (parts.length === 0) return [];
  const tokens = parts.map((p) => p.text.replace(/[{}]/g, ""));
  const events: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const wStart = parts[i]!.startMs;
    const wEnd = i + 1 < parts.length ? parts[i + 1]!.startMs : c.endMs;
    const rendered = tokens
      .map((tok, idx) => (idx === i ? `{\\fscx120\\fscy120\\b1}${tok}{\\r}` : tok))
      .join(" ");
    events.push(`Dialogue: 0,${fmtAssTs(wStart)},${fmtAssTs(wEnd)},Default,,0,0,0,,${rendered}`);
  }
  return events;
}

function wordsInCue(all: WordTiming[] | undefined, c: Cue): WordTiming[] {
  if (!all || all.length === 0) return [];
  return all.filter((w) => w.endMs > c.startMs && w.startMs < c.endMs);
}

// Build a single ASS Dialogue event with \k<cs> per word for the karaoke wipe.
// If real word timings (from transcript.words.json) aren't available for this cue,
// falls back to evenly distributing the cue text's words within the cue duration.
function buildKaraokeDialogue(c: Cue, cueWords: WordTiming[]): string {
  type Part = { startMs: number; text: string };
  let parts: Part[];
  if (cueWords.length > 0) {
    parts = cueWords.map((w) => ({ startMs: w.startMs, text: w.text }));
  } else {
    const tokens = c.text.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return "";
    const per = (c.endMs - c.startMs) / tokens.length;
    parts = tokens.map((t, i) => ({ startMs: c.startMs + Math.round(i * per), text: t }));
  }
  if (parts.length === 0) return "";
  const dialogStart = parts[0]!.startMs;
  const segments: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const w = parts[i]!;
    const nextStart = i + 1 < parts.length ? parts[i + 1]!.startMs : c.endMs;
    const durMs = Math.max(20, nextStart - w.startMs);
    const durCs = Math.max(2, Math.round(durMs / 10));
    // Strip braces from word text — they'd otherwise be parsed as ASS overrides.
    const wordText = w.text.replace(/[{}]/g, "");
    segments.push(`{\\k${durCs}}${wordText}`);
  }
  return `Dialogue: 0,${fmtAssTs(dialogStart)},${fmtAssTs(c.endMs)},Default,,0,0,0,,${segments.join(" ")}`;
}

export function fmtAssTs(ms: number): string {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const cs = Math.floor((ms % 1000) / 10);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

function escapeAssText(t: string): string {
  return t.replace(/\n/g, "\\N").replace(/\{/g, "\\{").replace(/\}/g, "\\}");
}

function escapeFilterPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

function ffmpegFailureMessage(code: number | null, spawnError: Error | undefined, stderr: string): string {
  if (spawnError) return `ffmpeg failed to start: ${spawnError.message}`;
  const base = `ffmpeg exited ${code === null ? "with error" : code}`;
  const detail = summarizeFfmpegStderr(stderr);
  return detail ? `${base}: ${detail}` : base;
}

function summarizeFfmpegStderr(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^frame=\s*\d+/.test(line));
  return lines.slice(-4).join(" ").slice(0, 1000);
}

function slug(s: string): string {
  const out = s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50);
  return out || "clip";
}

// Slice an SRT to [startMs, endMs] and rebase timestamps so the clip starts at 0.
export function sliceSrt(src: string, startMs: number, endMs: number): string {
  const blocks: string[] = [];
  let n = 0;
  for (const entry of src.replace(/\r\n/g, "\n").split(/\n\n+/)) {
    const lines = entry.split("\n").filter(Boolean);
    const tsLine = lines.find((l) => /-->/.test(l));
    if (!tsLine) continue;
    const [aRaw, bRaw] = tsLine.split("-->").map((x) => x.trim());
    const a = parseSrtTs(aRaw);
    const b = parseSrtTs(bRaw);
    if (b <= startMs || a >= endMs) continue;
    const newA = Math.max(0, a - startMs);
    const newB = Math.min(endMs, b) - startMs;
    const text = lines.slice(lines.indexOf(tsLine) + 1).join("\n");
    n += 1;
    blocks.push(`${n}\n${fmtSrtTs(newA)} --> ${fmtSrtTs(newB)}\n${text}`);
  }
  return blocks.length ? blocks.join("\n\n") + "\n" : "";
}

function parseSrtTs(s: string): number {
  const m = s.match(/(\d+):(\d+):(\d+)[,.](\d+)/);
  if (!m) return 0;
  return +m[1]! * 3600000 + +m[2]! * 60000 + +m[3]! * 1000 + +m[4]!;
}

function fmtSrtTs(ms: number): string {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const ms3 = ms % 1000;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms3).padStart(3, "0")}`;
}
