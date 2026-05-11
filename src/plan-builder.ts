import { mkdir, readdir, readFile, writeFile, copyFile, link, unlink, rename } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveProject, sourceVideoPath } from "./projectFolder.js";
import { suggestClips } from "./suggest.js";
import { runProc } from "./run.js";
import { getFfmpegPath, getFfprobePath, resolveFfmpegPath } from "./ffmpeg.js";
import { ASS_STYLES, fmtAssTs, normalizeCaptionStyle, targetDims, type Point } from "./shorts.js";
import { config } from "./config.js";
import {
  DEFAULT_FACE_EMOJI,
  DEFAULT_FACE_EMOJI_FALLBACK_DIAMETER_NORM,
  DEFAULT_FACE_EMOJI_SCALE,
  FACE_EMOJI_NONE,
  FACE_EMOJI_OPTIONS,
  faceEmojiAssetUrl,
  faceMouthAssetUrl,
  normalizeFaceEmojiSelection,
} from "./face-emojis.js";
import { DEFAULT_TTS_VOICE, listTtsVoices, type TtsVoice } from "./voiceover.js";
import {
  CACHE_SCHEMA_VERSION,
  cacheKey,
  cachePath,
  ensureCacheMarker,
  fileSig,
  getOrCompute,
  srcSignature,
} from "./asset-cache.js";
import {
  cleanupTranscriptText,
  firstWordsFromTranscript,
  joinRawTranscriptWords,
} from "./transcript-text.js";
import { PROJECT_META_FILE, type ProjectMeta } from "./project-v2.js";

const RUNTIME_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLAN_UI_CACHE_VERSION = "plan-ui-v52";
const PACKAGE_ROOT = path.resolve(RUNTIME_DIR, "..");

const FALLBACK_ILLUSTRATION_PROMPT_TEMPLATE = `Goal: Create one self-contained animated explanatory graphic for the selected video span.

Clip:
{{clip_title}}

Duration:
About {{duration_seconds}} seconds.

Full source captions for context:
{{clip_script}}

Selected span to illustrate:
{{moments}}

Visual type:
{{visual_type}}

Visual items:
{{visual_items}}

Visual brief:
{{visual_brief}}

Rules:
- Use exactly one visual type for now: graph or list.
- Graph: show a chart, bars, counter, dashboard, or metric signal. If the captions contain numbers, units, percentages, dates, rates, or quantities, use them as readable labels.
- List: show 2-4 key ideas, priorities, contrasts, or ordered points as large readable cards. Extract meaning from the source context, not only repeated words in the selected span.
- Do not paste the spoken sentence as a headline. Use graphics first, with only short labels from Visual items when needed.
- Do not make word clouds or keyword chips unless they are meaningful labels for a list item.
- Keep the composition portrait-safe, high contrast, and simple enough to understand while the original audio plays.
- Future visual types that are useful but not for this render: flow/process diagram, comparison/before-after.

Style:
Modern animated explainer, clear symbolic shapes, intentional motion, no photorealistic people, no clutter, no duplicate caption text.`;

function illustrationPromptTemplatePath(): string {
  const configured = config.illustrationPromptTemplatePath || "";
  if (configured.trim()) {
    return path.isAbsolute(configured) ? configured : path.join(PACKAGE_ROOT, configured);
  }
  return path.join(PACKAGE_ROOT, "config", "illustration-prompt-template.md");
}

function loadIllustrationPromptTemplate(): string {
  const candidates = [
    illustrationPromptTemplatePath(),
    path.join(RUNTIME_DIR, "templates", "illustration-prompt-template.md"),
  ];
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return readFileSync(candidate, "utf8").trim();
    } catch {
      // Fall through to the built-in template.
    }
  }
  return FALLBACK_ILLUSTRATION_PROMPT_TEMPLATE;
}

// Caption style choices surfaced in the UI. Placement is explicit so preview
// and final ASS rendering cannot disagree about top vs. bottom captions.
const ALL_STYLES = [
  "bold-white-bottom",
  // "bold-white-top",
  "tiktok-yellow-bottom",
  // "tiktok-yellow-top",
  "beast-impact-bottom",
  // "beast-impact-top",
  "karaoke-bottom",
  // "karaoke-top",
  "creator-thin-bottom",
  // "creator-thin-top",
  "neon-bottom",
  // "neon-top",
  "pastel-bottom",
  // "pastel-top",
  "plain-bottom",
  // "plain-top",
];

function styleBase(style: string): string {
  return normalizeCaptionStyle(style).replace(/-(top|bottom)$/, "");
}

function styleLabel(style: string): string {
  const normalized = normalizeCaptionStyle(style);
  const placement = normalized.endsWith("-top") ? "top" : "bottom";
  const base = styleBase(normalized).replace(/-/g, " ");
  return `${base} ${placement}`;
}

function normalizeFaceBlur(value: unknown): "none" | "soft" | "strong" {
  return value === "soft" || value === "strong" ? value : "none";
}

type Suggestion = {
  id: string;
  start_ms: number;
  end_ms: number;
  title: string;
  reason: string;
  score: number;
  // Per-clip overrides — populated when an existing plan.json carries
  // them so the UI seeds the ⚙ Settings popover correctly. Empty
  // strings mean "use the global default from config.renderDefaults".
  caption_style?: string;
  caption_animation?: string;
  reframe?: string;
  crop_x_norm?: number;
  face_emoji_enabled?: boolean;
  face_emoji?: string;
  face_blur?: string;
  face_imitate_speaking?: boolean;
  voiceover_enabled?: boolean;
  voiceover_voice?: string;
  render_title?: string;
  start_point?: number;
  end_point?: number;
  saved?: boolean;
};

// Hash of every input that affects the rendered plan.html. Used both to short-circuit
// rebuilds when nothing changed and to give buildPlanUi a stable on-disk planDir
// (so closing/reopening the plan tab — or restarting the hub — is a cache hit
// instead of another ffmpeg burst).
function planInputsKey(root: string, src: string): string {
  return cacheKey({
    v: CACHE_SCHEMA_VERSION,
    ui: PLAN_UI_CACHE_VERSION,
    src: srcSignature(src),
    transcript: fileSig(path.join(root, "transcript.json")),
    suggestions: fileSig(path.join(root, "shorts", "suggestions.json")),
    plan: fileSig(path.join(root, "shorts", "plan.json")),
    moments: fileSig(path.join(root, "analysis", "moments.json")),
    videoJson: fileSig(path.join(root, "video.json")),
    matchMeta: fileSig(path.join(root, ".match-meta.json")),
    styles: ALL_STYLES.join(","),
    localTailwind: fileSig(path.join(RUNTIME_DIR, "assets", "tailwind.css")) ?? "local-tailwind-v1",
    illustrationPromptTemplatePath: illustrationPromptTemplatePath(),
    illustrationPromptTemplate: fileSig(illustrationPromptTemplatePath()) ?? "illustration-prompt-template-v1",
  });
}

// Hub uses this on a cold start (planDirs Map empty) to find an
// already-built plan.html on disk for /p/<projectSlug>/<videoSlug>/...
// without rebuilding. Returns the planDir if plan.html is fresh; null otherwise.
export async function resolvePlanDirIfFresh(projectPath: string): Promise<string | null> {
  const root = await resolveProject(projectPath);
  const src = await sourceVideoPath(root);
  const key = planInputsKey(root, src);
  const planDir = cachePath(root, "plan-ui", key, "");
  if (existsSync(path.join(planDir, "plan.html"))) return planDir;
  return null;
}

export async function buildPlanUi(projectPath: string): Promise<string> {
  const root = await resolveProject(projectPath);
  const src = await sourceVideoPath(root);
  const srcDuration = await probeDurationMs(src);

  // Short-circuit: if a plan.html already exists for this exact input set,
  // serve it as-is — no ffmpeg, no whisper, no buildHtml. Inputs are hashed
  // by mtime+size of every file the build reads.
  const planKey = planInputsKey(root, src);
  const planDir = cachePath(root, "plan-ui", planKey, "");
  const cachedPlanHtml = path.join(planDir, "plan.html");
  if (existsSync(cachedPlanHtml)) return cachedPlanHtml;

  let videoTitle = path.basename(src);
  const videoJsonForTitle = path.join(root, "video.json");
  if (existsSync(videoJsonForTitle)) {
    try {
      const desc = JSON.parse(await readFile(videoJsonForTitle, "utf8")) as {
        filename?: string;
        title?: string;
        titleEditedAt?: string;
      };
      if (desc.titleEditedAt && desc.title) videoTitle = desc.title;
      else if (desc.filename) videoTitle = desc.filename;
    } catch { /* malformed video.json — keep normalized working filename */ }
  }

  // Ensure suggestions exist
  const suggestionsPath = path.join(root, "shorts", "suggestions.json");
  if (!existsSync(suggestionsPath)) {
    await suggestClips(projectPath, { count: 5 });
  }
  const clipTitlePrefix = defaultClipTitlePrefix(videoTitle);
  let suggestions: Suggestion[] = JSON.parse(await readFile(suggestionsPath, "utf8")).clips;
  ensureFullVideoSuggestion(suggestions, srcDuration);
  // Carry the existing plan.json's per-clip render settings forward
  // (filled in below if a v2 plan.json is on disk). Set on the
  // suggestion so buildHtml's clipCardHtml emits the right data-*
  // attributes for the card's ⚙ Settings popover.

  // Build the plan's "points" — one per analysis moment. Each point owns a
  // caption (default = the moment's transcript text) and references its
  // keyframe file so the plan UI can show a thumbnail next to every caption row.
  const points: Point[] = [];
  const pointFrames: Record<number, string> = {};
  const analysisPath = path.join(root, "analysis", "moments.json");
  if (existsSync(analysisPath)) {
    try {
      const analysis = JSON.parse(await readFile(analysisPath, "utf8"));
      for (const m of analysis.moments ?? []) {
        const originalText = m.original_text ?? m.transcript_text ?? "";
        const caption = tidyTranscript(m.transcript_text ?? originalText);
        points.push({ index: m.index, ts_ms: m.ts_ms, original_text: originalText, caption, visual_metadata: m.visual_metadata });
        // Frame path is relative to the project; the server exposes it under
        // /keyframes/<basename>. Just store the basename for the JS to use.
        if (typeof m.frame === "string") {
          pointFrames[m.index] = path.basename(m.frame);
        }
      }
    } catch { /* malformed analysis — skip */ }
  }

  // Word-level transcript (whisper output) used by the live caption
  // overlay to render TikTok-style 2-3 word phrases timed to actual
  // speech. Populated for v2 videos from video.json; v1 leaves empty
  // and the overlay falls back to point-windows.
  let transcriptWords: Array<{ startMs: number; endMs: number; text: string }> = [];

  // v2 fallback: when analyzeVideo hasn't run, fall back to video.json's
  // describe-time moments (one thumbnail every 8s) + a sentence-window of
  // transcript.words[] around each moment for caption text. Source
  // thumbnails live under the parent project's _sources/ folder; we
  // hardlink them into <videoSubproject>/analysis/keyframes/ so the
  // existing /keyframes/<file> route serves them as-is.
  if (points.length === 0) {
    const videoJsonPath = path.join(root, "video.json");
    if (existsSync(videoJsonPath)) {
      try {
        const desc = JSON.parse(await readFile(videoJsonPath, "utf8")) as {
          moments?: Array<{ ts_ms: number; thumbnail?: string; text?: string; original_text?: string; visual_metadata?: Point["visual_metadata"] }>;
          transcript?: { words?: Array<{ startMs: number; endMs: number; text: string }> };
        };
        const moments = desc.moments ?? [];
        const words = desc.transcript?.words ?? [];
        transcriptWords = words;
        if (moments.length > 0) {
          const keyframesDir = path.join(root, "analysis", "keyframes");
          await mkdir(keyframesDir, { recursive: true });
          const projectRoot = path.dirname(root);
          const videoSlug = path.basename(root);
          const sourceThumbsDir = path.join(projectRoot, "_sources", videoSlug, "thumbs");
          for (let i = 0; i < moments.length; i++) {
            const m = moments[i]!;
            const idx = i + 1;
            // Caption: collect words from this moment's ts_ms up to (but
            // not including) the next moment's ts_ms. Gives full
            // sentence-ish text per row instead of a single word.
            const nextTs = i + 1 < moments.length ? moments[i + 1]!.ts_ms : Number.POSITIVE_INFINITY;
            const captionWords: string[] = [];
            for (const w of words) {
              if (w.startMs >= nextTs) break;
              if (w.endMs >= m.ts_ms) captionWords.push(w.text);
            }
            const rawFromWords = joinRawTranscriptWords(captionWords.map((text) => ({ text })));
            const rawCaption = m.original_text || rawFromWords || m.text || "";
            const momentTextLooksComplete = (m.text ?? "").trim().split(/\s+/).filter(Boolean).length >= 3;
            const caption = tidyTranscript(momentTextLooksComplete ? (m.text ?? "") : rawCaption);
            points.push({ index: idx, ts_ms: m.ts_ms, original_text: rawCaption, caption, visual_metadata: m.visual_metadata });
            const srcThumb = path.join(sourceThumbsDir, `${m.ts_ms}.jpg`);
            const dstName = `frame-${String(idx).padStart(3, "0")}-${m.ts_ms}ms.jpg`;
            const dstThumb = path.join(keyframesDir, dstName);
            if (existsSync(srcThumb) && !existsSync(dstThumb)) {
              try { await link(srcThumb, dstThumb); }
              catch { try { await copyFile(srcThumb, dstThumb); } catch { /* skip */ } }
            }
            if (existsSync(dstThumb)) pointFrames[idx] = dstName;
          }
        }
      } catch { /* malformed video.json — skip */ }
    }
  }
  ensureBoundaryPoints(points, pointFrames, srcDuration);

  // Archive any pre-v2 plan.json on first open of the new UI so we start fresh
  // from suggestions + points. Renderer keeps reading start_ms/end_ms from
  // whatever plan exists; the UI writes v2 from now on.
  // We also remember per-clip render overrides (caption_style /
  // caption_animation / reframe) keyed by clip id, so re-opening the
  // plan UI restores what the user picked on each card's ⚙ Settings.
  const existingPlanPath = path.join(root, "shorts", "plan.json");
  const existingClipOverrides = new Map<string, {
    caption_style?: string;
    caption_animation?: string;
    reframe?: string;
    crop_x_norm?: number;
    face_emoji_enabled?: boolean;
    face_emoji?: string;
    face_blur?: string;
    face_imitate_speaking?: boolean;
    voiceover_enabled?: boolean;
    voiceover_voice?: string;
    render_title?: string;
  }>();
  let existingPlanPoints: Point[] = [];
  let savedPlanClips: Suggestion[] | null = null;
  if (existsSync(existingPlanPath)) {
    try {
      const existing = JSON.parse(await readFile(existingPlanPath, "utf8")) as {
        version?: number;
        points?: Point[];
        clips?: Array<{
          id?: string;
          start_ms?: number;
          end_ms?: number;
          start_point?: number;
          end_point?: number;
          title?: string;
          reason?: string;
          score?: number;
          caption_style?: string;
          caption_animation?: string;
          reframe?: string;
          crop_x_norm?: number;
          face_emoji_enabled?: boolean;
          face_emoji?: string;
          face_blur?: string;
          face_imitate_speaking?: boolean;
          voiceover_enabled?: boolean;
          voiceover_voice?: string;
          render_title?: string;
        }>;
      };
      if (existing.version !== 2) {
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        await rename(existingPlanPath, path.join(root, "shorts", `plan.legacy-${stamp}.json`));
      } else {
        existingPlanPoints = Array.isArray(existing.points) ? existing.points : [];
        const savedClips: Suggestion[] = [];
        for (const c of existing.clips ?? []) {
          if (!c.id) continue;
          if (Number.isFinite(c.start_ms) && Number.isFinite(c.end_ms) && Number(c.end_ms) > Number(c.start_ms)) {
            savedClips.push({
              id: c.id,
              start_ms: Number(c.start_ms),
              end_ms: Number(c.end_ms),
              start_point: typeof c.start_point === "number" ? c.start_point : undefined,
              end_point: typeof c.end_point === "number" ? c.end_point : undefined,
              title: c.title || defaultClipTitle(clipTitlePrefix, `Clip ${savedClips.length + 1}`),
              reason: c.reason || "saved clip",
              score: typeof c.score === "number" ? c.score : 1,
              caption_style: c.caption_style,
              caption_animation: c.caption_animation,
              reframe: c.reframe,
              crop_x_norm: typeof c.crop_x_norm === "number" ? c.crop_x_norm : undefined,
              face_emoji_enabled: c.face_emoji_enabled,
              face_emoji: c.face_emoji,
              face_blur: c.face_blur,
              face_imitate_speaking: c.face_imitate_speaking,
              voiceover_enabled: c.voiceover_enabled,
              voiceover_voice: c.voiceover_voice,
              render_title: c.render_title,
              saved: true,
            });
          }
          existingClipOverrides.set(c.id, {
            caption_style: c.caption_style,
            caption_animation: c.caption_animation,
            reframe: c.reframe,
            crop_x_norm: typeof c.crop_x_norm === "number" ? c.crop_x_norm : undefined,
            face_emoji_enabled: c.face_emoji_enabled,
            face_emoji: c.face_emoji,
            face_blur: c.face_blur,
            face_imitate_speaking: c.face_imitate_speaking,
            voiceover_enabled: c.voiceover_enabled,
            voiceover_voice: c.voiceover_voice,
            render_title: c.render_title,
          });
        }
        if (savedClips.length > 0) savedPlanClips = savedClips;
      }
    } catch { /* unreadable — leave it */ }
  }
  mergeExistingPointEdits(points, existingPlanPoints);
  if (savedPlanClips) {
    suggestions = savedPlanClips;
  } else {
    for (const s of suggestions) {
      const ov = existingClipOverrides.get(s.id);
      if (!ov) continue;
      if (ov.caption_style) s.caption_style = ov.caption_style;
      if (ov.caption_animation) s.caption_animation = ov.caption_animation;
      if (ov.reframe) s.reframe = ov.reframe;
      if (typeof ov.crop_x_norm === "number") s.crop_x_norm = ov.crop_x_norm;
      if (ov.face_emoji_enabled != null) s.face_emoji_enabled = ov.face_emoji_enabled;
      if (ov.face_emoji) s.face_emoji = ov.face_emoji;
      if (ov.face_blur) s.face_blur = ov.face_blur;
      if (ov.face_imitate_speaking != null) s.face_imitate_speaking = ov.face_imitate_speaking;
      if (ov.voiceover_enabled != null) s.voiceover_enabled = ov.voiceover_enabled;
      if (ov.voiceover_voice) s.voiceover_voice = ov.voiceover_voice;
      if (ov.render_title) s.render_title = ov.render_title;
    }
  }
  for (const s of suggestions) {
    if (typeof s.crop_x_norm !== "number") {
      const x = faceFocusedCropX(s, points);
      if (typeof x === "number") s.crop_x_norm = x;
    }
  }

  // Transcript for caption pre-fill
  let transcript: { transcription?: Array<{ offsets?: { from?: number; to?: number }; text?: string }> } | null = null;
  const transcriptPath = path.join(root, "transcript.json");
  if (existsSync(transcriptPath)) {
    transcript = JSON.parse(await readFile(transcriptPath, "utf8"));
  }

  // planDir is the stable cache path computed at the top of this function.
  // Re-opens with identical inputs short-circuit before reaching this point;
  // a miss lands in the same dir so per-frame caches in
  // <videoSubproject>/cache/{clip-frame,style-thumb}/ are reusable.
  await mkdir(planDir, { recursive: true });
  await ensureCacheMarker(root);
  await copyTailwindCss(planDir);

  // Bring the source mp4 into the plan dir (hardlink → copy fallback)
  const localSrc = path.join(planDir, "source.mp4");
  try {
    await link(src, localSrc);
  } catch {
    await copyFile(src, localSrc);
  }

  // Per-clip key-moment preview strip: 4 frames evenly spaced across each clip's range.
  // Lets the user see what actually happens INSIDE the clip, not just one mid-frame.
  // Cached on disk per (src signature, clipId, range, n, frame index) — re-opens are no-ops.
  const clipFrames: Record<string, string[]> = {};
  for (const c of suggestions) {
    clipFrames[c.id] = await renderClipFrames(src, c, 4, root);
  }

  // Bucket transcript sentences into 4 chronological frame-aligned cells per clip.
  // Each cell pairs a thumbnail with the captions that fall in its time range.
  const clipCaptionBuckets: Record<string, string[][]> = {};
  for (const c of suggestions) {
    clipCaptionBuckets[c.id] = bucketCaptions(transcript, c.start_ms, c.end_ms, 4);
  }
  // Flat caption text for the swatch sample (first non-empty bucket's first line).
  const clipCaptions: Record<string, string[]> = {};
  for (const c of suggestions) {
    clipCaptions[c.id] = clipCaptionBuckets[c.id]!.flat();
  }

  // Per-clip style preview frames: each clip's 8 swatches render the clip's midpoint
  // frame with that clip's first caption text — so the user sees how each style
  // looks on THIS clip's content, not on a shared sample frame.
  const clipStyleThumbs: Record<string, Record<string, string>> = {};
  for (const c of suggestions) {
    const midSec = (((c.start_ms + c.end_ms) / 2) / 1000).toFixed(3);
    const sampleText = pickSwatchText(clipCaptions[c.id], c.title);
    clipStyleThumbs[c.id] = {};
    for (const style of ALL_STYLES) {
      clipStyleThumbs[c.id][style] = await renderStylePreview(src, c, midSec, style, sampleText, root);
    }
  }

  // Look for an "original" backup of the working video so the plan UI
  // can offer a Replaced-audio | Original toggle. backup.ts writes
  // <root>/_backup/video-<YYYYMMDD-HHMMSS>.<ext>; we just take the
  // newest one (sorted alphabetically — the timestamp suffix sorts
  // chronologically). originalUrl is absolute so the <base> mount
  // doesn't rewrite it; the existing /v2-source/ route serves it.
  let originalSrcUrl: string | undefined;
  const backupDir = path.join(root, "_backup");
  if (existsSync(backupDir)) {
    const ents = (await readdir(backupDir)).filter((n) => /^video-.*\.(mp4|mov|m4v|webm|mkv|avi)$/i.test(n)).sort();
    const newest = ents[ents.length - 1];
    if (newest) {
      const projectSlug = path.basename(path.dirname(root));
      const videoSlug = path.basename(root);
      originalSrcUrl = `/v2-source/${encodeURIComponent(projectSlug)}/${encodeURIComponent(videoSlug)}/_backup/${encodeURIComponent(newest)}`;
    }
  }

  // Read the match marker (written by auto-match / replace-audio) so
  // the source-video card can display "use audio from <name>" with
  // the actual audio filename. Falls back to undefined when no match
  // has been applied yet.
  let matchedAudioName: string | undefined;
  const matchMetaPath = path.join(root, ".match-meta.json");
  if (existsSync(matchMetaPath)) {
    try {
      const mm = JSON.parse(await readFile(matchMetaPath, "utf-8")) as { audioOriginalName?: string };
      matchedAudioName = mm.audioOriginalName;
    } catch { /* malformed marker — leave undefined */ }
  }

  // Available audio files in the parent project's _sources/. Used by
  // the "Replace audio from a track…" picker when no match exists.
  const availableAudios: string[] = [];
  const projectRoot = path.dirname(root);
  const sourcesDir = path.join(projectRoot, "_sources");
  if (existsSync(sourcesDir)) {
    const audioExts = new Set([".m4a", ".mp3", ".wav", ".aac", ".flac", ".ogg", ".opus", ".aiff", ".aif"]);
    for (const e of await readdir(sourcesDir)) {
      const ext = path.extname(e).toLowerCase();
      if (audioExts.has(ext)) availableAudios.push(e);
    }
    availableAudios.sort();
  }
  const ttsVoices = await listTtsVoices().catch(() => [] as TtsVoice[]);
  const aiSceneAnalysis = await readParentAiSceneAnalysis(root);

  const html = buildHtml({
    videoTitle,
    clipTitlePrefix,
    suggestions,
    clipFrames,
    clipStyleThumbs,
    clipCaptionBuckets,
    projectPath: root,
    sourceDurationMs: srcDuration,
    points,
    pointFrames,
    transcriptWords,
    originalSrcUrl,
    matchedAudioName,
    availableAudios,
    ttsVoices,
    aiSceneAnalysis,
  });

  const outPath = path.join(planDir, "plan.html");
  await writeFile(outPath, html);
  return outPath;
}

// ─────────── helpers ───────────

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function defaultClipTitlePrefix(videoTitle: string): string {
  const trimmed = videoTitle.trim();
  if (!trimmed) return "source";
  const parsed = path.parse(trimmed);
  const base = parsed.ext ? parsed.name : trimmed;
  const ext = parsed.ext ? parsed.ext.slice(1).toLowerCase() : "";
  const named = ext ? `${base}_${ext}` : base;
  return named
    .replace(/[\s.]+/g, "_")
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "") || "source";
}

function defaultClipTitle(prefix: string, title: string): string {
  const cleanPrefix = prefix.trim();
  const cleanTitle = title.trim() || "Clip";
  if (!cleanPrefix) return cleanTitle;
  if (cleanTitle.startsWith(`${cleanPrefix} - `)) return cleanTitle;
  return `${cleanPrefix} - ${cleanTitle}`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function copyTailwindCss(planDir: string): Promise<void> {
  const dst = path.join(planDir, "tailwind.css");
  const src = path.join(RUNTIME_DIR, "assets", "tailwind.css");
  if (existsSync(src)) {
    await copyFile(src, dst);
    return;
  }
  await writeFile(dst, "/* Tailwind CSS asset missing. Run npm run build. */\n");
}

// Short sample text for the style swatch — first sentence of the captions,
// trimmed to fit on one line. Falls back to clip title or "Sample".
function pickSwatchText(captions: string[] | undefined, fallback: string): string {
  const first = (captions?.[0] ?? "").trim();
  if (first) {
    const sentence = first.split(/[.!?]/)[0]!.trim();
    const short = sentence.split(/\s+/).slice(0, 4).join(" ");
    if (short.length >= 3) return short;
  }
  const f = (fallback ?? "").trim().slice(0, 22);
  return f || "Sample text";
}

// Distribute transcript sentences in [startMs, endMs] into n chronological buckets
// based on each sentence's midpoint. Returns n string[] (one per bucket).
function bucketCaptions(
  t: { transcription?: Array<{ offsets?: { from?: number; to?: number }; text?: string }> } | null,
  startMs: number,
  endMs: number,
  n: number,
): string[][] {
  const buckets: string[][] = Array.from({ length: n }, () => []);
  if (!t?.transcription) return buckets;
  const dur = Math.max(1, endMs - startMs);
  for (const s of t.transcription) {
    const a = s.offsets?.from ?? 0;
    const b = s.offsets?.to ?? a;
    if (b <= startMs || a >= endMs) continue;
    const mid = ((s.offsets?.from ?? 0) + (s.offsets?.to ?? 0)) / 2;
    const rel = (mid - startMs) / dur;
    const idx = Math.min(n - 1, Math.max(0, Math.floor(rel * n)));
    const text = tidyTranscript(s.text ?? "");
    if (text) buckets[idx]!.push(text);
  }
  return buckets;
}

async function probeDurationMs(videoPath: string): Promise<number> {
  const ffprobe = getFfprobePath();
  return new Promise((resolve, reject) => {
    let out = "";
    const p = spawn(ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "default=nokey=1:noprint_wrappers=1", videoPath], { stdio: ["ignore", "pipe", "ignore"] });
    p.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    p.on("error", reject);
    p.on("exit", (code: number | null) => {
      if (code !== 0) reject(new Error(`ffprobe exited ${code}`));
      else resolve(Math.round(parseFloat(out.trim()) * 1000));
    });
  });
}

async function renderClipFrames(src: string, c: Suggestion, n: number, videoRoot: string): Promise<string[]> {
  const ffmpeg = getFfmpegPath();
  const sig = srcSignature(src);
  const dur = c.end_ms - c.start_ms;
  const frames: string[] = [];
  for (let i = 0; i < n; i++) {
    // Sample at 10/37/63/90% of the clip — avoids exact endpoints which often have cuts/transitions.
    const frac = n === 1 ? 0.5 : 0.1 + 0.8 * (i / (n - 1));
    const tSec = ((c.start_ms + dur * frac) / 1000).toFixed(3);
    const key = cacheKey({
      v: CACHE_SCHEMA_VERSION, sig,
      clipId: c.id, startMs: c.start_ms, endMs: c.end_ms,
      n, i, tSec,
    });
    const outPath = cachePath(videoRoot, "clip-frame", key, "jpg");
    await getOrCompute(outPath, async (p) => {
      await runProc(ffmpeg, [
        "-y", "-ss", tSec, "-i", src, "-frames:v", "1",
        "-vf", "scale='min(280,iw)':-2,format=yuvj420p",
        "-c:v", "mjpeg", "-pix_fmt", "yuvj420p",
        "-q:v", "5", "-threads:v", "1", "-strict", "-2", "-f", "image2", p,
      ]);
    });
    frames.push((await readFile(outPath)).toString("base64"));
  }
  return frames;
}

async function readParentAiSceneAnalysis(videoRoot: string): Promise<boolean> {
  const metaPath = path.join(path.dirname(videoRoot), PROJECT_META_FILE);
  if (!existsSync(metaPath)) return false;
  try {
    const meta = JSON.parse(await readFile(metaPath, "utf8")) as ProjectMeta;
    return meta.version === 2 && meta.aiSceneAnalysis === true;
  } catch {
    return false;
  }
}

async function renderStylePreview(
  src: string, c: Suggestion, midSec: string, style: string, sampleText: string, videoRoot: string,
): Promise<string> {
  const normalizedStyle = normalizeCaptionStyle(style);
  const sig = srcSignature(src);
  const key = cacheKey({
    v: CACHE_SCHEMA_VERSION, sig,
    clipId: c.id, startMs: c.start_ms, endMs: c.end_ms,
    midSec, style: normalizedStyle, text: sampleText,
    captionSafeZone: "bottom-controls-v1",
  });
  const outPath = cachePath(videoRoot, "style-thumb", key, "jpg");
  await getOrCompute(outPath, async (p) => {
    // Generate a small ASS file with the style preset and sample text, burn over a downscaled frame.
    const tail = ASS_STYLES[normalizedStyle] ?? ASS_STYLES["bold-white-bottom"]!;
    const dims = { w: 360, h: 640 };
    const safe = sampleText.replace(/[{}]/g, "");
    const ass = `[Script Info]
ScriptType: v4.00+
PlayResX: ${dims.w}
PlayResY: ${dims.h}

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${scaleStyleForPreview(tail)}

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:10.00,Default,,0,0,0,,${safe}
`;
    const assPath = `${p}.ass`;
    await writeFile(assPath, ass);

    const ffmpeg = await resolveFfmpegPath({ requiredFilters: ["subtitles"] });
    const filterComplex =
      `[0:v]scale=${dims.w}:${dims.h}:force_original_aspect_ratio=increase,crop=${dims.w}:${dims.h},subtitles=${escapeFilterPath(assPath)}[v]`;
    await runProc(ffmpeg, [
      "-y", "-ss", midSec, "-i", src,
      "-filter_complex", filterComplex,
      "-map", "[v]", "-frames:v", "1",
      "-c:v", "mjpeg", "-pix_fmt", "yuvj420p",
      "-q:v", "5", "-threads:v", "1", "-strict", "-2", "-f", "image2", p,
    ]);
    await unlink(assPath).catch(() => { });
  });
  return (await readFile(outPath)).toString("base64");
}

// Style tail is calibrated for 1080×1920. For our 360×640 preview we scale fontsize ~1/3.
function scaleStyleForPreview(tail: string): string {
  const parts = tail.split(",");
  if (parts.length < 22) return tail;
  const fontsize = parseInt(parts[1] || "84", 10);
  parts[1] = String(Math.max(20, Math.round(fontsize / 3)));
  // Reduce outline/shadow proportionally
  const outline = parseInt(parts[15] || "0", 10);
  const shadow = parseInt(parts[16] || "0", 10);
  parts[15] = String(Math.max(1, Math.round(outline / 3)));
  parts[16] = String(Math.max(0, Math.round(shadow / 3)));
  // Smaller margins
  const ml = parseInt(parts[18] || "80", 10);
  const mr = parseInt(parts[19] || "80", 10);
  const mv = parseInt(parts[20] || "260", 10);
  parts[18] = String(Math.max(10, Math.round(ml / 3)));
  parts[19] = String(Math.max(10, Math.round(mr / 3)));
  parts[20] = String(Math.max(20, Math.round(mv / 3)));
  return parts.join(",");
}

function escapeFilterPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

function fmtTime(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function sourceVisualStats(points: Point[]): {
  visualMoments: number;
  faceRegions: number;
  faceMoments: number;
  privacyRisks: number;
  cropRegions: number;
  textRegions: number;
} {
  let visualMoments = 0;
  let faceRegions = 0;
  let faceMoments = 0;
  let privacyRisks = 0;
  let cropRegions = 0;
  let textRegions = 0;
  for (const p of points) {
    const meta = p.visual_metadata;
    if (!meta) continue;
    visualMoments += 1;
    const faces = Array.isArray(meta.faces) ? meta.faces.length : 0;
    if (faces > 0) {
      faceRegions += faces;
      faceMoments += 1;
    }
    privacyRisks += Array.isArray(meta.privacy_risks) ? meta.privacy_risks.length : 0;
    cropRegions += Array.isArray(meta.crop_regions) ? meta.crop_regions.length : 0;
    textRegions += Array.isArray(meta.text_regions) ? meta.text_regions.length : 0;
  }
  return { visualMoments, faceRegions, faceMoments, privacyRisks, cropRegions, textRegions };
}

function sourceAnalysisSummaryHtml(points: Point[]): string {
  const stats = sourceVisualStats(points);
  if (points.length === 0 || stats.visualMoments === 0) {
    return `<div class="source-analysis-summary empty"><span class="sas-pill">Visual analysis: <strong>not available</strong></span><span class="sas-note">Run Re-analyze video to detect faces, privacy regions, text, and crop suggestions. If it stays empty, the image-capable AI tool did not return usable visual metadata.</span></div>`;
  }
  const noFaces = stats.faceRegions === 0;
  const faceText = stats.faceRegions === 1 ? "1 region" : `${stats.faceRegions} regions`;
  const momentText = stats.faceMoments === 1 ? "1 moment" : `${stats.faceMoments} moments`;
  return `<div class="source-analysis-summary ${noFaces ? "no-faces" : "has-faces"}">` +
    `<span class="sas-pill sas-face">Faces: <strong>${escapeHtml(faceText)}</strong> / ${escapeHtml(momentText)}</span>` +
    `<span class="sas-pill">Privacy: <strong>${stats.privacyRisks}</strong></span>` +
    `<span class="sas-pill">Crop suggestions: <strong>${stats.cropRegions}</strong></span>` +
    `<span class="sas-pill">Text regions: <strong>${stats.textRegions}</strong></span>` +
    (noFaces ? `<span class="sas-note">No face regions detected. If there are actual faces, re-analyze with an image-capable AI tool.</span>` : "") +
    `</div>`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function sourceFolderHtml(projectPath: string): string {
  return `<div class="source-folder-info">` +
    `<div class="sfi-main"><span>Folder</span><code>${escapeHtml(projectPath)}</code></div>` +
    `<div class="sfi-main"><span>Open</span><code>open ${escapeHtml(shellQuote(projectPath))}</code></div>` +
    `<button id="open-video-folder-btn" class="ghost-btn-sm" type="button">Open folder</button>` +
    `<span id="open-video-folder-status" class="hint-small" aria-live="polite"></span>` +
    `</div>`;
}

// ─────────── HTML ───────────

function buildHtml(args: {
  videoTitle: string;
  clipTitlePrefix: string;
  suggestions: Suggestion[];
  clipFrames: Record<string, string[]>;
  clipStyleThumbs: Record<string, Record<string, string>>;
  clipCaptionBuckets: Record<string, string[][]>;
  projectPath: string;
  sourceDurationMs: number;
  points: Point[];
  pointFrames: Record<number, string>;
  transcriptWords: Array<{ startMs: number; endMs: number; text: string }>;
  // When the working video was overwritten by replace-audio, this is
  // the URL of the pre-replacement backup so the UI can toggle between
  // them. Empty when there's no backup on disk.
  originalSrcUrl?: string;
  // Filename of the matched audio (from .match-meta.json). When set,
  // the source-video card shows "[x] use audio from <name>"; when
  // unset, it shows a "Replace audio from a track…" picker.
  matchedAudioName?: string;
  // Audio files available under <projectRoot>/_sources/ for the
  // picker. Populated whether or not a match exists, so the user can
  // re-pick a different track.
  availableAudios: string[];
  ttsVoices: TtsVoice[];
  aiSceneAnalysis: boolean;
}): string {
  const meta = [
    `Duration: ${fmtTime(args.sourceDurationMs)}`,
  ].filter(Boolean).join(" · ");
  const sourceAnalysisHtml = sourceAnalysisSummaryHtml(args.points);
  const sourceFolderInfoHtml = sourceFolderHtml(args.projectPath);
  const illustrationPromptTemplate = loadIllustrationPromptTemplate();

  // For each suggestion, find the nearest point indices for its start/end —
  // these become the clip's snappable in/out anchors. If no points exist
  // (analysis didn't run), points[] is empty and clips fall back to ms range.
  const seedClips = args.suggestions.map((c) => {
    const savedStartPoint = typeof c.start_point === "number" ? args.points.find((p) => p.index === c.start_point) : undefined;
    const savedEndPoint = typeof c.end_point === "number" ? args.points.find((p) => p.index === c.end_point) : undefined;
    const sp = savedStartPoint ?? (c.saved ? undefined : nearestPointAtOrBefore(args.points, c.start_ms));
    const ep = savedEndPoint ?? (c.saved ? undefined : nearestPointAtOrAfter(args.points, c.end_ms));
    return { suggestion: c, start_point: sp?.index, end_point: ep?.index };
  });

  // Auto-name clips from the start point's caption when available.
  // Per-clip overrides come in via args.suggestions[i].{caption_style,
  // caption_animation, reframe} (seeded by buildPlanUi from the
  // existing plan.json, when present).
  const autoNamed = seedClips.map(({ suggestion, start_point, end_point }) => {
    const sp = args.points.find((p) => p.index === start_point);
    const autoTitle =
      suggestion.saved
        ? suggestion.title
        : suggestion.id === "clip_full"
          ? suggestion.title
          : sp?.caption ? firstNWords(sp.caption, 5) : suggestion.title;
    return {
      ...suggestion,
      title: suggestion.saved ? autoTitle : defaultClipTitle(args.clipTitlePrefix, autoTitle),
      start_point, end_point,
    };
  });

  // Build the per-clip panel content & tab labels.
  const clipPanels = autoNamed
    .map((c, i) =>
      clipCardHtml(
        c,
        i,
        args.clipFrames[c.id] ?? [],
        args.clipStyleThumbs[c.id] ?? {},
        args.sourceDurationMs,
        args.points,
        c.start_point,
        c.end_point,
        args.ttsVoices,
      ),
    )
    .join("\n");
  // Pick a representative set of style thumbnails for the global style picker
  // in the Settings tab. We use the first clip's thumbnails — every clip's
  // thumbnails are rendered from its own midpoint frame, so any one is fine
  // as a "this is what the style looks like" preview.
  const firstClipId = autoNamed[0]?.id;
  const globalStyleThumbs: Record<string, string> =
    firstClipId && args.clipStyleThumbs[firstClipId]
      ? args.clipStyleThumbs[firstClipId]
      : {};

  // Compact JSON for points + initial clip ranges. Embedded in the page so
  // client JS can compute snapping, propagate per-point caption edits across
  // tabs, and render the Timeline tab.
  const initialState = JSON.stringify({
    sourceDurationMs: args.sourceDurationMs,
    points: args.points,
    pointFrames: args.pointFrames,
    clipTitlePrefix: args.clipTitlePrefix,
    clips: autoNamed.map((c) => ({
      id: c.id, title: c.title,
      render_title: c.render_title,
      start_point: c.start_point, end_point: c.end_point,
      start_ms: c.start_ms, end_ms: c.end_ms,
      crop_x_norm: typeof c.crop_x_norm === "number" ? c.crop_x_norm : undefined,
    })),
    // Word-level timings drive the live caption overlay. Empty for v1
    // projects; populated from video.json for v2 video subprojects.
    words: args.transcriptWords,
    // Default render settings new clips inherit. Per-clip overrides
    // live alongside the clip in plan.json.
    defaults: config.renderDefaults,
    faceEmojiScale: config.faceEmojiScale,
    defaultFaceEmoji: DEFAULT_FACE_EMOJI,
    faceEmojiNone: FACE_EMOJI_NONE,
    faceEmojiAssets: Object.fromEntries(FACE_EMOJI_OPTIONS.map((opt) => [opt.emoji, faceEmojiAssetUrl(opt.emoji)])),
    faceMouthAssets: {
      speaking: faceMouthAssetUrl("speaking"),
    },
    faceEmojiPresentation: Object.fromEntries(FACE_EMOJI_OPTIONS.map((opt) => [
      opt.emoji,
      { scale: opt.scale ?? 1, yOffset: opt.yOffset ?? 0 },
    ])),
    defaultTtsVoice: DEFAULT_TTS_VOICE,
    ttsVoices: args.ttsVoices,
    illustrationPromptTemplate,
  });

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>aicw-video plan — ${escapeHtml(args.videoTitle)}</title>
<link rel="stylesheet" href="tailwind.css">
<style>${CSS}</style>
</head>
<body data-project="${escapeHtml(args.projectPath)}">

<header class="appbar appbar-global">
  <div class="appbar-inner">
    <a class="appbar-brand" href="/" id="brand-home">
      <span class="logo">A</span>
      <span class="name">AICW Video</span>
    </a>
    <span class="appbar-spacer"></span>
    <div class="appbar-actions">
      <span id="status" class="autosave-indicator" aria-live="polite" title="Edits save automatically">auto-saved ✓</span>
      <a class="appbar-gh iconbtn" href="https://github.com/aicw-io/aicw-video" target="_blank" rel="noopener" aria-label="aicw-video on GitHub" title="aicw-video on GitHub">
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 .8a11.2 11.2 0 0 0-3.54 21.83c.56.1.76-.24.76-.54v-2.1c-3.13.68-3.79-1.33-3.79-1.33-.51-1.3-1.25-1.65-1.25-1.65-1.02-.7.08-.69.08-.69 1.13.08 1.73 1.16 1.73 1.16 1 .1 1.28 2.02 2.92 1.44.1-.73.39-1.22.71-1.5-2.5-.28-5.13-1.25-5.13-5.57 0-1.23.44-2.24 1.16-3.03-.12-.28-.5-1.43.11-2.98 0 0 .95-.3 3.1 1.16A10.7 10.7 0 0 1 12 6.1c.96 0 1.92.13 2.82.38 2.15-1.46 3.1-1.16 3.1-1.16.61 1.55.23 2.7.11 2.98.72.79 1.16 1.8 1.16 3.03 0 4.33-2.63 5.28-5.14 5.56.4.35.76 1.03.76 2.08v3.12c0 .3.2.65.77.54A11.2 11.2 0 0 0 12 .8Z"/></svg>
      </a>
      <a class="appbar-site" href="https://www.aicw.io" target="_blank" rel="noopener">www.aicw.io</a>
      <button id="theme-toggle" class="iconbtn" type="button" aria-label="Toggle theme" title="Toggle theme">
        <svg class="theme-ico-light" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
        <svg class="theme-ico-dark" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" hidden><circle cx="12" cy="12" r="4.2"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>
      </button>
    </div>
  </div>
</header>
<header class="appbar appbar-page">
  <div class="appbar-inner">
    <a id="back-to-project" class="appbar-back iconbtn" href="/" aria-label="Back to project" title="Back to project">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
    </a>
    <div class="appbar-title">
      <span class="t-main">${escapeHtml(args.videoTitle)}</span>
      ${meta ? `<span class="t-sub">${escapeHtml(meta)}</span>` : ""}
    </div>
    <div class="appbar-page-actions">
      <label class="reanalyze-ai-option">
        <input id="reanalyze-ai-scene-analysis" type="checkbox"${args.aiSceneAnalysis ? " checked" : ""}>
        <span><strong>AI scene analysis</strong><small>ChatGPT, Claude, or Ollama. Off uses Whisper plus local face/crop detection.</small></span>
      </label>
      <button id="reanalyze-video-btn" class="ghost-btn-sm" type="button">Re-analyze video</button>
      <span id="reanalyze-video-status" class="hint-small" aria-live="polite"></span>
    </div>
  </div>
</header>

<main>
  <section id="panel-source">
    <div class="panel-grid">
      <div class="player-card">
        <h3>Source video</h3>
        <video id="src-video" data-replaced-src="source.mp4" ${args.originalSrcUrl ? `data-original-src="${escapeHtml(args.originalSrcUrl)}"` : ""} controls preload="metadata" src="source.mp4"></video>
        ${sourceAnalysisHtml}
        ${sourceFolderInfoHtml}
        <!-- Audio-track control: a checkbox when a match exists (toggle
             between matched and the pre-replace backup), otherwise a
             picker that runs replace-audio against a chosen track. -->
        <div class="src-audio-row">
          ${args.matchedAudioName && args.originalSrcUrl
      ? `<label class="src-audio-toggle">
                <input id="src-audio-toggle-input" type="checkbox" checked>
                <span>use audio from <strong>${escapeHtml(args.matchedAudioName)}</strong></span>
              </label>`
      : args.matchedAudioName
        ? `<span class="src-audio-note">audio from <strong>${escapeHtml(args.matchedAudioName)}</strong> is baked into this video</span>`
        : `<button id="src-audio-replace-btn" class="ghost-btn-sm" type="button">Replace audio from a track…</button>`}
        </div>
        <!-- Picker (hidden by default; opened by "Replace audio…" or
             by clicking "use audio from …" again to swap). -->
        <div class="src-audio-picker" id="src-audio-picker" hidden>
          <div class="src-audio-picker-h">Pick the audio recording to replace this video's audio:</div>
          <div class="src-audio-picker-list">
            ${args.availableAudios.length === 0
      ? `<div class="hint-small">No audio files in this project's <code>_sources/</code>.</div>`
      : args.availableAudios.map((a) => `<label class="src-audio-pick-row">
                  <input type="radio" name="src-audio-pick" value="${escapeHtml(a)}">
                  <span>${escapeHtml(a)}</span>
                </label>`).join("")}
          </div>
          <div class="src-audio-picker-foot">
            <button id="src-audio-cancel" class="ghost-btn-sm" type="button">Cancel</button>
            <button id="src-audio-go" class="primary-btn-sm" type="button" disabled>Match &amp; replace</button>
            <span id="src-audio-status" class="hint-small"></span>
          </div>
        </div>
      </div>
      <div class="layout-splitter panel-splitter" data-splitter="panel" role="separator" aria-orientation="vertical" tabindex="0" title="Resize source and rendered panels"></div>
      <div class="meta-card video-renders-card" id="video-renders-card">
        <div class="video-renders-head">
          <h3>Rendered</h3>
          <span class="video-renders-count" id="video-renders-count">0</span>
          <button id="video-renders-expand" class="iconbtn-sm" type="button" aria-label="Expand to full width" title="Expand to full width" style="margin-left:auto">
            <svg class="vr-ic-expand" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>
            <svg class="vr-ic-collapse" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" hidden><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/></svg>
          </button>
        </div>
        <div class="video-renders-filter" id="video-renders-filter" hidden></div>
        <div id="video-renders-list" class="video-renders-list">
          <div class="render-empty-grid">
            <div class="render-card-empty render-card-empty-solo"><span class="rce-label">Rendered clips will appear here</span></div>
          </div>
        </div>
      </div>
    </div>

    <details class="timeline-block" open>
      <summary>
        <span class="tl-summary-title">Timeline</span>
        <span class="hint-small">click a clip to scroll to it</span>
        <div id="timeline-mini" class="timeline-mini" aria-hidden="true"></div>
      </summary>
      <div id="timeline-host" class="timeline-host"></div>
    </details>

    <div class="clip-stack-row">
      <h3 class="clip-stack-h">Clips</h3>
      <button id="add-clip-open" class="primary add-clip-open" type="button">+ Add Clip</button>
      <span id="add-clip-status" class="hint-small"></span>
      <label class="select-label" style="margin-left:auto">Sort by
        <select id="clip-sort">
          <option value="start" selected>start time</option>
          <option value="duration">duration</option>
          <option value="manual">manual</option>
        </select>
      </label>
    </div>
    <div class="clip-stack">
      ${clipPanels}
    </div>

    <section class="add-clip-note">
      <span class="hint-small">Use Add Clip to add another full-timeline clip.</span>
    </section>
  </section>
</main>

<div class="drawer-overlay" id="drawer-overlay" aria-hidden="true"></div>
<aside class="drawer" id="settings-drawer" role="dialog" aria-label="Settings" aria-modal="true">
  <div class="drawer-head">
    <h2>Settings</h2>
    <button id="close-settings" class="iconbtn" type="button" aria-label="Close">✕</button>
  </div>
  <div class="drawer-body">
    <section id="panel-settings">
      <p class="hint">Caption style, animation and reframe live on each clip's ⚙ button. Output sizes are picked when you click <strong>Render…</strong>.</p>
      <h3>Plan preview</h3>
      <p class="hint">Auto-saves on every change.</p>
      <pre id="preview" class="json-preview"></pre>
    </section>
  </div>
</aside>

<script>window.AICW_VIDEO_STATE = ${initialState};</script>
<script>${JS}</script>
</body>
</html>`;
}

function clipCardHtml(
  c: Suggestion,
  i: number,
  frames: string[],
  _styleThumbs: Record<string, string>,
  sourceDurationMs: number,
  points: Point[],
  startPointIdx: number | undefined,
  endPointIdx: number | undefined,
  ttsVoices: TtsVoice[],
): string {
  const dur = c.end_ms - c.start_ms;
  const slugForId = slugify(c.title);
  const cardId = `clip-${c.id}`;

  // Render every analysis point as a thin tick on the trackbar; the snap-to-tick
  // handles in the JS pick the nearest point. Empty points → trackbar still
  // works as a free-form ms slider.
  const ticks = points
    .map((p) => {
      const head = firstNWords(p.caption || "", 3);
      const tip = head ? `#${p.index} ${fmtTime(p.ts_ms)} — ${head}` : `#${p.index} ${fmtTime(p.ts_ms)}`;
      const label = head ? escapeHtml(head) : `#${p.index}`;
      return `<div class="tick" data-pt="${p.index}" data-ts="${p.ts_ms}" style="left:${(p.ts_ms / sourceDurationMs) * 100}%" title="${escapeHtml(tip)}"><span class="tick-num">#${p.index}</span><span class="tick-label">${label}</span></div>`;
    })
    .join("");

  // Frame strip preserved from before — but now reads from analysis points so
  // each thumbnail is a real keyframe. Clicking still seeks the player.
  const segments = frames
    .map((b64, idx) => {
      const startFrac = idx / frames.length;
      const endFrac = (idx + 1) / frames.length;
      const segStart = c.start_ms + Math.round(dur * startFrac);
      const segEnd = c.start_ms + Math.round(dur * endFrac);
      return `<div class="segment-cell" data-seg-start="${segStart}" data-seg-end="${segEnd}">
        <img class="segment-thumb" src="data:image/jpeg;base64,${b64}" alt="" title="${fmtTime(segStart)}–${fmtTime(segEnd)} · click to seek">
        <span class="segment-time">${fmtTime(segStart)}–${fmtTime(segEnd)}</span>
      </div>`;
    })
    .join("");

  const startPointAttr = startPointIdx != null ? ` data-start-point="${startPointIdx}"` : "";
  const endPointAttr = endPointIdx != null ? ` data-end-point="${endPointIdx}"` : "";
  const voiceOptions = [
    `<option value="">Default (${escapeHtml(DEFAULT_TTS_VOICE)})</option>`,
    ...ttsVoices.map((v) => `<option value="${escapeHtml(v.id)}">${escapeHtml(v.label)}</option>`),
  ].join("");
  const fullTimelineAttr = c.id === "clip_full" || (c.start_ms <= 0 && c.end_ms >= sourceDurationMs - 300)
    ? ` data-full-timeline="1"`
    : "";

  return `<section class="clip-card" id="${cardId}" data-id="${escapeHtml(c.id)}" data-slug="${escapeHtml(slugForId)}" data-start="${c.start_ms}" data-end="${c.end_ms}" data-suggested-start="${c.start_ms}" data-suggested-end="${c.end_ms}" data-source-ms="${sourceDurationMs}" data-order="${i}" data-active-tab="clip" data-caption-style="${escapeHtml(c.caption_style ? normalizeCaptionStyle(c.caption_style) : "")}" data-caption-animation="${escapeHtml(c.caption_animation || "")}" data-reframe="${escapeHtml(c.reframe || "")}" data-crop-x-norm="${typeof c.crop_x_norm === "number" ? c.crop_x_norm.toFixed(4) : ""}" data-face-emoji-enabled="${c.face_emoji_enabled ? "1" : "0"}" data-face-emoji="${escapeHtml(normalizeFaceEmojiSelection(c.face_emoji || DEFAULT_FACE_EMOJI))}" data-face-blur="${escapeHtml(normalizeFaceBlur(c.face_blur))}" data-face-imitate-speaking="${c.face_imitate_speaking ? "1" : "0"}" data-voiceover-enabled="${c.voiceover_enabled ? "1" : "0"}" data-voiceover-voice="${escapeHtml(c.voiceover_voice || "")}" data-render-title="${escapeHtml(c.render_title || "")}"${fullTimelineAttr}${startPointAttr}${endPointAttr}>
  <div class="clip-header">
    <button class="clip-toggle iconbtn-sm" type="button" title="Collapse clip" aria-label="Collapse clip"><svg class="ct-chev icon-fill" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M7 9.5h10L12 15z"/></svg></button>
    <span class="clip-num">#${i + 1}</span>
    <input class="title-input" type="text" placeholder="Clip title" value="${escapeHtml(c.title)}">
    <span class="clip-summary" hidden></span>
    <button class="clip-render-btn" type="button" title="Render this clip">▶ Render…</button>
    <button class="clip-export-tutorial-btn" type="button" title="Export this clip as an HTML and Markdown tutorial">Export tutorial</button>
    <button class="clip-settings-btn iconbtn-sm" type="button" title="Clip settings" aria-label="Clip settings"><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 21v-7"/><path d="M4 10V3"/><path d="M12 21v-9"/><path d="M12 8V3"/><path d="M20 21v-5"/><path d="M20 12V3"/><path d="M2 14h4"/><path d="M10 8h4"/><path d="M18 16h4"/></svg></button>
    <button class="clip-kebab-btn iconbtn-sm" type="button" title="More" aria-label="Clip actions" aria-haspopup="menu" aria-expanded="false"><svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><circle cx="12" cy="5" r="1.9"/><circle cx="12" cy="12" r="1.9"/><circle cx="12" cy="19" r="1.9"/></svg></button>
    <div class="clip-meta">
      <div class="clip-reason">${escapeHtml(c.reason)}</div>
    </div>
  </div>

  <!-- Per-clip kebab menu (Delete, etc.) -->
  <div class="clip-kebab-pop" hidden role="menu">
    <button class="clip-delete-btn" type="button" role="menuitem">Delete clip…</button>
  </div>
  <div class="clip-tabs">
    <button class="clip-tab active" type="button" data-clip-tab="clip">Edit</button>
    <button class="clip-tab" type="button" data-clip-tab="rendered">Rendered <span class="clip-tab-count" data-rendered-count>0</span></button>
    <button class="clip-tab" type="button" data-clip-tab="settings">Settings</button>
  </div>
  <div class="clip-tab-panel clip-tab-clip active">
    <div class="clip-grid">
      <div class="clip-grid-left">
        <div class="clip-range">
          <div class="clip-video-wrap">
            <video class="clip-player" preload="metadata" controls playsinline></video>
            <video class="clip-illustration-player" preload="metadata" muted playsinline aria-hidden="true"></video>
            <div class="caption-overlay" data-style="bold-white-bottom" data-style-base="bold-white" data-placement="bottom" aria-hidden="true"></div>
            <div class="face-emoji-overlay" aria-hidden="true"></div>
          </div>
          <div class="clip-time">
            <span class="ct-cur">0:00.0</span> <span class="ct-sep">/ ${fmtTime(sourceDurationMs)}</span>
            <span class="ct-rel">+0.0s of ${((c.end_ms - c.start_ms) / 1000).toFixed(1)}s</span>
            <div class="clip-preview-controls">
              <label class="clip-preview-format" title="Preview this clip in an output shape without changing render settings">
                <span>Preview</span>
                <select class="clip-preview-aspect">
                  <option value="">Source</option>
                  <option value="9:16">TikTok / Reels</option>
                  <option value="youtube-shorts">YouTube Shorts</option>
                  <option value="1:1">Instagram square</option>
                  <option value="4:5">Instagram tall</option>
                  <option value="linkedin">LinkedIn</option>
                  <option value="16:9">YouTube</option>
                </select>
              </label>
              <label class="clip-crop-toggle" title="Apply crop when rendering target sizes that need reframing">
                <input class="clip-crop-check" type="checkbox">
                <span>Smart crop</span>
              </label>
            </div>
          </div>
          <div class="range-track">
            <div class="ticks">${ticks}</div>
            <span class="range-suggest range-suggest-in"  title="Suggested clip start" style="left:${(c.start_ms / sourceDurationMs) * 100}%">✨</span>
            <span class="range-suggest range-suggest-out" title="Suggested clip end"   style="left:${(c.end_ms / sourceDurationMs) * 100}%">✨</span>
            <div class="range-active"></div>
            <div class="range-playhead"></div>
            <div class="range-handle range-in"   role="slider" tabindex="0" aria-label="Clip start"></div>
            <div class="range-handle range-out"  role="slider" tabindex="0" aria-label="Clip end"></div>
          </div>
          <div class="range-vals">
            <span class="range-pt-info"><span class="range-in-label">point #?</span> → <span class="range-out-label">point #?</span></span>
            <span class="range-dur"></span>
            <button class="play-region" type="button">▶ Play region</button>
          </div>
          <div class="range-hint hint-small">tip: hold <kbd>Shift</kbd> while dragging a handle to place it freely between points</div>
        </div>
      </div>
      <div class="layout-splitter clip-splitter" data-splitter="clip" role="separator" aria-orientation="vertical" tabindex="0" title="Resize video and captions"></div>
      <div class="clip-grid-right" data-right-tab="captions">
        <div class="right-pane-tabs" role="tablist" aria-label="Moment editor">
          <button class="right-pane-tab active" type="button" data-right-tab="captions">Captions</button>
          <button class="right-pane-tab" type="button" data-right-tab="illustrations">Illustrations</button>
        </div>
        <div class="right-pane-panel right-pane-captions active">
          <div class="moments-header">
            <div class="moments-title-row"><span class="moments-label">Moments &amp; captions</span></div>
            <span class="moments-hint">Move markers on the trackbar to include or exclude moments.</span>
          </div>
          <div class="point-captions" data-clip="${escapeHtml(c.id)}"></div>
        </div>
        <div class="right-pane-panel right-pane-illustrations">
          <div class="illustrations-header">
            <div class="illustrations-title-row">
              <span class="illustrations-label">Illustrations</span>
              <span class="illustrations-actions"><button class="moments-select-suggested" type="button">Select suggested</button><button class="moments-generate-selected" type="button">Generate selected</button></span>
            </div>
            <div class="illustrations-toolbar">
              <span class="illustrations-hint hint-small">Choose mode and cached animation asset per moment. Reusing the same asset on adjacent moments continues it instead of restarting it.</span>
            </div>
          </div>
          <div class="point-illustrations" data-clip="${escapeHtml(c.id)}"></div>
        </div>
      </div>
    </div>
  </div>
  <div class="clip-tab-panel clip-tab-rendered">
    <div class="renders" data-slug="${escapeHtml(slugForId)}">
      ${renderEmptyPlaceholderHtml(`none yet — click "▶ Render…" above to render this clip`)}
    </div>
  </div>
  <div class="clip-tab-panel clip-tab-settings">
    <div class="cs-row">
      <label class="cs-label">Caption style</label>
      <div class="cs-styles">${ALL_STYLES.map((s) => {
    const thumb = _styleThumbs[s] ?? "";
    const img = thumb
      ? `<img class="cs-style-thumb" alt="${escapeHtml(s)}" src="data:image/jpeg;base64,${thumb}">`
      : `<div class="cs-style-thumb cs-style-thumb-fallback" aria-hidden="true"></div>`;
    return `<label class="cs-style-pick"><input type="radio" name="cs-style-${escapeHtml(c.id)}" value="${escapeHtml(normalizeCaptionStyle(s))}">${img}<span class="cs-style-name">${escapeHtml(styleLabel(s))}</span></label>`;
  }).join("")}</div>
    </div>
    <div class="cs-row">
      <label class="cs-label">Animation</label>
      <select class="cs-anim" data-key="caption_animation">
        <option value="static">Static</option>
        <option value="word-pop">Word-pop (typing reveal)</option>
        <option value="word-highlight">Word-highlight (active word bigger)</option>
      </select>
    </div>
    <div class="cs-row">
      <label class="cs-label">Reframe</label>
      <select class="cs-reframe" data-key="reframe">
        <option value="crop">Crop to target aspect</option>
        <option value="letterbox-blur">Letterbox with blurred fill</option>
      </select>
    </div>
    <div class="cs-row">
      <label class="cs-label">Face privacy</label>
      <div class="cs-face-row">
        <div class="cs-face-stack">
          <label class="cs-face-enable">
            <input class="cs-face-enabled" type="checkbox">
            <span>Protect detected faces <em>Alpha</em></span>
          </label>
          <div class="cs-face-hint hint-small" aria-live="polite"></div>
        </div>
        <label class="cs-face-control"><span>Blur</span><select class="cs-face-blur" aria-label="Face blur">
          <option value="none">None</option>
          <option value="soft">Soft</option>
          <option value="strong">Strong</option>
        </select></label>
        <label class="cs-face-control"><span>Emoji</span><select class="cs-face-emoji" aria-label="Face replacement emoji">
          <option value="${FACE_EMOJI_NONE}">None</option>
          ${FACE_EMOJI_OPTIONS.map((opt) => `<option value="${escapeHtml(opt.emoji)}">${escapeHtml(opt.emoji)} ${escapeHtml(opt.label)}</option>`).join("")}
        </select></label>
        <label class="cs-face-imitate">
          <input class="cs-face-imitate-speaking" type="checkbox">
          <span>Imitate speaking</span>
        </label>
      </div>
    </div>
    <div class="cs-row">
      <label class="cs-label">Voice-over</label>
      <div class="cs-voice-row">
        <label class="cs-voice-enable">
          <input class="cs-voice-enabled" type="checkbox">
          <span>Replace clip audio with voice-over <em>Alpha</em></span>
        </label>
        <select class="cs-voice-select" aria-label="Voice-over voice">
          ${voiceOptions}
        </select>
        <button class="ghost-btn-sm cs-voice-preview" type="button">Preview</button>
        <span class="cs-voice-status hint-small"></span>
      </div>
    </div>
  </div>
</section>`;
}

// Placeholder for an empty render list. One dashed card carries the
// "Rendered clips will appear here" message — the four-aspect grid
// was visual noise (the user picks aspects in the Render… dialog).
function renderEmptyPlaceholderHtml(hint: string): string {
  return `<div class="render-empty-grid"><div class="render-card-empty render-card-empty-solo"><span class="rce-label">${escapeHtml(hint)}</span></div></div>`;
}

function nearestPointAtOrBefore(points: Point[], ms: number): Point | undefined {
  let best: Point | undefined;
  for (const p of points) {
    if (p.ts_ms <= ms) best = p;
    else break;
  }
  return best ?? points[0];
}

function nearestPointAtOrAfter(points: Point[], ms: number): Point | undefined {
  for (const p of points) if (p.ts_ms >= ms) return p;
  return points[points.length - 1];
}

function firstNWords(s: string, n: number): string {
  return firstWordsFromTranscript(s, n);
}

// Whisper emits punctuation and contraction suffixes as separate tokens
// (`time`, `,`, `It`, `'s`). Joining with spaces leaves stray gaps:
// "time , and" / "It 's web". This cleans those up so captions read
// naturally on screen and in the moments list.
function tidyTranscript(s: string): string {
  return cleanupTranscriptText(s);
}

function shortTitle(title: string): string {
  const words = title.trim().split(/\s+/);
  return (words.slice(0, 3).join(" ") || title).slice(0, 24);
}

function tabNum(s: string): string {
  return `<span class="tab-num">${escapeHtml(s)}</span>`;
}

function ensureFullVideoSuggestion(suggestions: Suggestion[], durationMs: number): void {
  const endMs = Math.max(1000, Math.round(durationMs));
  const full: Suggestion = {
    id: "clip_full",
    start_ms: 0,
    end_ms: endMs,
    title: "Full video",
    reason: "full source video",
    score: 1,
  };
  const rest = suggestions.filter((s) => s.id !== full.id);
  suggestions.splice(0, suggestions.length, ...rest, full);
}

function ensureBoundaryPoints(
  points: Point[],
  pointFrames: Record<number, string>,
  durationMs: number,
): void {
  const endMs = Math.max(0, Math.round(durationMs));
  const seeded: Point[] = [...points]
    .filter((p) => Number.isFinite(p.ts_ms) && p.ts_ms >= 0)
    .sort((a, b) => a.ts_ms - b.ts_ms || a.index - b.index);

  if (!seeded.some((p) => p.ts_ms === 0)) {
    seeded.unshift({ index: 0, ts_ms: 0, original_text: "", caption: "" });
  }
  if (endMs > 0 && !seeded.some((p) => p.ts_ms === endMs)) {
    seeded.push({ index: Number.MAX_SAFE_INTEGER, ts_ms: endMs, original_text: "", caption: "" });
  }

  const deduped: Point[] = [];
  for (const p of seeded.sort((a, b) => a.ts_ms - b.ts_ms || a.index - b.index)) {
    const prev = deduped[deduped.length - 1];
    if (prev && prev.ts_ms === p.ts_ms) {
      if (!prev.caption && p.caption) prev.caption = p.caption;
      if (!prev.original_text && p.original_text) prev.original_text = p.original_text;
      if (!prev.visual_metadata && p.visual_metadata) prev.visual_metadata = p.visual_metadata;
      if (!prev.crop && p.crop) prev.crop = p.crop;
      if (!pointFrames[prev.index] && pointFrames[p.index]) pointFrames[prev.index] = pointFrames[p.index]!;
      continue;
    }
    deduped.push({ ...p, caption: p.caption ?? "" });
  }

  const remappedFrames: Record<number, string> = {};
  deduped.forEach((p, i) => {
    const oldIndex = p.index;
    p.index = i + 1;
    const frame = pointFrames[oldIndex];
    if (frame) remappedFrames[p.index] = frame;
  });
  points.splice(0, points.length, ...deduped);
  for (const key of Object.keys(pointFrames)) delete pointFrames[Number(key)];
  Object.assign(pointFrames, remappedFrames);
}

function faceFocusedCropX(clip: Suggestion, points: Point[]): number | undefined {
  let weightedX = 0;
  let weight = 0;
  for (const p of points) {
    if (typeof p.ts_ms !== "number" || p.ts_ms < clip.start_ms || p.ts_ms > clip.end_ms) continue;
    const meta = p.visual_metadata;
    const regions = Array.isArray(meta?.faces) && meta.faces.length > 0
      ? meta.faces
      : meta?.main_focus ? [meta.main_focus] : [];
    for (const r of regions) {
      if (!r || !Number.isFinite(r.x) || !Number.isFinite(r.width)) continue;
      const w = Math.max(0.02, Number.isFinite(r.width) ? r.width : 0.02);
      weightedX += Math.max(0, Math.min(1, r.x + r.width / 2)) * w;
      weight += w;
    }
  }
  if (weight <= 0) return undefined;
  return Math.max(0.05, Math.min(0.95, weightedX / weight));
}

function mergeExistingPointEdits(points: Point[], existing: Point[]): void {
  if (points.length === 0 || existing.length === 0) return;
  const byIndex = new Map<number, Point>();
  for (const p of existing) {
    if (typeof p.index === "number") byIndex.set(p.index, p);
  }
  for (const p of points) {
    const prev = nearestPointByTimestamp(existing, p.ts_ms, 750) ?? byIndex.get(p.index);
    if (!prev) continue;
    if (typeof prev.caption === "string") p.caption = prev.caption;
    if (!p.original_text && prev.original_text) p.original_text = prev.original_text;
    if (!p.visual_metadata && prev.visual_metadata) p.visual_metadata = prev.visual_metadata;
    if (prev.crop) p.crop = prev.crop;
    if (prev.illustration) p.illustration = prev.illustration;
  }
}

function nearestPointByTimestamp(points: Point[], tsMs: number, maxDistanceMs: number): Point | undefined {
  let best: Point | undefined;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const p of points) {
    if (typeof p.ts_ms !== "number") continue;
    const dist = Math.abs(p.ts_ms - tsMs);
    if (dist < bestDist) {
      best = p;
      bestDist = dist;
    }
  }
  return best && bestDist <= maxDistanceMs ? best : undefined;
}

const CSS = `
:root{
  --bg:#fafafa;
  --surface:#ffffff;
  --surface-2:#f4f4f5;
  --ink:#18181b;
  --muted:#71717a;
  --border:#e4e4e7;
  --border-strong:#d4d4d8;
  --accent:#f59e0b;
  --accent-soft:rgba(245,158,11,.12);
  --brand:#3b82f6;
  --brand-soft:rgba(59,130,246,.12);
  --ok:#16a34a;
  --ok-soft:rgba(22,163,74,.12);
  --shadow:0 1px 2px rgba(0,0,0,.04),0 1px 3px rgba(0,0,0,.04);
  --shadow-elev:0 4px 14px rgba(0,0,0,.06);
}
[data-theme="dark"]{
  --bg:#0e1115;
  --surface:#191d24;
  --surface-2:#13171d;
  --ink:#e7eaee;
  --muted:#9aa3b2;
  --border:#2a2f37;
  --border-strong:#3a4250;
  --accent:#ffd60a;
  --accent-soft:rgba(255,214,10,.12);
  --brand:#6aa9ff;
  --brand-soft:rgba(106,169,255,.18);
  --ok:#33d17a;
  --ok-soft:rgba(51,209,122,.18);
  --shadow:0 1px 2px rgba(0,0,0,.4);
  --shadow-elev:0 6px 18px rgba(0,0,0,.5);
}
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:15px;line-height:1.55;overflow-x:hidden}
body{padding:0}
main{max-width:1100px;margin:0 auto;padding:18px 22px 40px}
input,textarea,select,button{min-width:0;max-width:100%;font-family:inherit}
h1,h2,h3,h4{margin:0 0 .4em;font-weight:600}
h2{font-size:1.4rem;line-height:1.25}
h3{font-size:.78rem;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;font-weight:600}
h4.section-h{font-size:.78rem;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin:1.4em 0 .55em;font-weight:600}
h4.section-h small.hint-small{display:none}
.meta{color:var(--muted);font-size:.88em}
.hint{color:var(--muted);font-size:.9em;margin:0 0 1em}
.hint-small{color:var(--muted);font-size:.78em;font-weight:400}
input[type="text"],textarea,.title-input{width:100%;background:var(--surface);color:var(--ink);border:1px solid var(--border);border-radius:8px;padding:.55em .75em;font-size:.95em;transition:border-color .15s}
input[type="text"]:focus,textarea:focus,.title-input:focus{outline:none;border-color:var(--brand);box-shadow:0 0 0 3px var(--brand-soft)}
textarea{resize:vertical}
code{background:var(--surface-2);border:1px solid var(--border);border-radius:4px;padding:1px 5px;font-size:.85em}

/* Two stacked app bars: top "global" (brand + site link), bottom
   "page" (video title + Save / Render). Only the global bar is sticky
   so the page-context bar scrolls away when the user dives into clips. */
.appbar{background:var(--surface);border-bottom:1px solid var(--border);box-shadow:var(--shadow);z-index:20}
.appbar-global{position:sticky;top:0;z-index:21}
.appbar-page{position:sticky;top:53px;z-index:20}
.appbar-inner{max-width:1100px;margin:0 auto;display:flex;align-items:center;gap:12px;padding:10px 22px}
.appbar-global .appbar-inner{padding:8px 22px}
.appbar-brand{display:flex;align-items:center;gap:10px;cursor:pointer;text-decoration:none;color:var(--ink)}
.appbar-brand .logo{width:28px;height:28px;border-radius:8px;background:linear-gradient(135deg,var(--brand),var(--accent));display:inline-flex;align-items:center;justify-content:center;color:#fff;font-weight:800;font-size:.92em;box-shadow:var(--shadow)}
.appbar-brand .name{font-size:1.05rem;font-weight:600}
.appbar-spacer{flex:1}
.appbar-site{color:var(--muted);font-size:.85em;text-decoration:none;padding:0 8px;border-radius:6px;transition:color .12s,background .12s}
.appbar-site:hover{color:var(--ink);background:var(--surface-2)}
.appbar-back{flex-shrink:0;color:var(--ink);text-decoration:none}
.appbar-title{display:flex;flex-direction:column;min-width:0;flex:1}
.appbar-title .t-main{font-size:1.05rem;font-weight:600;color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.appbar-title .t-sub{color:var(--muted);font-size:.78em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.appbar-actions{display:flex;align-items:center;gap:8px;flex-shrink:0}
.appbar-page-actions{display:flex;align-items:center;gap:8px;flex-shrink:0}
.appbar-page-actions .hint-small{max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.reanalyze-ai-option{display:flex;align-items:flex-start;gap:6px;max-width:340px;color:var(--muted);font-size:.76em;line-height:1.25}
.reanalyze-ai-option input{margin-top:.1em;accent-color:var(--brand);flex-shrink:0}
.reanalyze-ai-option strong{display:block;color:var(--ink);font-size:1.05em;font-weight:700}
.reanalyze-ai-option small{display:block;color:var(--muted)}
.iconbtn{appearance:none;background:transparent;color:var(--ink);border:1px solid transparent;border-radius:8px;width:36px;height:36px;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;font-size:1.05em;transition:background .12s,border-color .12s}
.iconbtn svg,.iconbtn-sm svg{display:block;flex-shrink:0;color:currentColor;fill:none;stroke:currentColor}
.iconbtn svg.icon-fill,.iconbtn-sm svg.icon-fill{fill:currentColor;stroke:none}
.appbar-gh svg{fill:currentColor;stroke:none}
.iconbtn:hover{background:var(--surface-2);border-color:var(--border)}
.iconbtn:active{background:var(--accent-soft)}
.appbar #status{color:var(--ok);font-size:.82em;margin-right:4px;font-variant-numeric:tabular-nums}
.appbar .autosave-indicator{color:var(--muted);font-size:.82em;font-variant-numeric:tabular-nums;transition:color .15s}
.appbar .autosave-indicator.saving{color:var(--brand)}
.appbar .autosave-indicator.error{color:#ef4444}
.appbar .autosave{display:none}
@media(max-width:720px){
  .appbar-page .appbar-inner{flex-wrap:wrap}
  .appbar-page-actions{width:100%;order:3}
}

/* Standard buttons */
button{appearance:none;background:var(--surface);color:var(--ink);border:1px solid var(--border);border-radius:8px;padding:.55em 1em;font-weight:500;font-size:.9em;cursor:pointer;transition:background .12s,border-color .12s}
button:hover:not(:disabled){background:var(--surface-2);border-color:var(--border-strong)}
button.primary{background:var(--brand);color:#fff;border-color:transparent}
button.primary:hover:not(:disabled){background:var(--brand);filter:brightness(1.07);border-color:transparent}
button.cta{background:var(--ok);color:#fff;border-color:transparent;font-weight:600}
button.cta:hover:not(:disabled){background:var(--ok);filter:brightness(1.07);border-color:transparent}
button:disabled{opacity:.55;cursor:wait}
button.ghost{background:transparent;border-color:transparent;color:var(--muted)}
button.ghost:hover:not(:disabled){background:var(--surface-2);color:var(--ink)}

/* Cards / panels */
.card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:16px 18px;box-shadow:var(--shadow)}
.panel-grid{--left:58%;display:grid;grid-template-columns:minmax(280px,var(--left)) 12px minmax(260px,1fr);gap:10px;margin-bottom:14px;align-items:stretch}
@media(max-width:760px){.panel-grid{grid-template-columns:1fr}.panel-grid .layout-splitter{display:none}}
.player-card,.meta-card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:14px 16px;box-shadow:var(--shadow)}
.player-card video,.player-card iframe{width:100%;aspect-ratio:16/9;background:#000;border-radius:8px;border:0;display:block}
.source-analysis-summary{margin:.7em 0 0;display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:.78em;color:var(--muted)}
.source-analysis-summary .sas-pill{display:inline-flex;align-items:center;gap:4px;background:var(--surface-2);border:1px solid var(--border);border-radius:999px;padding:.28em .62em;line-height:1.2}
.source-analysis-summary strong{color:var(--ink);font-weight:650}
.source-analysis-summary.no-faces .sas-face{background:rgba(245,158,11,.11);border-color:rgba(245,158,11,.42);color:#b45309}
.source-analysis-summary .sas-note{flex-basis:100%;color:var(--muted);line-height:1.35}
.source-analysis-summary.no-faces .sas-note{color:#b45309}
.source-folder-info{margin:.6em 0 0;display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:6px 8px;align-items:center;font-size:.78em;color:var(--muted)}
.source-folder-info .sfi-main{grid-column:1;display:flex;align-items:center;gap:6px;min-width:0}
.source-folder-info .sfi-main span{flex:0 0 auto;font-weight:650;color:var(--muted)}
.source-folder-info code{display:block;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:var(--surface-2);border:1px solid var(--border);border-radius:6px;padding:.28em .5em;color:var(--ink)}
.source-folder-info .ghost-btn-sm{grid-column:2;grid-row:1 / span 2;white-space:nowrap}
.source-folder-info .hint-small{grid-column:3;grid-row:1 / span 2;white-space:nowrap}
@media(max-width:760px){.source-folder-info{grid-template-columns:1fr}.source-folder-info .ghost-btn-sm,.source-folder-info .hint-small{grid-column:auto;grid-row:auto;justify-self:start}}
/* Source-video audio control: a single-line row under the player.
   "[x] use audio from <name>" when a match exists; otherwise a
   "Replace audio from a track…" button that opens the picker. */
.src-audio-row{margin:.7em 0 0;font-size:.88em;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.src-audio-toggle{display:inline-flex;align-items:center;gap:8px;cursor:pointer;color:var(--ink)}
.src-audio-toggle input{accent-color:var(--brand);width:16px;height:16px}
.src-audio-toggle strong{font-weight:600;color:var(--ink)}
.src-audio-note{color:var(--muted);font-size:.88em}
.src-audio-note strong{color:var(--ink);font-weight:600}
.ghost-btn-sm,.primary-btn-sm{appearance:none;border-radius:8px;padding:.4em .85em;font-size:.85em;font-weight:500;cursor:pointer;font-family:inherit;border:1px solid var(--border)}
.ghost-btn-sm{background:var(--surface);color:var(--ink)}
.ghost-btn-sm:hover{background:var(--surface-2)}
.primary-btn-sm{background:var(--brand);color:#fff;border-color:transparent;font-weight:600}
.primary-btn-sm:hover:not(:disabled){filter:brightness(1.07)}
.primary-btn-sm:disabled{opacity:.55;cursor:not-allowed}
.src-audio-picker{margin-top:.6em;padding:10px 12px;background:var(--surface-2);border:1px solid var(--border);border-radius:8px}
.src-audio-picker-h{font-size:.78em;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;font-weight:600;margin-bottom:.5em}
.src-audio-picker-list{display:flex;flex-direction:column;gap:4px;max-height:160px;overflow-y:auto}
.src-audio-pick-row{display:flex;align-items:center;gap:8px;padding:.35em .55em;border-radius:6px;cursor:pointer;font-size:.88em}
.src-audio-pick-row:hover{background:var(--surface)}
.src-audio-pick-row input{accent-color:var(--brand)}
.src-audio-picker-foot{display:flex;align-items:center;gap:8px;margin-top:.5em}
.src-audio-picker-foot .hint-small{margin-left:auto}
.player-card h3,.meta-card h3{margin-bottom:.55em}
.meta-card .lbl{display:block;color:var(--muted);font-size:.78em;margin:.7em 0 .3em;font-weight:500}
/* Video-level rendered-clips list (right-hand column of source grid) */
.video-renders-card{display:flex;flex-direction:column;transition:flex .18s ease}
.video-renders-head{display:flex;align-items:center;gap:8px;margin-bottom:.6em}
.video-renders-head h3{margin:0}
/* When expanded, the panel-grid becomes 1fr (the source-video card hides). */
body.vr-expanded .panel-grid > .player-card,
body.vr-expanded .panel-grid > .meta-card:not(#video-renders-card),
body.vr-expanded .panel-grid > .layout-splitter{display:none}
body.vr-expanded .panel-grid{grid-template-columns:1fr}
body.vr-expanded #video-renders-list{max-height:none}
/* Filter combobox (one row, scoped to the panel — no wide pills). */
.video-renders-filter{display:flex;align-items:center;gap:8px;margin:0 0 .7em}
.video-renders-filter .vr-filter-label{display:inline-flex;align-items:center;gap:8px;color:var(--muted);font-size:.82em}
.video-renders-filter .vr-filter-select{flex:1;background:var(--surface);color:var(--ink);border:1px solid var(--border);border-radius:8px;padding:.4em .6em;font-size:.86em;font-family:inherit;max-width:340px}
.video-renders-head h3{margin:0}
.video-renders-count{display:inline-flex;align-items:center;justify-content:center;min-width:22px;padding:0 8px;border-radius:999px;background:var(--surface-2);color:var(--muted);font-size:.78em;font-weight:600}
.video-renders-count.has{background:var(--brand-soft);color:var(--brand)}
.video-renders-list{display:flex;flex-direction:column;gap:14px;max-height:380px;overflow-y:auto;padding-right:4px}
.video-renders-list .vr-group{display:flex;flex-direction:column;gap:6px}
.video-renders-list .vr-group-h{font-size:.78rem;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin:0}
.video-renders-list .vr-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(90px,1fr));gap:8px}
.video-renders-list .vr-card{position:relative;background:var(--surface);border:1px solid var(--border);border-radius:8px;overflow:hidden;display:flex;flex-direction:column;box-shadow:var(--shadow)}
.video-renders-list .vr-card video{width:100%;aspect-ratio:9/16;background:#000;display:block}
.video-renders-list .vr-meta{padding:.4em .55em;display:flex;justify-content:space-between;align-items:center;font-size:.72em;gap:6px}
.video-renders-list .vr-stamp{color:var(--muted);font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.video-renders-list .vr-dl{color:var(--brand);text-decoration:none;font-weight:600;flex-shrink:0}
.video-renders-list .vr-dl:hover{text-decoration:underline}

/* Settings drawer */
.drawer-overlay{position:fixed;inset:0;background:rgba(0,0,0,.32);z-index:25;opacity:0;pointer-events:none;transition:opacity .18s}
body.drawer-open .drawer-overlay{opacity:1;pointer-events:auto}
.drawer{position:fixed;top:0;right:0;bottom:0;width:min(440px,90vw);background:var(--surface);border-left:1px solid var(--border);z-index:26;box-shadow:var(--shadow-elev);transform:translateX(100%);transition:transform .22s ease;display:flex;flex-direction:column}
body.drawer-open .drawer{transform:translateX(0)}
.drawer-head{display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid var(--border)}
.drawer-head h2{margin:0;font-size:1.05rem;font-weight:600}
.drawer-body{padding:18px;overflow-y:auto;flex:1}
.drawer-body h3{margin:1.4em 0 .5em}
.drawer-body h3:first-child{margin-top:0}

/* Settings drawer body */
.settings-row{display:flex;flex-wrap:wrap;gap:14px;align-items:center;margin-top:.7em}
.formats{display:flex;flex-wrap:wrap;gap:10px;align-items:center}
.formats .lbl{color:var(--muted);font-size:.82em;margin-right:4px;font-weight:500}
.formats label{display:inline-flex;align-items:center;gap:6px;font-size:.9em;color:var(--ink);cursor:pointer}
.formats input{accent-color:var(--brand);width:16px;height:16px}
.select-label{display:inline-flex;align-items:center;gap:8px;color:var(--muted);font-size:.88em}
.select-label select{background:var(--surface);color:var(--ink);border:1px solid var(--border);border-radius:6px;padding:.4em .6em;font-size:.9em}

/* Timeline block */
.timeline-block{margin:1.4em 0 0;background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:0;box-shadow:var(--shadow)}
.timeline-block > summary{list-style:none;cursor:pointer;display:flex;gap:12px;align-items:center;padding:12px 16px;font-weight:600;color:var(--ink);font-size:.92em}
.timeline-block > summary::-webkit-details-marker{display:none}
.timeline-block > summary::before{content:"▸";color:var(--muted);font-size:.78em;transition:transform .15s ease;flex-shrink:0}
.timeline-block[open] > summary::before{transform:rotate(90deg)}
.timeline-block .tl-summary-title{color:var(--ink);text-transform:none;letter-spacing:0;font-size:.92em;flex-shrink:0}
.timeline-block .ghost{margin-left:auto}
.timeline-block .timeline-host{padding:0 16px 16px}
/* Inline single-row strip shown in the summary so the user sees clip
   placement even when the timeline is collapsed. Hidden when expanded
   (the multitrack body takes over). */
.timeline-mini{position:relative;flex:1;height:22px;background:var(--surface-2);border:1px solid var(--border);border-radius:6px;overflow:hidden;min-width:120px}
.timeline-block[open] .timeline-mini{display:none}
.timeline-mini .tm-tick{position:absolute;top:4px;bottom:4px;width:2px;margin-left:-1px;background:var(--brand);opacity:.45;border-radius:1px;pointer-events:none}
.timeline-mini .tm-bar{position:absolute;top:3px;bottom:3px;background:var(--ok-soft);border:1px solid var(--ok);border-radius:3px;cursor:pointer}
.timeline-mini .tm-bar:hover{filter:brightness(.95)}
/* Hide the multitrack host when collapsed (the host wrapper is part
   of the <details> body so it'd be hidden anyway, but we want the
   mini visible regardless of <details> state). */

/* Clips stack */
.clip-stack-row{display:flex;align-items:center;gap:14px;margin:1.6em 0 .5em}
.clip-stack-h{margin:0;font-size:1.05rem;font-weight:600;color:var(--ink);text-transform:none;letter-spacing:0}
.clip-stack{display:flex;flex-direction:column;gap:16px}
.add-clip-open{padding:.46em .85em;font-size:.86em}
.add-clip-note{margin-top:10px;padding:0 2px}

/* Clip card */
.clip-card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:16px 18px;scroll-margin-top:80px;box-shadow:var(--shadow)}
.clip-num{display:inline-flex;align-items:center;justify-content:center;min-width:30px;height:26px;padding:0 8px;background:var(--accent-soft);color:var(--accent);border-radius:6px;font-weight:600;font-size:.82em;font-variant-numeric:tabular-nums}
.clip-header{display:flex;flex-wrap:wrap;gap:12px;align-items:center;border-bottom:1px solid var(--border);padding-bottom:12px;margin-bottom:14px}
.clip-meta{flex:1;min-width:0;display:none}
.clip-reason{display:none}
.title-input{margin-top:0;font-size:.95em;flex:1;min-width:200px}
.clip-render-btn{appearance:none;background:var(--ok);color:#fff;border:0;border-radius:8px;padding:.45em .9em;font-weight:600;font-size:.85em;cursor:pointer;flex-shrink:0;transition:filter .12s}
.clip-render-btn:hover:not(:disabled){filter:brightness(1.07)}
.clip-render-btn:disabled{opacity:.55;cursor:wait}
.clip-render-btn.busy{background:var(--accent);color:var(--ink)}
.clip-export-tutorial-btn{appearance:none;background:var(--surface-2);color:var(--ink);border:1px solid var(--border);border-radius:8px;padding:.45em .85em;font-weight:600;font-size:.85em;cursor:pointer;flex-shrink:0;transition:background .12s,color .12s,border-color .12s}
.clip-export-tutorial-btn:hover:not(:disabled){background:var(--brand-soft);color:var(--brand);border-color:var(--brand)}
.clip-export-tutorial-btn:disabled{opacity:.55;cursor:wait}
/* Small icon-only buttons in the clip header (⚙ + ⋮) */
.iconbtn-sm{appearance:none;background:var(--surface-2);color:var(--ink);border:1px solid var(--border);border-radius:8px;width:32px;height:32px;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;flex-shrink:0;transition:background .12s,color .12s,border-color .12s,box-shadow .12s}
/* Clip-card collapse: chevron rotates, body + tabs hidden, title
   replaced with a one-line summary span. */
.clip-toggle .ct-chev{transition:transform .15s ease}
.clip-card.collapsed .clip-toggle .ct-chev{transform:rotate(-90deg)}
.clip-card.collapsed .clip-tabs,
.clip-card.collapsed .clip-tab-panel,
.clip-card.collapsed .title-input{display:none}
.clip-card.collapsed .clip-header{margin-bottom:0;padding-bottom:0;border-bottom:0;flex-wrap:nowrap}
.clip-card.collapsed .clip-summary{display:inline-flex;align-items:center;gap:8px;flex:1;min-width:0;color:var(--muted);font-size:.92em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.clip-card.collapsed .clip-summary .cs-title{color:var(--ink);font-weight:600;overflow:hidden;text-overflow:ellipsis}
.clip-card.collapsed .clip-summary .cs-meta,
.clip-card.collapsed .clip-summary .cs-counts{color:var(--muted);font-variant-numeric:tabular-nums;flex-shrink:0}
.clip-card.collapsed .clip-summary-expand{appearance:none;background:transparent;border:0;color:var(--brand);font-size:1em;font-weight:600;padding:0;cursor:pointer;flex-shrink:0}
.clip-card.collapsed .clip-summary-expand:hover{text-decoration:underline;background:transparent}
.iconbtn-sm:hover{background:var(--brand-soft);color:var(--brand);border-color:var(--brand)}
.iconbtn-sm.active{background:var(--brand-soft);color:var(--brand);border-color:transparent}
.clip-kebab-btn svg{fill:currentColor;stroke:none}
.clip-toggle .ct-chev{width:16px;height:16px}
/* (Per-clip Settings popover styles removed — settings live in the
   "Settings" tab now; see .clip-tab-settings below.) */
/* Per-clip kebab menu */
.clip-kebab-pop{position:absolute;right:14px;top:54px;min-width:180px;background:var(--surface);border:1px solid var(--border);border-radius:10px;box-shadow:var(--shadow-elev);padding:6px;z-index:8}
.clip-kebab-pop button{appearance:none;background:transparent;border:0;border-radius:6px;padding:.55em .7em;text-align:left;display:block;width:100%;cursor:pointer;color:var(--ink);font-family:inherit;font-size:.9em}
.clip-kebab-pop button:hover{background:var(--surface-2)}
.clip-kebab-pop .clip-delete-btn{color:#dc2626}
.clip-kebab-pop .clip-delete-btn:hover{background:rgba(220,38,38,.08)}
.clip-card{position:relative}
/* 2-column body inside the Clip tab: player + range left, moments + captions right. */
.clip-grid{--left:52%;display:grid;grid-template-columns:minmax(280px,var(--left)) 12px minmax(260px,1fr);gap:10px;align-items:stretch}
.clip-grid-left,.clip-grid-right{min-width:0;min-height:0}
.clip-grid-right{height:var(--clip-grid-h,520px);display:flex;flex-direction:column;overflow:hidden}
.clip-grid-right .section-h{margin-top:0}
.clip-grid-right .moments-header{display:flex;flex-direction:column;align-items:flex-start;gap:2px;margin:0 0 .55em}
.clip-grid-right .moments-title-row{display:flex;align-items:center;gap:10px;width:100%;min-width:0}
.clip-grid-right .moments-label{font-size:.78rem;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.06em}
.clip-grid-right .moments-hint{font-size:.78em;color:var(--muted);font-weight:400;line-height:1.35}
.clip-grid-right .moments-actions{margin-left:auto;display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:flex-end}
.clip-grid-right .moments-actions button{appearance:none;background:var(--surface);color:var(--brand);border:1px solid var(--border);border-radius:6px;padding:.32em .6em;font-size:.74em;font-weight:700;cursor:pointer}
.clip-grid-right .moments-actions button:hover:not(:disabled){background:var(--brand-soft);border-color:var(--brand)}
.clip-grid-right .moments-actions button:disabled{opacity:.62;cursor:wait}
.clip-grid-right .right-pane-panel{display:none;flex:1;min-height:0;flex-direction:column}
.clip-grid-right[data-right-tab="captions"] .right-pane-captions{display:flex}
.clip-grid-right[data-right-tab="illustrations"] .right-pane-illustrations{display:flex}
.clip-grid-right .point-captions,
.clip-grid-right .point-illustrations{flex:1;min-height:0;overflow-y:auto;padding-right:4px}
@media(max-width:900px){.clip-grid{grid-template-columns:1fr}.clip-grid .layout-splitter{display:none}.clip-grid-right{height:auto;overflow:visible}.clip-grid-right .right-pane-panel{min-height:0}.clip-grid-right .point-captions,.clip-grid-right .point-illustrations{max-height:none;overflow:visible}}

/* Drag splitters for side-by-side review panes. */
.layout-splitter{position:relative;align-self:stretch;min-height:120px;border:0;background:transparent;border-radius:8px;cursor:col-resize;touch-action:none;display:flex;align-items:center;justify-content:center;color:var(--muted)}
.layout-splitter::before{content:"";width:2px;height:100%;max-height:100%;border-radius:2px;background:var(--border-strong);opacity:.9}
.layout-splitter::after{content:"";position:absolute;width:8px;height:32px;border-left:2px solid var(--border-strong);border-right:2px solid var(--border-strong);border-radius:2px;opacity:.75;background:var(--surface)}
.layout-splitter:hover::before,.layout-splitter:focus-visible::before,.layout-splitter.dragging::before{background:var(--brand);opacity:1}
.layout-splitter:hover::after,.layout-splitter:focus-visible::after,.layout-splitter.dragging::after{border-color:var(--brand);box-shadow:0 0 0 3px var(--brand-soft)}
body.is-resizing,body.is-resizing *{cursor:col-resize!important;user-select:none!important}
/* Right-side moment editor tabs (Captions | Illustrations) */
.right-pane-tabs{display:flex;gap:4px;border-bottom:1px solid var(--border);margin:0 0 10px}
.right-pane-tab{appearance:none;background:transparent;color:var(--muted);border:0;border-bottom:2px solid transparent;border-radius:0;padding:.42em .72em;font-size:.82em;font-weight:600;cursor:pointer;font-family:inherit}
.right-pane-tab:hover{color:var(--ink)}
.right-pane-tab.active{color:var(--ink);border-bottom-color:var(--brand)}
.illustrations-header{margin-bottom:8px}
.illustrations-title-row{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:6px}
.illustrations-label{font-size:.84em;font-weight:760;text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}
.illustrations-actions{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}
.illustrations-actions button{appearance:none;background:var(--surface);color:var(--brand);border:1px solid var(--border);border-radius:6px;padding:.34em .68em;font-size:.78em;font-weight:730;cursor:pointer}
.illustrations-actions button:hover:not(:disabled){background:var(--brand-soft);border-color:var(--brand)}
.illustrations-actions button:disabled{opacity:.62;cursor:wait}
.illustrations-toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.illustrations-hint{flex:1;min-width:180px;line-height:1.35}
/* Inner clip tabs (Clip | Rendered (N)) */
.clip-tabs{display:flex;gap:4px;border-bottom:1px solid var(--border);margin:0 0 14px}
.clip-tab{appearance:none;background:transparent;color:var(--muted);border:0;border-bottom:2px solid transparent;border-radius:0;padding:.45em .85em;font-size:.85em;font-weight:500;cursor:pointer;font-family:inherit}
.clip-tab:hover{color:var(--ink)}
.clip-tab.active{color:var(--ink);border-bottom-color:var(--brand);font-weight:600}
.clip-tab-count{display:inline-flex;align-items:center;justify-content:center;min-width:18px;padding:0 6px;border-radius:999px;background:var(--surface-2);color:var(--muted);font-size:.74em;font-weight:600;margin-left:4px}
.clip-tab.active .clip-tab-count{background:var(--brand-soft);color:var(--brand)}
.clip-tab-panel{display:none}
.clip-card[data-active-tab="clip"] .clip-tab-clip{display:block}
.clip-card[data-active-tab="rendered"] .clip-tab-rendered{display:block}
.clip-card[data-active-tab="settings"] .clip-tab-settings{display:block}
/* Per-clip Settings tab body (caption swatches + animation + reframe) */
.clip-tab-settings{padding:.4em 0 .8em}
.clip-tab-settings .cs-row{display:flex;align-items:flex-start;gap:14px;margin:.8em 0}
.clip-tab-settings .cs-label{flex-basis:110px;color:var(--muted);font-size:.85em;font-weight:500;padding-top:.3em}
.clip-tab-settings .cs-styles{display:flex;gap:10px;flex:1;min-width:0;overflow-x:auto;overflow-y:hidden;padding:4px 2px 12px;scroll-snap-type:x proximity;scroll-padding-inline:2px}
.clip-tab-settings .cs-style-pick{position:relative;display:flex;flex:0 0 132px;scroll-snap-align:start;flex-direction:column;gap:7px;align-items:stretch;cursor:pointer;padding:8px;border:1px solid var(--border);border-radius:10px;background:var(--surface);transition:border-color .12s,box-shadow .12s,background-color .12s,transform .12s}
.clip-tab-settings .cs-style-pick input{position:absolute;opacity:0;pointer-events:none}
.clip-tab-settings .cs-style-thumb{width:100%;aspect-ratio:9/16;border-radius:8px;border:2px solid transparent;display:block;background:#000;object-fit:cover;transition:border-color .12s,transform .12s,filter .12s}
.clip-tab-settings .cs-style-thumb-fallback{background:linear-gradient(135deg,var(--surface-2),var(--surface));border-color:var(--border)}
.clip-tab-settings .cs-style-pick:hover{border-color:var(--border-strong);transform:translateY(-1px)}
.clip-tab-settings .cs-style-pick:has(input:checked){background:var(--accent-soft);border-color:var(--accent);box-shadow:0 0 0 3px rgba(251,176,59,.22),var(--shadow)}
.clip-tab-settings .cs-style-pick:has(input:checked)::after{content:"Selected";position:absolute;top:14px;right:14px;background:var(--accent);color:#111;border-radius:999px;padding:3px 7px;font-size:.62em;font-weight:800;line-height:1;text-transform:uppercase;letter-spacing:0}
.clip-tab-settings .cs-style-pick:has(input:checked) .cs-style-thumb{border-color:#111;filter:saturate(1.08) contrast(1.04)}
.clip-tab-settings .cs-style-pick input:checked + .cs-style-thumb,
.clip-tab-settings .cs-style-pick input:focus-visible + .cs-style-thumb{border-color:var(--accent)}
.clip-tab-settings .cs-style-name{display:block;text-align:center;font-size:.78em;color:var(--muted);font-weight:650;text-transform:lowercase;line-height:1.15;min-height:2.3em;overflow-wrap:anywhere}
.clip-tab-settings .cs-style-pick input:checked ~ .cs-style-name{color:var(--ink);font-weight:800}
.clip-tab-settings .cs-anim,
.clip-tab-settings .cs-reframe{flex:1;background:var(--surface);color:var(--ink);border:1px solid var(--border);border-radius:8px;padding:.5em .7em;font-size:.9em;font-family:inherit}
.clip-tab-settings .cs-face-row,
.clip-tab-settings .cs-voice-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;flex:1}
.clip-tab-settings .cs-face-row{align-items:flex-start}
.clip-tab-settings .cs-face-stack{display:flex;flex-direction:column;gap:4px;min-width:138px;max-width:260px}
.clip-tab-settings .cs-face-enable,
.clip-tab-settings .cs-voice-enable{display:inline-flex;align-items:center;gap:8px;color:var(--ink);font-size:.9em}
.clip-tab-settings .cs-face-enable input,
.clip-tab-settings .cs-voice-enable input{width:16px;height:16px;accent-color:var(--brand)}
.clip-tab-settings .cs-face-enable em,
.clip-tab-settings .cs-voice-enable em{display:inline-flex;margin-left:4px;color:var(--accent);font-style:normal;font-size:.82em;font-weight:700;text-transform:uppercase;letter-spacing:.04em}
.clip-tab-settings .cs-face-control{display:flex;align-items:center;gap:6px;color:var(--muted);font-size:.82em;font-weight:650}
.clip-tab-settings .cs-face-imitate{display:inline-flex;align-items:center;gap:7px;color:var(--ink);font-size:.86em;font-weight:650;padding:.42em .1em}
.clip-tab-settings .cs-face-imitate input{width:16px;height:16px;accent-color:var(--brand)}
.clip-tab-settings .cs-face-blur,
.clip-tab-settings .cs-face-emoji{background:var(--surface);color:var(--ink);border:1px solid var(--border);border-radius:8px;padding:.45em .6em;font-size:1em;font-family:inherit}
.clip-tab-settings .cs-face-blur{width:104px}
.clip-tab-settings .cs-face-emoji{width:112px}
.clip-tab-settings .cs-face-hint{line-height:1.3;max-width:260px}
.clip-tab-settings .cs-face-hint:empty{display:none}
.clip-tab-settings .cs-face-hint.is-warn{color:#b45309}
.clip-tab-settings .cs-face-hint.is-ok{color:var(--muted)}
.clip-tab-settings .cs-voice-select{flex:1;min-width:190px;max-width:320px;background:var(--surface);color:var(--ink);border:1px solid var(--border);border-radius:8px;padding:.5em .7em;font-size:.9em;font-family:inherit}
.clip-tab-settings .cs-voice-preview{flex-shrink:0}
.clip-tab-settings .cs-voice-status{min-width:72px}
/* Empty placeholder grid behind the "none yet" hint */
.render-empty-grid{margin-top:10px}
.render-empty-grid .render-card-empty{background:repeating-linear-gradient(135deg,var(--surface-2),var(--surface-2) 8px,var(--surface) 8px,var(--surface) 16px);border:1px dashed var(--border-strong);border-radius:10px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;color:var(--muted);text-align:center;padding:18px 14px}
.render-empty-grid .render-card-empty-solo{min-height:160px}
.render-empty-grid .rce-label{font-size:.92em;font-weight:500;color:var(--muted)}

/* Point ticks on the range trackbar */
.ticks{position:absolute;inset:0;pointer-events:none}
.tick{position:absolute;top:4px;bottom:4px;width:2px;margin-left:-1px;background:var(--brand);opacity:.45;border-radius:1px}
.tick:hover{opacity:1;background:var(--accent);z-index:2}
/* Suggested-clip markers above the trackbar (✨). Shows where the
   algorithm originally suggested start + end, so the user can see
   how much they've drifted from the suggestion. */
.range-suggest{position:absolute;bottom:calc(100% + 16px);transform:translateX(-50%);font-size:.85em;line-height:1;pointer-events:none;user-select:none;text-shadow:0 1px 2px rgba(0,0,0,.15)}
/* Tick stacks: #N line on top, phrase below the bar. */
.tick-num{position:absolute;bottom:calc(100% + 4px);left:0;transform:translateX(-50%);font-size:.66em;font-weight:700;color:var(--accent);white-space:nowrap;padding:0 3px;pointer-events:none;background:var(--surface);border-radius:3px;letter-spacing:0}
.tick-label{position:absolute;top:calc(100% + 4px);left:0;transform:translateX(-50%);font-size:.66em;color:var(--muted);white-space:nowrap;padding:0 4px;pointer-events:none;background:var(--surface);border-radius:3px;letter-spacing:0;font-weight:500;max-width:120px;overflow:hidden;text-overflow:ellipsis}
.tick:hover .tick-num{color:var(--ink);background:var(--accent-soft);z-index:2}
.tick:hover .tick-label{color:var(--ink);background:var(--accent-soft);z-index:2}
/* Reserve room above and below the range track for the two label
   lines + the ✨ suggestion marker that floats above the #N labels. */
.clip-card .range-track{margin-top:36px;margin-bottom:24px}

/* Per-point caption list */
.point-captions{display:flex;flex-direction:column;gap:8px}
.point-caption{position:relative;background:var(--surface-2);border:1px solid var(--border);border-radius:8px;padding:8px 10px}
.point-caption .pt-head{display:flex;align-items:baseline;gap:6px;font-variant-numeric:tabular-nums;line-height:1.15;min-width:0}
.point-caption .pt-num{color:var(--accent);font-weight:600;font-size:.88em}
.point-caption .pt-time{color:var(--muted);font-size:.82em}
.point-caption .pt-span{color:var(--muted);font-size:.78em}
.point-caption .pt-thumb-wrap{position:relative;width:120px;align-self:start}
.point-caption .pt-illustration-pick{appearance:none;position:absolute;left:5px;top:5px;z-index:4;width:28px;height:28px;border:1px solid rgba(37,99,235,.45);border-radius:6px;background:rgba(255,255,255,.92);box-shadow:0 2px 8px rgba(0,0,0,.24);display:inline-flex;align-items:center;justify-content:center;cursor:pointer}
.point-caption .pt-illustration-pick input{position:absolute;opacity:0;pointer-events:none}
.point-caption .pt-illustration-pick span{width:16px;height:16px;border:2px solid #2563eb;border-radius:4px;background:#fff;display:block}
.point-caption .pt-illustration-pick input:checked + span{background:#2563eb;background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='white' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'><polyline points='5 12 10 17 19 7'/></svg>");background-size:12px 12px;background-repeat:no-repeat;background-position:center}
.point-caption .pt-crop-toggle{appearance:none;position:absolute;top:5px;right:5px;z-index:3;background:rgba(255,255,255,.92);color:#2563eb;border:1px solid rgba(37,99,235,.45);border-radius:6px;width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center;padding:0;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.24)}
.point-caption .pt-crop-toggle svg{fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.point-caption .pt-crop-toggle:hover,.point-caption .pt-crop-toggle[aria-expanded="true"]{background:#fff;color:#1d4ed8;border-color:#2563eb}
.point-caption .pt-crop-toggle.has-crop{color:var(--brand);border-color:var(--brand);background:var(--brand-soft)}
.point-caption .pt-body{display:grid;grid-template-columns:120px 1fr;gap:10px;align-items:stretch}
.point-caption .pt-media{display:flex;flex-direction:column;gap:6px;min-width:0}
.point-caption .pt-thumb{width:100%;aspect-ratio:16/9;border-radius:6px;background:#000;cursor:pointer;display:block;object-fit:cover}
.point-caption .pt-thumb:hover{outline:2px solid var(--brand);outline-offset:1px}
.point-caption .pt-edit{display:flex;flex-direction:column;gap:8px;min-width:0}
.point-caption textarea{width:100%;height:100%;min-height:96px;background:var(--surface);color:var(--ink);border:1px solid var(--border);border-radius:6px;padding:.5em .65em;font-size:.9em;line-height:1.45;resize:vertical}
.point-caption .pt-meta-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.point-caption .pt-illustration-badge,
.point-illustration .ill-badge{display:inline-flex;align-items:center;min-height:22px;border:1px solid var(--border);border-radius:999px;background:var(--surface);color:var(--muted);padding:.14em .55em;font-size:.72em;font-weight:720;line-height:1.2}
.point-caption .pt-illustration-badge.is-active,
.point-illustration .ill-badge.is-active{background:var(--brand-soft);border-color:rgba(37,99,235,.35);color:var(--brand)}
.point-caption .pt-illustration-badge.is-missing,
.point-illustration .ill-badge.is-missing{background:#fff7ed;border-color:#fed7aa;color:#b45309}
.point-caption .pt-illustration-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.point-caption .pt-illustration-row label{display:inline-flex;align-items:center;gap:6px;color:var(--muted);font-size:.78em;font-weight:650}
.point-caption .pt-illustration-row select{appearance:none;background:var(--surface);color:var(--ink);border:1px solid var(--border);border-radius:6px;padding:.34em 1.4em .34em .5em;font:inherit;font-weight:650}
.point-caption .pt-illustration-row button{appearance:none;background:var(--surface);color:var(--brand);border:1px solid var(--border);border-radius:6px;padding:.36em .7em;font-size:.78em;font-weight:700;cursor:pointer}
.point-caption .pt-illustration-row button:hover:not(:disabled){background:var(--brand-soft);border-color:var(--brand)}
.point-caption .pt-illustration-row button:disabled{opacity:.62;cursor:wait}
.point-caption .pt-illustration-status{min-width:96px;max-width:100%;white-space:pre-wrap;overflow-wrap:anywhere}
.point-caption .pt-crop-panel{position:absolute;right:10px;top:38px;z-index:25;width:min(520px,calc(100vw - 48px));background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:8px;box-shadow:var(--shadow-elev)}
.point-caption .pt-crop-stage{position:relative;width:min(100%,420px);aspect-ratio:16/9;background:#050505;border:1px solid var(--border-strong);border-radius:8px;overflow:hidden;touch-action:none;user-select:none}
.point-caption .pt-crop-img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block}
.point-caption .pt-crop-rect{position:absolute;border:2px solid var(--brand);box-shadow:0 0 0 9999px rgba(0,0,0,.46);cursor:move;min-width:22px;min-height:22px}
.point-caption .pt-crop-handle{position:absolute;width:14px;height:14px;background:var(--brand);border:2px solid #fff;border-radius:999px;box-shadow:0 1px 4px rgba(0,0,0,.35)}
.point-caption .pt-crop-handle[data-handle="nw"]{left:-8px;top:-8px;cursor:nwse-resize}
.point-caption .pt-crop-handle[data-handle="ne"]{right:-8px;top:-8px;cursor:nesw-resize}
.point-caption .pt-crop-handle[data-handle="sw"]{left:-8px;bottom:-8px;cursor:nesw-resize}
.point-caption .pt-crop-handle[data-handle="se"]{right:-8px;bottom:-8px;cursor:nwse-resize}
.point-caption .pt-crop-actions{display:flex;align-items:center;gap:6px;justify-content:flex-end;margin-top:7px}
.point-caption .pt-crop-actions button{font-size:.74em;padding:.35em .6em;border-radius:6px}
.point-captions-empty{color:var(--muted);font-size:.85em;background:var(--surface-2);border:1px dashed var(--border-strong);border-radius:8px;padding:.7em}
.point-illustrations{display:flex;flex-direction:column;gap:8px}
.point-illustration{position:relative;background:var(--surface-2);border:1px solid var(--border);border-radius:8px;padding:8px 10px}
.point-illustration .ill-body{display:grid;grid-template-columns:120px 1fr;gap:10px;align-items:stretch}
.point-illustration .ill-media{display:flex;flex-direction:column;gap:6px;min-width:0}
.point-illustration .ill-thumb-wrap{position:relative;width:120px;aspect-ratio:16/9;align-self:start}
.point-illustration .ill-thumb,
.point-illustration .ill-thumb-video{width:100%;aspect-ratio:16/9;border-radius:6px;background:#000;display:block;object-fit:cover}
.point-illustration .ill-thumb-video{position:absolute;inset:0;height:100%}
.point-illustration .ill-empty-thumb{appearance:none;width:100%;aspect-ratio:16/9;border-radius:6px;border:1px dashed var(--border-strong);background:var(--surface);color:var(--muted);font:inherit;font-size:.72em;font-weight:750;line-height:1.2;display:flex;align-items:center;justify-content:center;text-align:center;padding:8px;cursor:pointer}
.point-illustration .ill-empty-thumb:hover{border-color:var(--brand);color:var(--brand);background:var(--brand-soft)}
.point-illustration.is-inherited{border-color:rgba(37,99,235,.22);background:rgba(37,99,235,.04)}
.point-illustration .pt-illustration-pick{appearance:none;position:absolute;left:5px;top:5px;z-index:4;width:28px;height:28px;border:1px solid rgba(37,99,235,.45);border-radius:6px;background:rgba(255,255,255,.92);box-shadow:0 2px 8px rgba(0,0,0,.24);display:inline-flex;align-items:center;justify-content:center;cursor:pointer}
.point-illustration .pt-illustration-pick input{position:absolute;opacity:0;pointer-events:none}
.point-illustration .pt-illustration-pick span{width:16px;height:16px;border:2px solid #2563eb;border-radius:4px;background:#fff;display:block}
.point-illustration .pt-illustration-pick input:checked + span{background:#2563eb;background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='white' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'><polyline points='5 12 10 17 19 7'/></svg>");background-size:12px 12px;background-repeat:no-repeat;background-position:center}
.point-illustration .ill-head{display:flex;align-items:baseline;gap:6px;font-variant-numeric:tabular-nums;line-height:1.15;min-width:0}
.point-illustration .ill-num{color:var(--accent);font-weight:600;font-size:.88em}
.point-illustration .ill-time,
.point-illustration .ill-span{color:var(--muted);font-size:.82em}
.point-illustration .ill-edit{display:flex;flex-direction:column;gap:8px;min-width:0}
.point-illustration .ill-title-row{display:flex;align-items:center;gap:8px;min-width:0}
.point-illustration .ill-text{margin:0;color:var(--ink);font-size:.82em;line-height:1.28;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;flex:1}
.point-illustration .ill-controls{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.point-illustration .ill-controls label{display:inline-flex;align-items:center;gap:6px;color:var(--muted);font-size:.78em;font-weight:650}
.point-illustration .ill-row-status{display:inline-flex;align-items:center;gap:6px;color:var(--muted);font-size:.78em;font-weight:730;white-space:nowrap}
.point-illustration .ill-row-status.is-active{color:var(--brand)}
.point-illustration .ill-row-status.is-missing{color:#b45309}
.point-illustration .ill-row-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.point-illustration .ill-preview-btn{appearance:none;background:var(--surface);color:var(--ink);border:1px solid var(--border);border-radius:6px;padding:.34em .65em;font-size:.78em;font-weight:700;cursor:pointer}
.point-illustration .ill-preview-btn:hover{background:var(--brand-soft);border-color:var(--brand);color:var(--brand)}
.point-illustration .pt-illustration-mode{appearance:none;background:var(--surface);color:var(--ink);border:1px solid var(--border);border-radius:6px;padding:.34em 1.4em .34em .5em;font:inherit;font-weight:650}
.point-illustration .pt-illustration-asset{appearance:none;background:var(--surface);color:var(--ink);border:1px solid var(--border);border-radius:6px;padding:.34em 1.4em .34em .5em;font:inherit;font-weight:650;max-width:260px}
.point-illustration .pt-illustration-generate{appearance:none;background:var(--surface);color:var(--brand);border:1px solid var(--border);border-radius:6px;padding:.36em .7em;font-size:.78em;font-weight:700;cursor:pointer}
.point-illustration .pt-illustration-generate:hover:not(:disabled){background:var(--brand-soft);border-color:var(--brand)}
.point-illustration .pt-illustration-generate:disabled{opacity:.62;cursor:wait}
.point-illustration .pt-illustration-status{display:none}
@media(max-width:640px){
  .point-caption .pt-body{grid-template-columns:96px 1fr}
  .point-caption .pt-thumb-wrap{width:96px}
  .point-illustration .ill-body{grid-template-columns:96px 1fr}
  .point-illustration .ill-thumb-wrap{width:96px}
  .point-caption .pt-crop-panel{position:static;width:100%;margin-top:8px}
}

/* Timeline tab */
.timeline-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:.4em}
.timeline-host{margin-top:.6em}
.tl-row{position:relative;height:30px;background:var(--surface-2);border:1px solid var(--border);border-radius:6px;margin-bottom:6px;overflow:hidden}
.tl-row.tl-source{height:22px;background:var(--surface);border-color:var(--border)}
.tl-tick{position:absolute;top:4px;bottom:4px;width:2px;margin-left:-1px;background:var(--brand);opacity:.45;border-radius:1px;pointer-events:none}
.tl-bar{position:absolute;top:4px;bottom:4px;background:var(--ok-soft);border:1px solid var(--ok);border-radius:4px;cursor:pointer;color:var(--ink);font-size:.76em;line-height:22px;padding:0 6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tl-bar:hover{filter:brightness(.95)}
.tl-bar.active{outline:2px solid var(--accent);outline-offset:1px}
.tl-row-label{position:absolute;left:6px;top:50%;transform:translateY(-50%);font-size:.72em;color:var(--muted);pointer-events:none;z-index:1;background:var(--surface);padding:1px 4px;border-radius:3px}

/* Per-clip preview player + range slider */
.clip-range{margin-bottom:.5em}
.clip-player{width:100%;height:auto;background:#000;border-radius:10px;display:block}
.clip-video-wrap{position:relative;container-type:inline-size;overflow:hidden;border-radius:10px}
.clip-illustration-player{display:none;position:absolute;inset:0;width:100%;height:100%;object-fit:cover;background:#000;z-index:2;pointer-events:none}
.clip-video-wrap[data-illustration-mode]{background:#000;aspect-ratio:16/9}
.clip-video-wrap[data-illustration-mode] .clip-player{position:absolute;top:0;left:0;height:100%;border-radius:0}
.clip-video-wrap[data-illustration-mode] .clip-player::-webkit-media-controls-panel{display:none!important}
.clip-video-wrap[data-illustration-mode="side_by_side"] .clip-player{width:50%;object-fit:cover}
.clip-video-wrap[data-illustration-mode="side_by_side"] .clip-illustration-player{display:block;left:50%;right:auto;width:50%}
.clip-video-wrap[data-illustration-mode="side_by_side"] .caption-overlay{left:4%;right:54%}
.clip-video-wrap[data-illustration-mode="side_by_side"] .face-emoji-overlay{right:50%;width:50%}
.clip-video-wrap[data-illustration-mode="animation_only"] .clip-player{width:100%;opacity:0}
.clip-video-wrap[data-illustration-mode="animation_only"] .clip-illustration-player{display:block}
.clip-video-wrap[data-illustration-mode="animation_only"] .face-emoji-overlay{display:none}
.clip-video-wrap[data-preview-aspect]{background:#000;border-radius:10px;overflow:hidden;margin-inline:auto;box-shadow:var(--shadow)}
.clip-video-wrap[data-preview-aspect="9:16"]{width:min(100%,420px);aspect-ratio:9/16}
.clip-video-wrap[data-preview-aspect="1:1"]{width:min(100%,620px);aspect-ratio:1/1}
.clip-video-wrap[data-preview-aspect="4:5"]{width:min(100%,540px);aspect-ratio:4/5}
.clip-video-wrap[data-preview-aspect="16:9"]{width:100%;aspect-ratio:16/9}
.clip-video-wrap[data-preview-aspect] .clip-player{width:100%;height:100%;aspect-ratio:auto;border-radius:0;object-fit:contain}
.clip-video-wrap[data-preview-aspect][data-crop-preview="1"] .clip-player{object-fit:cover}
.clip-video-wrap[data-preview-aspect][data-illustration-mode="side_by_side"] .clip-player{width:50%;height:100%;object-fit:cover}
.clip-video-wrap[data-preview-aspect][data-illustration-mode="side_by_side"] .clip-illustration-player{left:50%;width:50%;height:100%;object-fit:cover}
.clip-video-wrap[data-preview-aspect][data-illustration-mode="animation_only"] .clip-player{width:100%;opacity:0}
.clip-video-wrap[data-preview-aspect][data-illustration-mode="animation_only"] .clip-illustration-player{width:100%;height:100%;object-fit:cover}
.clip-video-wrap .clip-player,.clip-video-wrap .face-emoji-overlay{transform-origin:0 0}
.clip-preview-controls{margin-left:auto;display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end;max-width:100%}
.clip-preview-format,.clip-crop-toggle{display:inline-flex;align-items:center;gap:6px;background:var(--surface-2);color:var(--ink);border:1px solid var(--border);border-radius:8px;padding:.34em .55em;font-size:.76em;font-weight:650}
.clip-preview-format span,.clip-crop-toggle span{white-space:nowrap}
.clip-preview-aspect{appearance:none;background:var(--surface);color:var(--ink);border:1px solid var(--border-strong);border-radius:6px;padding:.18em 1.55em .18em .45em;font:inherit;font-weight:600;max-width:170px}
.clip-preview-aspect:focus{outline:none;border-color:var(--brand)}
.clip-preview-aspect option{color:#111;background:#fff}
.clip-crop-toggle input{accent-color:var(--brand);width:14px;height:14px;margin:0}
@media(max-width:720px){
  .clip-preview-controls{margin-left:0;flex-basis:100%;justify-content:flex-end}
  .clip-preview-format{max-width:100%}
  .clip-preview-aspect{max-width:130px}
}
.caption-overlay{position:absolute;z-index:4;left:var(--cap-pad-x,36%);right:var(--cap-pad-x,36%);bottom:var(--cap-pad-bottom,20%);top:auto;text-align:center;pointer-events:none;font-weight:800;line-height:1.18;letter-spacing:.01em;container-type:inline-size}
.caption-overlay[data-placement="top"]{top:var(--cap-pad-top,8%);bottom:auto}
.caption-overlay[data-placement="bottom"]{bottom:var(--cap-pad-bottom,20%);top:auto}
.caption-overlay{font-size:clamp(9px, 7cqw, 18px)}
.caption-overlay .cap{display:inline-block;padding:.18em .35em;border-radius:6px;max-width:100%}
.caption-overlay .cap-word{display:inline-block;white-space:nowrap}
.caption-overlay .cap-word + .cap-word{margin-left:.32em}
.caption-overlay:empty{display:none}
.caption-overlay[data-style-base="plain"] .cap{color:#fff;text-shadow:-1px -1px 0 #000,1px -1px 0 #000,-1px 1px 0 #000,1px 1px 0 #000;background:transparent}
.caption-overlay[data-style-base="bold-white"] .cap{color:#fff;text-shadow:-2px -2px 0 #000,2px -2px 0 #000,-2px 2px 0 #000,2px 2px 0 #000,0 0 6px rgba(0,0,0,.85);background:transparent}
.caption-overlay[data-style-base="tiktok-yellow"] .cap{color:#0e1115;background:#ffd60a;box-shadow:0 2px 0 rgba(0,0,0,.35)}
.caption-overlay[data-style-base="beast-impact"] .cap{color:#ffd60a;text-transform:uppercase;font-family:Impact,"Arial Black",-apple-system,sans-serif;letter-spacing:.04em;text-shadow:-3px -3px 0 #000,3px -3px 0 #000,-3px 3px 0 #000,3px 3px 0 #000,0 4px 8px rgba(0,0,0,.7)}
.caption-overlay[data-style-base="karaoke"] .cap{color:#fff;text-shadow:-2px -2px 0 #000,2px -2px 0 #000,-2px 2px 0 #000,2px 2px 0 #000;background:transparent}
.caption-overlay[data-style-base="karaoke"] .cap-word.active{background:#ffd60a;color:#0e1115;border-radius:4px;text-shadow:none}
.caption-overlay[data-style-base="creator-thin"] .cap{color:#fff;font-weight:500;text-shadow:-1px -1px 0 #000,1px -1px 0 #000,-1px 1px 0 #000,1px 1px 0 #000;background:transparent}
.caption-overlay[data-style-base="neon"] .cap{color:#ff00ff;text-shadow:-2px -2px 0 #00ffff,2px -2px 0 #00ffff,-2px 2px 0 #00ffff,2px 2px 0 #00ffff,0 0 10px rgba(0,255,255,.8);background:transparent}
.caption-overlay[data-style-base="pastel"] .cap{color:#0e1115;background:rgba(255,182,193,.7);box-shadow:0 2px 8px rgba(0,0,0,.18)}
/* Word-by-word animations (independent of style) */
.caption-overlay .cap-word{transition:transform .12s ease, opacity .12s ease}
.caption-overlay[data-anim="word-highlight"] .cap-word.active{transform:scale(1.18);transform-origin:center bottom}
.caption-overlay[data-anim="word-pop"] .cap-word.hidden{display:none}
.caption-overlay[data-anim="word-pop"] .cap-word.active{animation:capPopIn .18s ease both}
@keyframes capPopIn{from{transform:scale(.7);opacity:0}to{transform:scale(1);opacity:1}}
.face-emoji-overlay{position:absolute;z-index:3;inset:0;pointer-events:none;overflow:hidden}
.face-emoji-overlay:empty{display:none}
.face-emoji-overlay .face-blur{position:absolute;transform:translate(-50%,-50%);border-radius:48% 48% 54% 54%;background:rgba(255,255,255,.08);box-shadow:inset 0 0 0 1px rgba(255,255,255,.14);user-select:none}
.face-emoji-overlay .face-blur-soft{backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px)}
.face-emoji-overlay .face-blur-strong{backdrop-filter:blur(22px);-webkit-backdrop-filter:blur(22px)}
.face-emoji-overlay .face-emoji{position:absolute;transform:translate(-50%,-50%);filter:drop-shadow(0 2px 4px rgba(0,0,0,.55));line-height:1;object-fit:contain;user-select:none}
.face-emoji-overlay .face-mouth{position:absolute;transform:translate(-50%,-50%);filter:drop-shadow(0 1px 2px rgba(0,0,0,.38));object-fit:contain;user-select:none}
.clip-time{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-top:6px;font-size:.82em;color:var(--muted);font-variant-numeric:tabular-nums}
.clip-time .ct-cur{color:var(--ink);font-weight:600}
.clip-time .ct-rel{color:var(--accent)}
.range-track{position:relative;height:28px;margin-top:10px;background:var(--surface-2);border-radius:8px;border:1px solid var(--border)}
.range-active{position:absolute;top:0;bottom:0;background:var(--brand-soft);pointer-events:none;border-radius:6px}
.range-playhead{position:absolute;top:-6px;bottom:-6px;width:3px;margin-left:-1.5px;background:var(--accent);box-shadow:0 0 6px var(--accent-soft);left:0;cursor:ew-resize;z-index:3;border-radius:2px}
.range-playhead::before{content:"";position:absolute;top:-6px;left:50%;transform:translateX(-50%);border:5px solid transparent;border-top-color:var(--accent);border-bottom:0;width:0;height:0}
.range-active.looping{background:var(--accent-soft)}
.play-region.looping{background:var(--accent);color:#fff;border-color:transparent}
.range-handle{position:absolute;top:-2px;bottom:-2px;width:12px;margin-left:-6px;background:var(--brand);border-radius:4px;cursor:ew-resize;box-shadow:0 0 0 2px var(--surface),0 1px 4px rgba(0,0,0,.2)}
.range-handle::after{content:"";position:absolute;left:50%;top:50%;width:2px;height:12px;margin:-6px 0 0 -1px;background:rgba(255,255,255,.7);border-radius:1px;box-shadow:3px 0 0 rgba(255,255,255,.7),-3px 0 0 rgba(255,255,255,.7)}
.range-handle:focus{outline:2px solid var(--accent);outline-offset:2px}
.range-vals{display:flex;flex-wrap:wrap;gap:12px;align-items:center;margin-top:8px;font-size:.84em;color:var(--muted)}
.range-vals .range-dur{color:var(--muted)}
.range-vals .play-region{margin-left:auto}
.range-hint{margin-top:.45em;font-size:.78em;color:var(--muted)}
.range-hint kbd{display:inline-block;padding:0 .35em;border:1px solid var(--border);border-bottom-width:2px;border-radius:4px;background:var(--surface);font-family:"SF Mono",Menlo,Consolas,monospace;font-size:.85em}

.segments{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}
@media(max-width:760px){.segments{grid-template-columns:repeat(2,minmax(0,1fr))}}
.segment-cell{display:flex;flex-direction:column;gap:4px;min-width:0}
.segment-thumb{width:100%;border-radius:6px;display:block;cursor:pointer;transition:transform .12s ease}
.segment-thumb:hover{transform:scale(1.03)}
.segment-time{color:var(--muted);font-size:.72em;font-variant-numeric:tabular-nums}

/* Caption-style swatches */
.styles{display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:8px}
.style-pick{position:relative;display:block;cursor:pointer}
.style-pick input{position:absolute;opacity:0;pointer-events:none}
.style-pick img{width:100%;border-radius:8px;border:2px solid transparent;display:block;background:#000;transition:border-color .12s}
.style-pick span{display:block;text-align:center;font-size:.7em;color:var(--muted);margin-top:.25em;text-transform:lowercase}
.style-pick input:checked + img{border-color:var(--accent)}

/* Past renders */
.renders{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px}
.render-card{position:relative;background:var(--surface);border:1px solid var(--border);border-radius:10px;overflow:hidden;display:flex;flex-direction:column;box-shadow:var(--shadow)}
.render-card video{width:100%;display:block;background:#000;aspect-ratio:9/16}
.render-card .render-meta{padding:.5em .7em;display:flex;justify-content:space-between;align-items:center;font-size:.78em}
.render-card .render-stamp{color:var(--muted);font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.render-card .render-dl{color:var(--brand);text-decoration:none;font-weight:600}
.render-card .render-dl:hover{text-decoration:underline}
.render-actions{display:inline-flex;align-items:center;gap:6px;flex-shrink:0}
.render-kebab-btn{appearance:none;background:transparent;color:var(--muted);border:1px solid transparent;border-radius:6px;width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center;padding:0;font-weight:800;line-height:1}
.render-kebab-btn:hover,.render-kebab-btn[aria-expanded="true"]{background:var(--surface-2);color:var(--ink);border-color:var(--border)}
.render-kebab-pop{position:absolute;right:8px;bottom:36px;min-width:150px;background:var(--surface);border:1px solid var(--border);border-radius:8px;box-shadow:var(--shadow-elev);padding:5px;z-index:12}
.render-kebab-pop button{appearance:none;background:transparent;border:0;border-radius:6px;padding:.5em .65em;text-align:left;display:block;width:100%;cursor:pointer;color:#dc2626;font-family:inherit;font-size:.86em}
.render-kebab-pop button:hover{background:rgba(220,38,38,.08)}
.renders-empty{padding:.7em;background:var(--surface-2);border:1px dashed var(--border-strong);border-radius:8px;color:var(--muted);font-size:.85em;grid-column:1/-1}

/* Add Clip dialog */
/* Render… dialog */
.render-modal{position:fixed;inset:0;z-index:50}
.render-modal[hidden]{display:none}
.render-modal .rm-overlay{position:absolute;inset:0;background:rgba(0,0,0,.42)}
.render-modal .rm-pane{position:relative;width:min(760px,calc(100vw - 28px));margin:4vh auto 0;background:var(--surface);border:1px solid var(--border);border-radius:12px;box-shadow:var(--shadow-elev);padding:18px 20px;display:flex;flex-direction:column;gap:12px;max-height:92vh;min-height:0;overflow:hidden}
.render-modal.rendering .rm-pane{height:calc(100vh - 32px);height:calc(100dvh - 32px);max-height:calc(100vh - 32px);max-height:calc(100dvh - 32px);margin:16px auto}
.render-modal .rm-head{display:flex;align-items:center;justify-content:space-between;gap:10px}
.render-modal .rm-head,.render-modal .rm-sub,.render-modal .rm-name-row,.render-modal .rm-foot{flex:0 0 auto}
.render-modal .rm-head h3{margin:0;font-size:1.05rem;font-weight:600;color:var(--ink);text-transform:none;letter-spacing:0}
.render-modal .rm-sub{margin:0;color:var(--muted);font-size:.86em}
.render-modal .rm-name-row{display:grid;grid-template-columns:110px minmax(0,1fr);align-items:center;gap:10px;color:var(--muted);font-size:.86em;font-weight:600}
.render-modal .rm-name-row input{width:100%;background:var(--surface);color:var(--ink);border:1px solid var(--border);border-radius:8px;padding:.55em .7em;font:inherit;font-weight:500}
.render-modal .rm-name-row input:focus{outline:none;border-color:var(--brand);box-shadow:0 0 0 3px var(--brand-soft)}
.render-modal .rm-variants{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;overflow-y:auto;max-height:360px;padding-right:2px}
.render-modal .rm-variant{position:relative;display:flex;align-items:center;gap:12px;padding:10px 12px;border:1px solid var(--border);border-radius:10px;background:var(--surface);cursor:pointer;transition:border-color .12s,background .12s}
.render-modal .rm-variant:hover{background:var(--surface-2)}
/* Custom visible "tick" indicator. Native checkbox is hidden but
   stays in the tab order; the box + ✓ are pure CSS so the checked
   state reads identically on every browser. */
.render-modal .rm-variant input{position:absolute;opacity:0;pointer-events:none}
.render-modal .rm-variant::before{content:"";display:block;width:20px;height:20px;border:2px solid var(--border-strong);border-radius:5px;flex-shrink:0;background:var(--surface);transition:background .12s,border-color .12s}
.render-modal .rm-variant:has(input:checked){border-color:var(--brand);background:var(--brand-soft)}
.render-modal .rm-variant:has(input:checked)::before{background:var(--brand);border-color:var(--brand);background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='white' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'><polyline points='5 12 10 17 19 7'/></svg>");background-size:14px 14px;background-repeat:no-repeat;background-position:center}
.render-modal .rm-variant-body{flex:1;display:flex;flex-direction:column;gap:2px;min-width:0}
.render-modal .rm-variant-name{font-weight:600;color:var(--ink);font-size:.94em}
.render-modal .rm-variant-dim{color:var(--muted);font-weight:400;margin-left:6px;font-size:.85em;font-variant-numeric:tabular-nums}
.render-modal .rm-variant-for{color:var(--muted);font-size:.82em}
.render-modal .rm-progress{display:flex;flex-direction:column;gap:8px;flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;scrollbar-gutter:stable;padding-right:2px;padding-bottom:18px}
.render-modal .rm-progress[hidden]{display:none}
.render-modal .rm-prow{position:relative;display:flex;flex-direction:column;gap:8px;padding:10px 12px 14px;background:var(--surface-2);border:1px solid var(--border);border-radius:8px;font-size:.85em;overflow:hidden}
.render-modal .rm-prow .rm-prow-head{display:flex;align-items:center;gap:10px}
.render-modal .rm-prow .rm-prow-keep{display:inline-flex;align-items:center;cursor:pointer}
.render-modal .rm-prow .rm-prow-keep input{position:absolute;opacity:0;pointer-events:none}
.render-modal .rm-prow .rm-prow-keep span{display:block;width:18px;height:18px;border:2px solid var(--border-strong);border-radius:4px;background:var(--surface);transition:background .12s,border-color .12s}
.render-modal .rm-prow .rm-prow-keep input:checked + span{background:var(--brand);border-color:var(--brand);background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='white' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'><polyline points='5 12 10 17 19 7'/></svg>");background-size:12px 12px;background-repeat:no-repeat;background-position:center}
.render-modal .rm-prow .rm-prow-keep input:disabled + span{opacity:.4;cursor:not-allowed}
.render-modal .rm-prow .rm-prow-name{font-weight:600;color:var(--ink);min-width:50px;font-variant-numeric:tabular-nums}
.render-modal .rm-prow .rm-prow-status{flex:1;color:var(--muted);font-variant-numeric:tabular-nums}
.render-modal .rm-prow.done .rm-prow-status{color:var(--ok)}
.render-modal .rm-prow.saved{border-color:color-mix(in srgb,var(--ok) 44%,var(--border));background:var(--ok-soft)}
.render-modal .rm-prow.saved .rm-prow-status{color:var(--ok);font-weight:600}
.render-modal .rm-prow.error .rm-prow-status{color:#dc2626}
.render-modal .rm-keep-one{appearance:none;background:var(--surface);color:var(--brand);border:1px solid var(--border);border-radius:7px;padding:.35em .7em;font-size:.82em;font-weight:700;cursor:pointer;flex-shrink:0}
.render-modal .rm-keep-one:hover:not(:disabled){background:var(--brand-soft);border-color:var(--brand)}
.render-modal .rm-keep-one:disabled{opacity:.62;cursor:not-allowed}
.render-modal .rm-prow.saved .rm-keep-one{color:var(--ok);border-color:color-mix(in srgb,var(--ok) 45%,var(--border));background:transparent}
.render-modal .rm-prow .rm-prow-bar{position:absolute;left:0;right:0;bottom:0;height:3px;background:var(--border)}
.render-modal .rm-prow .rm-prow-fill{height:100%;width:0;background:var(--brand);transition:width .18s ease}
.render-modal .rm-prow.done .rm-prow-fill{background:var(--ok)}
.render-modal .rm-prow .rm-prow-preview{display:flex;justify-content:center}
.render-modal .rm-prow .rm-prow-preview{flex-direction:column;align-items:center;gap:8px}
.render-modal .rm-prow .rm-prow-preview video{max-width:100%;max-height:min(240px,32dvh);border-radius:6px;background:#000}
.render-modal .rm-prow .rm-prow-download{color:var(--brand);font-weight:800;text-decoration:none;font-size:.82em}
.render-modal .rm-prow .rm-prow-download:hover{text-decoration:underline}
.render-modal .rm-foot{display:flex;justify-content:flex-end;align-items:center;gap:10px;padding-top:10px;border-top:1px solid var(--border);margin-top:auto}
.render-modal .rm-foot button{appearance:none;background:transparent;color:var(--ink);border:1px solid var(--border);border-radius:8px;padding:.55em 1.1em;font-weight:600;font-size:.92em;cursor:pointer;font-family:inherit;transition:filter .12s,background .12s}
.render-modal .rm-cancel{background:var(--surface);color:var(--muted);border-color:var(--border)}
.render-modal .rm-cancel:hover{background:var(--surface-2);color:var(--ink)}
.render-modal .rm-go{background:var(--brand);color:#fff;border-color:transparent;min-width:120px}
.render-modal .rm-go:hover:not(:disabled){filter:brightness(1.07)}
.render-modal .rm-go:disabled{opacity:.85;cursor:wait;background:var(--brand);color:#fff}
.render-modal .rm-go[data-busy="1"]{background:var(--accent);color:var(--ink)}
@media(max-width:680px){
  .render-modal .rm-variants{grid-template-columns:1fr}
  .render-modal .rm-pane{margin:2vh auto 0;max-height:96vh}
  .render-modal.rendering .rm-pane{height:calc(100dvh - 18px);max-height:calc(100dvh - 18px);margin:9px auto}
}

/* Illustration prompt dialog */
.ill-modal{position:fixed;inset:0;z-index:60}
.ill-modal[hidden]{display:none}
.ill-modal .ill-overlay{position:absolute;inset:0;background:rgba(0,0,0,.42)}
.ill-modal .ill-pane{position:relative;width:min(900px,calc(100vw - 28px));margin:4vh auto 0;background:var(--surface);border:1px solid var(--border);border-radius:12px;box-shadow:var(--shadow-elev);padding:18px 20px;display:flex;flex-direction:column;gap:12px;max-height:92vh;overflow:auto}
.ill-modal .ill-head{display:flex;align-items:center;justify-content:space-between;gap:12px}
.ill-modal .ill-head h3{margin:0;font-size:1.05rem;font-weight:600;color:var(--ink);letter-spacing:0}
.ill-modal .ill-sub{margin:0;color:var(--muted);font-size:.86em}
.ill-modal .ill-grid{display:grid;grid-template-columns:300px 1fr;gap:12px;min-height:0}
.ill-modal .ill-panel{border:1px solid var(--border);border-radius:8px;background:var(--surface-2);padding:10px;min-width:0}
.ill-modal .ill-panel h4{margin:0 0 8px;color:var(--muted);font-size:.72em;font-weight:800;letter-spacing:.08em;text-transform:uppercase}
.ill-modal .ill-moments{display:flex;flex-direction:column;gap:6px;max-height:220px;overflow:auto}
.ill-modal .ill-moment{display:grid;grid-template-columns:auto 1fr;gap:7px;font-size:.78em;line-height:1.3;color:var(--ink)}
.ill-modal .ill-moment-num{font-weight:800;color:var(--accent);font-variant-numeric:tabular-nums}
.ill-modal .ill-meta-line{margin:0 0 10px;color:var(--muted);font-size:.78em;font-weight:650}
.ill-modal .ill-guidance{margin:0;color:var(--muted);font-size:.78em;line-height:1.45;white-space:pre-wrap}
.ill-modal .ill-edit-panel{display:flex;flex-direction:column;gap:8px;min-width:0}
.ill-modal .ill-edit-panel label{color:var(--muted);font-size:.72em;font-weight:800;letter-spacing:.08em;text-transform:uppercase}
.ill-modal textarea{width:100%;min-height:300px;resize:vertical;background:var(--surface);color:var(--ink);border:1px solid var(--border);border-radius:8px;padding:.7em .8em;font:inherit;font-size:.9em;line-height:1.45}
.ill-modal textarea:focus{outline:none;border-color:var(--brand);box-shadow:0 0 0 3px var(--brand-soft)}
.ill-modal .ill-foot{display:flex;justify-content:flex-end;gap:10px;padding-top:4px}
.ill-modal .ill-foot button{appearance:none;border:1px solid var(--border);border-radius:8px;padding:.55em 1.1em;font-weight:600;font-size:.92em;cursor:pointer;font-family:inherit}
.ill-modal .ill-use-previous{margin-right:auto;background:var(--surface);color:var(--brand)}
.ill-modal .ill-use-previous:hover{background:var(--brand-soft);border-color:var(--brand)}
.ill-modal .ill-cancel{background:var(--surface);color:var(--muted)}
.ill-modal .ill-cancel:hover{background:var(--surface-2);color:var(--ink)}
.ill-modal .ill-ok{background:var(--brand);color:#fff;border-color:transparent}
.ill-modal .ill-ok:hover{filter:brightness(1.07)}
@media(max-width:680px){
  .ill-modal .ill-grid{grid-template-columns:1fr}
  .ill-modal .ill-pane{margin:2vh auto 0;max-height:96vh}
  .ill-modal textarea{min-height:34vh}
}

/* Plan-json preview inside drawer */
.json-preview{background:var(--surface-2);border:1px solid var(--border);border-radius:8px;padding:.7em;max-height:260px;overflow:auto;font-size:.76em;white-space:pre-wrap;word-break:break-word;font-family:"SF Mono",Menlo,Consolas,monospace}
`;

const JS = `
(function(){
  var preview = document.getElementById('preview');
  var status = document.getElementById('status');
  var projectPath = document.body.getAttribute('data-project');

  // ─── Theme toggle (light default, persisted in localStorage) ──────
  var STORAGE_KEY = 'aicw-video-theme';
  function applyTheme(theme){
    var root = document.documentElement;
    if(theme === 'dark') root.setAttribute('data-theme', 'dark');
    else root.removeAttribute('data-theme');
    var lightIco = document.querySelector('.theme-ico-light');
    var darkIco  = document.querySelector('.theme-ico-dark');
    if(lightIco && darkIco){
      // Show the icon for the OPPOSITE of the current theme (the action it triggers).
      lightIco.hidden = (theme === 'dark');
      darkIco.hidden  = (theme !== 'dark');
    }
  }
  try { applyTheme(localStorage.getItem(STORAGE_KEY) || 'light'); } catch(e){ applyTheme('light'); }
  var themeBtn = document.getElementById('theme-toggle');
  if(themeBtn){
    themeBtn.addEventListener('click', function(){
      var current = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
      var next = current === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem(STORAGE_KEY, next); } catch(e){}
      applyTheme(next);
    });
  }

  // ─── Source-video audio control ──────────────────────────────────
  // [x] use audio from <name> → checkbox toggles between the matched
  // working video and the pre-replace _backup. "Replace audio from a
  // track…" → opens a picker that calls /api/replace-audio-v2 with
  // the chosen audio source.
  (function(){
    var v = document.getElementById('src-video');
    if(!v) return;
    var replaced = v.dataset.replacedSrc;
    var original = v.dataset.originalSrc;

    // Checkbox toggle (only present when both the matched video and
    // a backup exist).
    var toggle = document.getElementById('src-audio-toggle-input');
    if(toggle){
      toggle.addEventListener('change', function(){
        var nextSrc = toggle.checked ? replaced : original;
        if(!nextSrc) return;
        try { v.pause(); } catch(_){}
        v.setAttribute('src', nextSrc);
        v.dataset._painted = '';
        v.load();
      });
    }

    // Picker: opened by the "Replace audio from a track…" button or
    // (when a match exists) by clicking the toggle's strong filename
    // span — pause that for now and just wire the explicit button.
    var picker = document.getElementById('src-audio-picker');
    var openBtn = document.getElementById('src-audio-replace-btn');
    var cancelBtn = document.getElementById('src-audio-cancel');
    var goBtn = document.getElementById('src-audio-go');
    var status = document.getElementById('src-audio-status');
    if(openBtn) openBtn.addEventListener('click', function(){
      if(picker) picker.hidden = false;
      if(openBtn) openBtn.style.display = 'none';
    });
    if(cancelBtn) cancelBtn.addEventListener('click', function(){
      if(picker) picker.hidden = true;
      if(openBtn) openBtn.style.display = '';
      if(status) status.textContent = '';
    });
    document.addEventListener('change', function(ev){
      if(!ev.target.matches || !ev.target.matches('input[name="src-audio-pick"]')) return;
      if(goBtn) goBtn.disabled = false;
    });
    if(goBtn) goBtn.addEventListener('click', async function(){
      var picked = document.querySelector('input[name="src-audio-pick"]:checked');
      if(!picked) return;
      goBtn.disabled = true;
      if(status) status.textContent = 'Aligning audio with video…';
      try {
        var r = await fetch('api/replace-audio-v2', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ audio_filename: picked.value }),
        });
        var d = await r.json();
        if(!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
        if(status) status.textContent = '✓ matched ' + (d.audioOriginalName || picked.value) + ' — reloading…';
        // Reload so the page picks up the new .match-meta.json
        // and the checkbox markup replaces the picker.
        setTimeout(function(){ window.location.reload(); }, 700);
      } catch(e){
        if(status) status.textContent = 'Failed: ' + e.message;
        goBtn.disabled = false;
      }
    });
  })();

  // ─── Single-player playback ───────────────────────────────────────
  // When any media on the page starts playing, pause every other one.
  // Bound at the document level so it applies to dynamically-added
  // clips and the Rendered-clips render-card previews too.
  function pauseOtherMedia(active){
    document.querySelectorAll('video,audio').forEach(function(m){
      if(active && active.closest && m.closest && active.closest('.clip-card') && active.closest('.clip-card') === m.closest('.clip-card')) return;
      if(m !== active && !m.paused){ try { m.pause(); } catch(_){} }
    });
  }
  function pauseAllMedia(){
    document.querySelectorAll('video,audio').forEach(function(m){
      if(!m.paused){ try { m.pause(); } catch(_){} }
    });
  }
  document.addEventListener('play', function(ev){
    var t = ev.target;
    if(!t || (t.tagName !== 'VIDEO' && t.tagName !== 'AUDIO')) return;
    pauseOtherMedia(t);
    if(t.classList && t.classList.contains('clip-player')){
      var card = t.closest('.clip-card');
      if(card && card.getAttribute('data-voiceover-enabled') === '1'){
        if(card.dataset.voiceoverVideoUrl && t.getAttribute('src') !== card.dataset.voiceoverVideoUrl){
          try { t.pause(); } catch(_){}
          setCardVideoSource(card, card.dataset.voiceoverVideoUrl);
          setTimeout(function(){ try { t.play(); } catch(_){} }, 80);
        } else if(!card.dataset.voiceoverVideoUrl){
          try { t.pause(); } catch(_){}
          ensureVoiceoverPreviewForCard(card, card.querySelector('.clip-tab-settings'));
        }
      }
    }
  }, true);

  // ─── Force first-frame paint on every <video> ────────────────────
  // Browsers don't paint a frame for preload="metadata" alone, leaving
  // the player black until played. Seeking to 0.1s after loadedmetadata
  // forces a render. Applies to source-video, per-clip players, and
  // every render-card preview (including ones added later).
  function paintFirstFrame(v){
    if(!v || v.dataset._painted === '1') return;
    if(v.readyState === 0){
      v.addEventListener('loadedmetadata', function once(){
        v.removeEventListener('loadedmetadata', once);
        paintFirstFrame(v);
      });
      return;
    }
    try { v.currentTime = 0.1; v.dataset._painted = '1'; } catch(_){}
  }
  // Run on existing videos.
  document.querySelectorAll('video').forEach(paintFirstFrame);
  // Also catch newly-inserted videos via a MutationObserver on the
  // panels that get repopulated by loadRenders().
  var firstFrameObs = new MutationObserver(function(mut){
    mut.forEach(function(m){
      m.addedNodes && m.addedNodes.forEach(function(n){
        if(!(n instanceof HTMLElement)) return;
        if(n.tagName === 'VIDEO') paintFirstFrame(n);
        n.querySelectorAll && n.querySelectorAll('video').forEach(paintFirstFrame);
      });
    });
  });
  firstFrameObs.observe(document.body, { childList: true, subtree: true });

  // ─── Back button: derive the parent project URL from the path. ────
  // The plan is mounted at /p/<projectSlug>/<videoSlug>/plan.html so
  // the parent project lives at /#/project/<projectSlug>.
  (function(){
    var back = document.getElementById('back-to-project');
    if(!back) return;
    var parts = location.pathname.split('/').filter(Boolean);
    if(parts[0] === 'p' && parts[1]){
      back.href = '/#/project/' + encodeURIComponent(parts[1]);
    } else {
      back.href = '/';
    }
  })();

  // ─── Settings drawer (used to be the "Settings" tab) ──────────────
  function openDrawer(){
    document.body.classList.add('drawer-open');
    try { history.replaceState(null,'','#settings'); } catch(e){}
  }
  function closeDrawer(){
    document.body.classList.remove('drawer-open');
    if(location.hash === '#settings'){ try { history.replaceState(null,'','#source'); } catch(e){} }
  }
  // Compatibility: existing call sites still invoke activateTab('source'|'settings').
  function activateTab(name){
    if(name === 'settings') openDrawer();
    else closeDrawer();
  }
  var openBtn = document.getElementById('open-settings');
  if(openBtn) openBtn.addEventListener('click', openDrawer);
  var closeBtn = document.getElementById('close-settings');
  if(closeBtn) closeBtn.addEventListener('click', closeDrawer);
  var overlay = document.getElementById('drawer-overlay');
  if(overlay) overlay.addEventListener('click', closeDrawer);
  document.addEventListener('keydown', function(ev){
    if(ev.key === 'Escape' && document.body.classList.contains('drawer-open')) closeDrawer();
  });

  // Honour URL hash on load: 'settings' opens drawer; clip id → scroll to it.
  if(location.hash) {
    var h = location.hash.slice(1);
    if(h === 'settings'){ openDrawer(); }
    else if(h && h !== 'source') {
      var el = document.getElementById(h);
      if(el){ setTimeout(function(){ el.scrollIntoView({behavior:'smooth',block:'start'}); }, 60); }
    }
  }

  // ─── Sort clips: by start time / duration / manual (insertion) ────
  (function(){
    var sel = document.getElementById('clip-sort');
    if(!sel) return;
    function reorder(){
      var stack = document.querySelector('.clip-stack');
      if(!stack) return;
      var cards = Array.prototype.slice.call(stack.querySelectorAll('.clip-card'));
      var mode = sel.value;
      cards.sort(function(a, b){
        if(a.dataset.fullTimeline === '1' && b.dataset.fullTimeline !== '1') return 1;
        if(b.dataset.fullTimeline === '1' && a.dataset.fullTimeline !== '1') return -1;
        if(mode === 'duration'){
          var da = parseInt(a.dataset.end,10) - parseInt(a.dataset.start,10);
          var db = parseInt(b.dataset.end,10) - parseInt(b.dataset.start,10);
          return db - da; // longest first
        }
        if(mode === 'manual'){
          return (parseInt(a.dataset.order,10) || 0) - (parseInt(b.dataset.order,10) || 0);
        }
        // default: start
        return parseInt(a.dataset.start,10) - parseInt(b.dataset.start,10);
      });
      cards.forEach(function(c){ stack.appendChild(c); });
      // Renumber after reorder so #1, #2, … reflect the visible order.
      cards.forEach(function(c, i){
        var n = c.querySelector('.clip-num');
        if(n) n.textContent = '#' + (i+1);
      });
    }
    sel.addEventListener('change', reorder);
    reorder();
  })();

  // Lazy-load each clip's video element when its card scrolls near the
  // viewport. With every clip on one page we can't load all source.mp4
  // streams at once, so the IntersectionObserver only kicks them in as
  // the user gets close.
  var lazyVideoObs = new IntersectionObserver(function(entries){
    entries.forEach(function(en){
      if(!en.isIntersecting) return;
      var card = en.target;
      var v = card.querySelector('.clip-player');
      if(v && !v.getAttribute('src')){
        v.setAttribute('src', 'source.mp4');
        v.load();
        var startMs = parseInt(card.dataset.start, 10);
        v.addEventListener('loadedmetadata', function once(){
          v.removeEventListener('loadedmetadata', once);
          try { v.currentTime = startMs / 1000; } catch(e){}
        });
      }
      lazyVideoObs.unobserve(card);
    });
  }, { rootMargin: '400px 0px' });
  document.querySelectorAll('.clip-card').forEach(function(card){ lazyVideoObs.observe(card); });

  // (Aspect + duration are no longer global UI choices. Aspect is
  // picked at render time in the Render… dialog; the clip's range is
  // its only duration source.)

  // ─── Points (shared, edited captions propagate across all clips) ──
  var STATE = window.AICW_VIDEO_STATE || { sourceDurationMs: 1, points: [], pointFrames: {}, clipTitlePrefix: '', clips: [] };
  var DEFAULT_FACE_EMOJI = STATE.defaultFaceEmoji || ${JSON.stringify(DEFAULT_FACE_EMOJI)};
  var FACE_EMOJI_NONE = STATE.faceEmojiNone || ${JSON.stringify(FACE_EMOJI_NONE)};
  var FACE_EMOJI_SCALE = Math.max(0.5, Math.min(3, Number(STATE.faceEmojiScale || ${DEFAULT_FACE_EMOJI_SCALE})));
  var FACE_EMOJI_FALLBACK_DIAMETER = Math.max(0.1, Math.min(1, Number(STATE.faceEmojiFallbackDiameter || ${DEFAULT_FACE_EMOJI_FALLBACK_DIAMETER_NORM})));
  var FACE_EMOJI_ASSETS = STATE.faceEmojiAssets || {};
  var FACE_MOUTH_ASSETS = STATE.faceMouthAssets || {};
  var FACE_EMOJI_PRESENTATION = STATE.faceEmojiPresentation || {};
  var POINTS = STATE.points || [];
  var POINT_FRAMES = STATE.pointFrames || {};
  var pointById = {};
  var VOICE_PREVIEW_SAMPLE_MS = 3000;
  var ILLUSTRATION_MIN_MS = 5000;
  POINTS.forEach(function(p){ pointById[p.index] = p; });

  (function setupReanalyzeVideo(){
    var btn = document.getElementById('reanalyze-video-btn');
    var label = document.getElementById('reanalyze-video-status');
    if(!btn) return;
    btn.addEventListener('click', async function(){
      pauseAllMedia();
      btn.disabled = true;
      var aiScene = document.getElementById('reanalyze-ai-scene-analysis');
      if(label) label.textContent = 'saving current edits...';
      try {
        var saved = await doSave(true);
        if(saved === false) throw new Error('save failed');
        if(label) label.textContent = 're-analyzing...';
        var r = await fetch('api/reanalyze-video', {
          method: 'POST',
          headers: {'Content-Type':'application/json'},
          body: JSON.stringify({ aiSceneAnalysis: !!(aiScene && aiScene.checked) })
        });
        var d = await r.json().catch(function(){ return {}; });
        if(!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
        var faces = d.facePoints || 0;
        var metadata = d.sourceMomentsWithMetadata || 0;
        var stages = Array.isArray(d.describeEvents)
          ? d.describeEvents.map(function(ev){ return ev && ev.stage ? String(ev.stage) : ''; }).filter(Boolean)
          : [];
        var lastStage = stages.length ? stages[stages.length - 1] : '';
        if(label){
          if(metadata <= 0){
            label.textContent = 're-analyzed, but no visual metadata returned' + (lastStage ? ': ' + lastStage.slice(0, 120) : '');
          } else if(faces > 0) {
            label.textContent = 'faces found in ' + faces + ' moments; reloading...';
          } else {
            label.textContent = 'visual metadata found, but no face regions; reloading...';
          }
        }
        setTimeout(function(){ window.location.reload(); }, 650);
      } catch(e) {
        if(label) label.textContent = 'failed: ' + (e && e.message ? e.message : e);
        btn.disabled = false;
      }
    });
  })();

  (function setupOpenVideoFolder(){
    var btn = document.getElementById('open-video-folder-btn');
    var label = document.getElementById('open-video-folder-status');
    if(!btn) return;
    btn.addEventListener('click', async function(){
      btn.disabled = true;
      if(label) label.textContent = 'opening...';
      try {
        var r = await fetch('api/open-video-folder', { method: 'POST' });
        var d = await r.json().catch(function(){ return {}; });
        if(!r.ok || d.error) throw new Error(d.error || ('HTTP ' + r.status));
        if(label) label.textContent = 'opened';
      } catch(e) {
        if(label) label.textContent = 'failed: ' + (e && e.message ? e.message : e);
      } finally {
        btn.disabled = false;
      }
    });
  })();

  function defaultClipTitle(title){
    var prefix = String(STATE.clipTitlePrefix || '').trim();
    var cleanTitle = String(title || '').trim() || 'Clip';
    if(!prefix) return cleanTitle;
    if(cleanTitle.indexOf(prefix + ' - ') === 0) return cleanTitle;
    return prefix + ' - ' + cleanTitle;
  }

  function pointsForClip(card){
    // Filter by timestamps (data-start / data-end), not by point
    // indices. Shift-dragged handles can sit between points; in that
    // case a caption should only participate if its own source
    // timestamp is inside the selected clip range. Including the
    // previous point by overlap makes captions appear before the
    // moment the user actually selected.
    var s = parseInt(card.dataset.start, 10);
    var e = parseInt(card.dataset.end, 10);
    if(!Number.isFinite(s) || !Number.isFinite(e)) return [];
    return POINTS.filter(function(p, i){
      return p.ts_ms >= s && p.ts_ms < e;
    });
  }

  function voicePreviewEntriesForCard(card){
    var pts = pointsForClip(card);
    var entries = [];
    var clipEnd = parseInt(card.dataset.end, 10);
    for(var i = 0; i < pts.length; i++){
      var t = (pts[i].caption || '').trim();
      if(!t) continue;
      var endMs = Number.isFinite(clipEnd) ? Math.min(clipEnd, nextPointTs(pts[i], clipEnd)) : undefined;
      entries.push({ start_ms: pts[i].ts_ms, end_ms: endMs, text: t });
    }
    if(entries.length) return entries;
    card.querySelectorAll('.point-caption').forEach(function(row){
      var ta = row.querySelector('textarea');
      var t = ta ? (ta.value || '').trim() : '';
      if(!t) return;
      var pt = pointById[parseInt(row.dataset.pt, 10)];
      if(pt){
        var endMs = Number.isFinite(clipEnd) ? Math.min(clipEnd, nextPointTs(pt, clipEnd)) : undefined;
        entries.push({ start_ms: pt.ts_ms, end_ms: endMs, text: t });
      }
    });
    return entries;
  }

  function voicePreviewAudioElement(){
    var audio = document.getElementById('voiceover-preview-audio');
    if(audio) return audio;
    audio = document.createElement('audio');
    audio.id = 'voiceover-preview-audio';
    audio.preload = 'auto';
    audio.style.display = 'none';
    audio.addEventListener('pause', function(){ clearVoicePreviewStop(audio); });
    audio.addEventListener('ended', function(){ clearVoicePreviewStop(audio); });
    document.body.appendChild(audio);
    return audio;
  }

  function clearVoicePreviewStop(audio){
    if(audio && audio._voicePreviewStopTimer){
      clearTimeout(audio._voicePreviewStopTimer);
      audio._voicePreviewStopTimer = 0;
    }
  }

  function stopVoicePreviewAudio(){
    var audio = document.getElementById('voiceover-preview-audio');
    if(!audio) return;
    clearVoicePreviewStop(audio);
    try { audio.pause(); } catch(_){}
  }

  function armVoicePreviewStop(audio){
    clearVoicePreviewStop(audio);
    audio._voicePreviewStopTimer = setTimeout(function(){
      clearVoicePreviewStop(audio);
      try { audio.pause(); } catch(_){}
    }, VOICE_PREVIEW_SAMPLE_MS);
  }

  async function playVoicePreviewAudio(url, seekMs){
    var audio = voicePreviewAudioElement();
    stopVoicePreviewAudio();
    pauseAllMedia();
    if(audio.getAttribute('src') !== url){
      audio.setAttribute('src', url);
      audio.load();
    }
    var startSec = Math.max(0, (Number.isFinite(seekMs) ? seekMs : 0) / 1000);
    var start = function(){
      try { audio.currentTime = startSec; } catch(_){}
      var p = audio.play();
      if(p && typeof p.then === 'function') return p.then(function(){ armVoicePreviewStop(audio); });
      armVoicePreviewStop(audio);
      return p;
    };
    if(audio.readyState >= 1) return start();
    return new Promise(function(resolve, reject){
      var onLoaded = function(){
        cleanup();
        Promise.resolve(start()).then(resolve).catch(reject);
      };
      var onError = function(){
        cleanup();
        reject(new Error('Audio preview failed'));
      };
      var cleanup = function(){
        audio.removeEventListener('loadedmetadata', onLoaded);
        audio.removeEventListener('error', onError);
      };
      audio.addEventListener('loadedmetadata', onLoaded);
      audio.addEventListener('error', onError);
    });
  }

  async function generateVoiceoverPreviewForCard(card, pane, opts){
    opts = opts || {};
    var status = pane && pane.querySelector('.cs-voice-status');
    var btn = pane && pane.querySelector('.cs-voice-preview');
    var entries = voicePreviewEntriesForCard(card);
    if(entries.length === 0){
      if(status) status.textContent = 'No caption text';
      return null;
    }
    if(card.dataset.voiceoverGenerating === '1'){
      if(status) status.textContent = 'Generating...';
      return null;
    }
    var voice = (pane.querySelector('.cs-voice-select') || {}).value || '';
    card.dataset.voiceoverGenerating = '1';
    if(btn) btn.disabled = true;
    if(status) status.textContent = opts.statusText || 'Generating...';
    try {
      var resp = await fetch('api/voiceover-preview', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({
          clip_id: card.dataset.id || 'clip',
          voice: voice,
          duration_ms: STATE.sourceDurationMs || parseInt(card.dataset.sourceMs || '0', 10),
          entries: entries
        })
      });
      if(!resp.ok){
        var err = await resp.json().catch(function(){ return {}; });
        throw new Error(err.error || ('HTTP ' + resp.status));
      }
      var data = await resp.json();
      card.dataset.voiceoverVideoUrl = data.video_url || '';
      card.dataset.voiceoverAudioUrl = data.audio_url || '';
      var startMs = parseInt(card.dataset.start, 10) || 0;
      if(card.getAttribute('data-voiceover-enabled') === '1' && card.dataset.voiceoverVideoUrl){
        setCardVideoSource(card, card.dataset.voiceoverVideoUrl, startMs);
      }
      if(status) status.textContent = data.cache === 'hit' ? 'Cached' : 'Generated';
      return data;
    } catch(e) {
      if(status) status.textContent = (opts.failureText || 'Generation failed') + ': ' + (e && e.message ? e.message : e);
      return null;
    } finally {
      delete card.dataset.voiceoverGenerating;
      if(btn) btn.disabled = false;
    }
  }

  function ensureVoiceoverPreviewForCard(card, pane){
    if(!card || card.getAttribute('data-voiceover-enabled') !== '1') return;
    if(card.dataset.voiceoverVideoUrl){
      applyVoiceoverPreviewSource(card);
      return;
    }
    if(card.dataset.voiceoverGenerating === '1') return;
    setTimeout(function(){
      if(card.getAttribute('data-voiceover-enabled') !== '1' || card.dataset.voiceoverVideoUrl || card.dataset.voiceoverGenerating === '1') return;
      generateVoiceoverPreviewForCard(card, pane || card.querySelector('.clip-tab-settings'), {statusText:'Preparing voice-over...'});
    }, 0);
  }

  function setCardVideoSource(card, url, seekMs){
    var video = card.querySelector('.clip-player');
    if(!video) return;
    var cur = Number.isFinite(seekMs) ? seekMs / 1000 : video.currentTime;
    if(video.getAttribute('src') === url) {
      try { video.currentTime = cur; } catch(_){}
      return;
    }
    try { video.pause(); } catch(_){}
    video.setAttribute('src', url);
    video.load();
    var seek = function(){
      video.removeEventListener('loadedmetadata', seek);
      try { video.currentTime = cur; } catch(_){}
    };
    if(video.readyState >= 1) seek();
    else video.addEventListener('loadedmetadata', seek);
  }

  function applyVoiceoverPreviewSource(card){
    if(card.getAttribute('data-voiceover-enabled') === '1' && card.dataset.voiceoverVideoUrl){
      setCardVideoSource(card, card.dataset.voiceoverVideoUrl);
    } else {
      setCardVideoSource(card, 'source.mp4');
    }
  }

  function invalidateVoiceoverPreview(card){
    stopVoicePreviewAudio();
    delete card.dataset.voiceoverVideoUrl;
    delete card.dataset.voiceoverAudioUrl;
    if(card.getAttribute('data-voiceover-enabled') === '1') applyVoiceoverPreviewSource(card);
  }

  function nextPointTs(p, fallbackEnd){
    var next = Infinity;
    for(var i = 0; i < POINTS.length; i++){
      var ts = POINTS[i].ts_ms;
      if(ts > p.ts_ms && ts < next) next = ts;
    }
    return next === Infinity ? fallbackEnd : next;
  }

  function clampMomentCropValue(value){
    var n = Number(value);
    if(!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(0.9, n));
  }
  function normalizeMomentCropClient(input){
    var raw = input && typeof input === 'object' ? input : {};
    var crop = {
      left: clampMomentCropValue(raw.left),
      top: clampMomentCropValue(raw.top),
      right: clampMomentCropValue(raw.right),
      bottom: clampMomentCropValue(raw.bottom)
    };
    if(crop.left + crop.right >= 0.95){
      var h = 0.94 / (crop.left + crop.right);
      crop.left *= h; crop.right *= h;
    }
    if(crop.top + crop.bottom >= 0.95){
      var v = 0.94 / (crop.top + crop.bottom);
      crop.top *= v; crop.bottom *= v;
    }
    return crop;
  }
  function hasMomentCropClient(crop){
    return !!crop && (crop.left > 0 || crop.top > 0 || crop.right > 0 || crop.bottom > 0);
  }
  function momentCropRectStyle(crop){
    crop = normalizeMomentCropClient(crop);
    var width = Math.max(5, (1 - crop.left - crop.right) * 100);
    var height = Math.max(5, (1 - crop.top - crop.bottom) * 100);
    return 'left:' + (crop.left * 100).toFixed(2) + '%;top:' + (crop.top * 100).toFixed(2) + '%;width:' + width.toFixed(2) + '%;height:' + height.toFixed(2) + '%';
  }
  function applyCropRectStyle(rect, crop){
    if(!rect) return;
    rect.setAttribute('style', momentCropRectStyle(crop));
  }
  function clampCropRect(crop){
    crop = normalizeMomentCropClient(crop);
    var minSize = 0.12;
    if(1 - crop.left - crop.right < minSize){
      var excessW = minSize - (1 - crop.left - crop.right);
      crop.left = Math.max(0, crop.left - excessW / 2);
      crop.right = Math.max(0, 1 - crop.left - minSize);
    }
    if(1 - crop.top - crop.bottom < minSize){
      var excessH = minSize - (1 - crop.top - crop.bottom);
      crop.top = Math.max(0, crop.top - excessH / 2);
      crop.bottom = Math.max(0, 1 - crop.top - minSize);
    }
    return normalizeMomentCropClient(crop);
  }
  function setPointCrop(ptIdx, crop){
    var point = pointById[ptIdx];
    if(!point) return;
    var normalized = normalizeMomentCropClient(crop);
    if(hasMomentCropClient(normalized)) point.crop = normalized;
    else delete point.crop;
    syncPointCropRows(ptIdx);
    document.querySelectorAll('.clip-card').forEach(function(card){
      if(card._captionTick) card._captionTick();
    });
  }
  function syncPointCropRows(ptIdx){
    var point = pointById[ptIdx];
    var crop = normalizeMomentCropClient(point && point.crop);
    var hasCrop = hasMomentCropClient(crop);
    document.querySelectorAll('.point-caption[data-pt="' + ptIdx + '"]').forEach(function(row){
      row.classList.toggle('has-crop', hasCrop);
      var btn = row.querySelector('.pt-crop-toggle');
      if(btn) btn.classList.toggle('has-crop', hasCrop);
      applyCropRectStyle(row.querySelector('.pt-crop-rect'), crop);
    });
  }
  function previousPointInCard(card, ptIdx){
    var pts = pointsForClip(card);
    for(var i = 0; i < pts.length; i++){
      if(pts[i].index === ptIdx) return i > 0 ? pts[i - 1] : null;
    }
    return null;
  }
  function normalizeIllustrationModeClient(value){
    if(value === 'demo_only') return 'animation_only';
    return value === 'side_by_side' || value === 'animation_only' ? value : 'none';
  }
  function ensurePointIllustration(point){
    if(!point.illustration || typeof point.illustration !== 'object') point.illustration = { mode:'none' };
    point.illustration.mode = normalizeIllustrationModeClient(point.illustration.mode);
    return point.illustration;
  }
  function readPointIllustration(point){
    var ill = point && point.illustration && typeof point.illustration === 'object' ? point.illustration : null;
    if(!ill) return { mode:'none' };
    var view = {};
    Object.keys(ill).forEach(function(k){ view[k] = ill[k]; });
    view.mode = normalizeIllustrationModeClient(view.mode);
    return view;
  }
  function illustrationAssetKeyFrom(ill){
    if(!ill || typeof ill !== 'object') return '';
    return String(ill.cache_key || ill.video_path || '').trim();
  }
  function sameIllustrationAsset(a, b){
    return !!a && !!b && a === b;
  }
  function illustrationAssetBaseLabel(sourcePointIndex, durationMs){
    var pointLabel = Number.isFinite(sourcePointIndex) ? ('moment_' + sourcePointIndex) : 'asset';
    var duration = Number.isFinite(durationMs) ? ('_' + Math.max(1, durationMs / 1000).toFixed(1).replace(/\\.0$/, '') + 's') : '';
    return 'animation_' + pointLabel + duration;
  }
  function parseIllustrationAssetVersion(label){
    var m = String(label || '').match(/_(?:ver|v)_?(\\d+)$/i);
    return m ? Math.max(1, parseInt(m[1], 10) || 1) : 1;
  }
  function stripIllustrationAssetVersion(label){
    return String(label || '').replace(/_(?:ver|v)_?\\d+$/i, '');
  }
  function illustrationAssetLabel(asset){
    if(!asset) return 'No animation selected';
    var base = asset.asset_label ? stripIllustrationAssetVersion(asset.asset_label) : illustrationAssetBaseLabel(asset.source_point_index, asset.duration_ms);
    return base + '_ver_' + parseIllustrationAssetVersion(asset.asset_label);
  }
  function nextIllustrationAssetLabel(card, point, durationMs){
    var base = illustrationAssetBaseLabel(point.index, durationMs);
    var maxVer = 0;
    illustrationAssetsForCard(card).forEach(function(asset){
      if(stripIllustrationAssetVersion(asset.asset_label || illustrationAssetBaseLabel(asset.source_point_index, asset.duration_ms)) === base){
        maxVer = Math.max(maxVer, parseIllustrationAssetVersion(asset.asset_label));
      }
    });
    return base + '_ver_' + Math.max(1, maxVer + 1);
  }
  function compactIllustrationAssetLabel(asset){
    if(!asset) return 'No animation';
    var label = illustrationAssetLabel(asset);
    if(label.length <= 34) return label;
    return label.slice(0, 31) + '...';
  }
  function shortIllustrationAssetLabel(asset){
    if(!asset) return 'No asset';
    var label = illustrationAssetLabel(asset);
    return label.length <= 26 ? label : label.slice(0, 23) + '...';
  }
  function illustrationAssetsForCard(card){
    var byKey = new Map();
    POINTS.forEach(function(point){
      var ill = readPointIllustration(point);
      var key = illustrationAssetKeyFrom(ill);
      if(!key || !ill.video_path) return;
      if(byKey.has(key)) return;
      byKey.set(key, {
        key: key,
        cache_key: ill.cache_key || '',
        video_path: ill.video_path || '',
        prompt: ill.prompt || '',
        duration_ms: Math.max(1000, Number(ill.duration_ms || ILLUSTRATION_MIN_MS)),
        generated_at: ill.generated_at || '',
        source_point_index: Number.isFinite(ill.source_point_index) ? Number(ill.source_point_index) : point.index,
        source_ts_ms: Number.isFinite(ill.source_ts_ms) ? Number(ill.source_ts_ms) : point.ts_ms,
        asset_label: ill.asset_label || ''
      });
    });
    return Array.from(byKey.values()).sort(function(a, b){
      return (a.source_ts_ms || 0) - (b.source_ts_ms || 0) || String(a.key).localeCompare(String(b.key));
    });
  }
  function findIllustrationAssetByKey(card, key){
    if(!key) return null;
    var assets = illustrationAssetsForCard(card);
    for(var i = 0; i < assets.length; i++){
      if(assets[i].key === key) return assets[i];
    }
    return null;
  }
  function applyIllustrationAssetToPoint(point, asset){
    if(!point || !asset) return;
    var ill = ensurePointIllustration(point);
    ill.video_path = asset.video_path || '';
    ill.cache_key = asset.cache_key || '';
    ill.prompt = asset.prompt || ill.prompt || '';
    ill.duration_ms = asset.duration_ms || ill.duration_ms || ILLUSTRATION_MIN_MS;
    ill.generated_at = asset.generated_at || ill.generated_at || '';
    ill.source_point_index = Number.isFinite(asset.source_point_index) ? asset.source_point_index : point.index;
    ill.source_ts_ms = Number.isFinite(asset.source_ts_ms) ? asset.source_ts_ms : point.ts_ms;
    ill.asset_label = asset.asset_label || illustrationAssetLabel(asset);
    ill.explicit = true;
  }
  function generatedIllustrationAssetForPoint(point, ill){
    var durationMs = Math.max(1000, Number(ill.duration_ms || ILLUSTRATION_MIN_MS));
    var sourcePointIndex = Number.isFinite(ill.source_point_index) ? Number(ill.source_point_index) : point.index;
    var sourceTsMs = Number.isFinite(ill.source_ts_ms) ? Number(ill.source_ts_ms) : point.ts_ms;
    return {
      key: illustrationAssetKeyFrom(ill),
      cache_key: ill.cache_key || '',
      video_path: ill.video_path || '',
      prompt: ill.prompt || '',
      duration_ms: durationMs,
      generated_at: ill.generated_at || '',
      source_point_index: sourcePointIndex,
      source_ts_ms: sourceTsMs,
      asset_label: ill.asset_label || illustrationAssetBaseLabel(sourcePointIndex, durationMs)
    };
  }
  function previousIllustrationPointInCard(card, point){
    var pts = pointsForClip(card);
    var prev = null;
    for(var i = 0; i < pts.length; i++){
      if(pts[i].index === point.index) return prev;
      prev = pts[i];
    }
    return null;
  }
  function isContinuationPoint(card, point){
    var effective = effectiveIllustrationForPoint(card, point);
    if(effective.inherited) return true;
    var ill = effective.ill;
    var mode = normalizeIllustrationModeClient(effective.mode);
    var key = effective.assetKey;
    if(mode === 'none' || !key) return false;
    var prev = previousIllustrationPointInCard(card, point);
    if(!prev) return false;
    var prevEffective = effectiveIllustrationForPoint(card, prev);
    return normalizeIllustrationModeClient(prevEffective.mode) === mode && sameIllustrationAsset(prevEffective.assetKey, key);
  }
  function isIllustrationTimelineEventClient(ill){
    if(!ill || typeof ill !== 'object') return false;
    return normalizeIllustrationModeClient(ill.mode) !== 'none' || ill.explicit === true;
  }
  function illustrationModeLabel(mode){
    mode = normalizeIllustrationModeClient(mode);
    if(mode === 'side_by_side') return 'Side by side';
    if(mode === 'animation_only') return 'Animation only';
    return 'Original only';
  }
  function illustrationStatusForPoint(point, card){
    var effective = effectiveIllustrationForPoint(card, point);
    var ill = effective.ill;
    var mode = normalizeIllustrationModeClient(effective.mode);
    var hasVideo = !!(effective.asset && effective.asset.video_path);
    if(mode === 'none') return { text:'Animation off', className:'', title:'Original video only' };
    if(hasVideo){
      var prefix = effective.inherited || isContinuationPoint(card, point) ? 'Continue' : illustrationModeLabel(mode);
      return { text: prefix + ' · ' + shortIllustrationAssetLabel(effective.asset), className:'is-active', title: effective.inherited ? 'This moment continues the previous animation asset' : 'Cached animation is ready' };
    }
    return { text: illustrationModeLabel(mode) + ' · needs generation', className:'is-missing', title:'Generate the animation before rendering this mode' };
  }
  function illustrationBadgeHtml(point, className, card){
    var st = illustrationStatusForPoint(point, card);
    return '<span class="' + className + (st.className ? ' ' + st.className : '') + '" title="' + escHtml(st.title) + '">' + escHtml(st.text) + '</span>';
  }
  function defaultIllustrationModeForNewSelection(card){
    return 'side_by_side';
  }
  function shortMomentLabel(value, maxWords){
    var words = String(value || '').replace(/\\s+/g, ' ').trim().split(' ').filter(Boolean);
    if(words.length <= maxWords) return words.join(' ');
    return words.slice(0, maxWords).join(' ') + '...';
  }
  function cleanMultilinePrompt(value){
    return String(value || '')
      .replace(/\\r\\n?/g, '\\n')
      .replace(/[ \\t]+\\n/g, '\\n')
      .replace(/\\n{3,}/g, '\\n\\n')
      .trim();
  }
  function illustrationPromptTemplate(){
    var configured = cleanMultilinePrompt(STATE.illustrationPromptTemplate || '');
    if(configured) return configured;
    return [
      'Goal: Create one self-contained animated explanatory graphic for the selected video span.',
      '',
      'Clip:',
      '{{clip_title}}',
      '',
      'Duration:',
      'About {{duration_seconds}} seconds.',
      '',
      'Full source captions for context:',
      '{{clip_script}}',
      '',
      'Selected span to illustrate:',
      '{{moments}}',
      '',
      'Visual type:',
      '{{visual_type}}',
      '',
      'Visual items:',
      '{{visual_items}}',
      '',
      'Visual brief:',
      '{{visual_brief}}',
      '',
      'Rules:',
      '- Use exactly one visual type for now: graph or list.',
      '- Graph: show a chart, bars, counter, dashboard, or metric signal. If the captions contain numbers, units, percentages, dates, rates, or quantities, use them as readable labels.',
      '- List: show 2-4 key ideas, priorities, contrasts, or ordered points as large readable cards. Extract meaning from the source context, not only repeated words in the selected span.',
      '- Do not paste the spoken sentence as a headline. Use graphics first, with only short labels from Visual items when needed.',
      '- Do not make word clouds or keyword chips unless they are meaningful labels for a list item.',
      '- Keep the composition portrait-safe, high contrast, and simple enough to understand while the original audio plays.',
      '- Future visual types that are useful but not for this render: flow/process diagram, comparison/before-after.',
      '',
      'Style:',
      'Modern animated explainer, clear symbolic shapes, intentional motion, no photorealistic people, no clutter, no duplicate caption text.'
    ].join('\\n');
  }
  function fillIllustrationPromptTemplate(template, values){
    var momentsText = formatIllustrationMomentLines(values.moments || [], values.subject || '');
    var clipScriptText = formatIllustrationMomentLines(values.clipMoments || values.moments || [], '', 3200);
    var out = String(template || '');
    var replacements = {
      clip_title: values.clipTitle || 'Untitled clip',
      duration_seconds: values.durationSeconds,
      clip_script: clipScriptText || '- No full clip captions available.',
      moments: momentsText,
      selected_moments: momentsText,
      moment_text: values.subject,
      visual_guidance: values.guidance,
      visual_type: values.visualType || 'list',
      visual_items: values.visualItemsText || '- Main idea',
      visual_brief: values.visualBrief || values.guidance || ''
    };
    Object.keys(replacements).forEach(function(key){
      out = out.replace(new RegExp('\\\\{\\\\{\\\\s*' + key + '\\\\s*\\\\}\\\\}', 'gi'), function(){ return String(replacements[key] || ''); });
    });
    return cleanMultilinePrompt(out);
  }
  function formatIllustrationMomentLines(moments, fallback, maxChars){
    var lines = (moments || []).filter(function(m){ return m && m.text; }).map(function(m){
      return '- #' + m.index + ' at ' + fmtSecs(m.ts_ms / 1000) + ': ' + m.text;
    });
    if(!lines.length && fallback) lines = ['- ' + fallback];
    var text = lines.join('\\n');
    maxChars = maxChars || 1800;
    if(text.length <= maxChars) return text;
    return text.slice(0, maxChars).replace(/\\s+\\S*$/, '') + '\\n- ...';
  }
  function clipScriptMomentsForCard(card){
    return pointsForClip(card).map(function(p){
      return {
        index: p.index,
        ts_ms: p.ts_ms,
        text: String(p.original_text || p.caption || '').replace(/\\s+/g, ' ').trim()
      };
    }).filter(function(m){ return m.text; });
  }
  function sourceScriptMoments(){
    return POINTS.map(function(p){
      return {
        index: p.index,
        ts_ms: p.ts_ms,
        text: String(p.original_text || p.caption || '').replace(/\\s+/g, ' ').trim()
      };
    }).filter(function(m){ return m.text; });
  }
  function promptTextFromMoments(moments){
    return (moments || []).map(function(m){ return m && m.text ? m.text : ''; }).join(' ').replace(/\\s+/g, ' ').trim();
  }
  function uniquePromptItems(items){
    var out = [];
    (items || []).forEach(function(item){
      var clean = String(item || '').replace(/\\s+/g, ' ').trim();
      if(!clean) return;
      var key = clean.toLowerCase();
      if(out.some(function(existing){ return existing.toLowerCase() === key; })) return;
      out.push(clean);
    });
    return out.slice(0, 4);
  }
  function visualTypeForIllustration(selectedText, clipText){
    var selected = String(selectedText || '').toLowerCase();
    var hasGraphSignal = function(text){
      return /\\b(grow|growth|growing|increase|increased|increasing|rise|rising|up|usage|metric|metrics|speed|fast|faster|progress|trend|rate|revenue|conversion|conversions|traffic|adoption|number|numbers|percent|percentage|x|times|daily|weekly|monthly)\\b/.test(text) || /\\b\\d+(?:[.,]\\d+)?\\s*(?:%|percent|x|k|m|b|ms|s|sec|seconds|tasks|users|messages|requests)?\\b/i.test(text);
    };
    if(hasGraphSignal(selected)){
      return 'graph';
    }
    return 'list';
  }
  function numberItemsFromText(text){
    var matches = String(text || '').match(/\\b\\d+(?:[.,]\\d+)?\\s*(?:%|percent|x|k|m|b|ms|s|sec|seconds|tasks|users|messages|requests|days|weeks|months)?\\b/gi) || [];
    return uniquePromptItems(matches).slice(0, 3);
  }
  function visualItemsForIllustration(visualType, selectedText, clipText){
    var allText = (selectedText + ' ' + clipText).replace(/\\s+/g, ' ').trim();
    if(visualType === 'graph'){
      var numbers = numberItemsFromText(allText);
      if(numbers.length) return uniquePromptItems(numbers.concat(['Metric trend', 'Going up']));
      if(/\\b(speed|fast|faster)\\b/i.test(allText)) return ['Speed increases', 'Faster usage', 'Trend up'];
      if(/\\b(task|tasks|message|messages|daily)\\b/i.test(allText)) return ['Daily volume', 'Tasks', 'Messages'];
      return ['Metric signal', 'Trend up', 'Progress'];
    }
    if(hasExplicitVibeCodingOrder(allText)){
      return ['Vibe first', 'Coding second'];
    }
    if(/\\bvibe\\s+coding\\b/i.test(allText)){
      return ['Vibe', 'Coding'];
    }
    if(/\\bwork\\s+on\\s+(?:our\\s+)?projects\\b/i.test(allText) && /\\bAI\\b/i.test(allText)){
      var workshopItems = ['Work on projects', 'Use AI together'];
      if(/\\bmeet\\s+new\\s+people\\b/i.test(allText)) workshopItems.push('Meet new people');
      if(/\\bget\\s+some\\s+work\\s+done\\b/i.test(allText)) workshopItems.push('Get work done');
      return uniquePromptItems(workshopItems);
    }
    if(/\\bmeet\\s+new\\s+people\\b/i.test(allText) && /\\bsocial/i.test(allText)){
      return uniquePromptItems(['Meet new people', 'Socialize', 'Build something']);
    }
    var ordered = [];
    var first = allText.match(/\\b([A-Za-z][A-Za-z\\s-]{2,32}?)\\s+(?:in\\s+the\\s+)?first\\b/i);
    var second = allText.match(/\\b([A-Za-z][A-Za-z\\s-]{2,32}?)\\s+(?:in\\s+the\\s+)?second\\b/i);
    if(first) ordered.push(first[1].trim() + ' first');
    if(second) ordered.push(second[1].trim() + ' second');
    if(ordered.length >= 2) return uniquePromptItems(ordered);
    if(/\\b(key|priority|priorities|important|feature|features|reason|reasons|step|steps)\\b/i.test(allText)) return ['Key idea', 'Why it matters', 'Next point'];
    return ['Main idea', 'Supporting point'];
  }
  function hasExplicitVibeCodingOrder(text){
    text = String(text || '');
    var vibeFirst = /\\bvibe\\b[^.!?]{0,140}\\bfirst\\b/i.test(text) || /\\bfirst\\b[^.!?]{0,140}\\bvibe\\b/i.test(text) || /\\bvibe\\b[^.!?]{0,140}\\bfirst\\s+place\\b/i.test(text);
    var codingSecond = /\\bcoding\\b[^.!?]{0,140}\\bsecond\\b/i.test(text) || /\\bsecond\\b[^.!?]{0,140}\\bcoding\\b/i.test(text);
    return vibeFirst && codingSecond;
  }
  function visualBriefForIllustration(visualType, visualItems, selectedText, clipText){
    if(visualType === 'graph'){
      return 'Build one clean metric graphic: a rising line or bar chart with a small dashboard card. Use these readable labels when they are relevant: ' + visualItems.join(', ') + '. The visual should explain the trend without repeating the caption.';
    }
    if(visualItems.join(' ').toLowerCase().indexOf('vibe first') !== -1){
      return 'Build two large ordered cards: "Vibe first" appears first as the main priority, then "Coding second" appears as the supporting action. Keep it conceptual, not a transcript card.';
    }
    return 'Build a concise list graphic with 2-4 cards appearing one by one. Use these labels as the card text: ' + visualItems.join(', ') + '. The cards should summarize the idea from the full clip context, not quote the selected caption.';
  }
  function visualPlanForIllustration(selectedMoments, clipMoments){
    var selectedText = promptTextFromMoments(selectedMoments);
    var clipText = promptTextFromMoments(clipMoments);
    var visualType = visualTypeForIllustration(selectedText, clipText);
    var visualItems = visualItemsForIllustration(visualType, selectedText, clipText);
    return {
      visualType: visualType,
      visualItems: visualItems,
      visualItemsText: visualItems.map(function(item){ return '- ' + item; }).join('\\n'),
      visualBrief: visualBriefForIllustration(visualType, visualItems, selectedText, clipText)
    };
  }
  function illustrationPromptMomentsForPoint(card, point){
    var clipEnd = parseInt(card.dataset.end, 10) || STATE.sourceDurationMs || point.ts_ms + ILLUSTRATION_MIN_MS;
    var durationMs = illustrationDurationForPoint(card, point);
    var endMs = Math.min(clipEnd, point.ts_ms + durationMs);
    var pts = pointsForClip(card).filter(function(p){
      return p.ts_ms >= point.ts_ms && p.ts_ms < endMs;
    });
    if(!pts.some(function(p){ return p.index === point.index; })) pts.unshift(point);
    return pts.map(function(p){
      return {
        index: p.index,
        ts_ms: p.ts_ms,
        text: String(p.caption || p.original_text || '').replace(/\\s+/g, ' ').trim()
      };
    }).filter(function(m){ return m.text; });
  }
  function illustrationPromptPartsForPoint(card, point){
    var titleInput = card && card.querySelector('.title-input');
    var title = titleInput ? titleInput.value.trim() : '';
    var durationMs = illustrationDurationForPoint(card, point);
    var moments = illustrationPromptMomentsForPoint(card, point);
    var clipMoments = sourceScriptMoments();
    var visualPlan = visualPlanForIllustration(moments, clipMoments);
    var subject = moments.map(function(m){ return m.text; }).join(' ');
    if(!subject) subject = (title || 'this video moment');
    if(subject.length > 520) subject = subject.slice(0, 520).replace(/\\s+\\S*$/, '') + '...';
    var guidance = [
      'Use the full clip captions to understand the idea, then illustrate only the selected span.',
      'Use a ' + visualPlan.visualType + ' visual with these items: ' + visualPlan.visualItems.join(', ') + '.',
      'Keep it as one continuous visual idea, not a literal transcript card.'
    ].join(' ');
    var durationSeconds = Math.max(1, durationMs / 1000).toFixed(1).replace(/\\.0$/, '');
    var prompt = fillIllustrationPromptTemplate(illustrationPromptTemplate(), {
      clipTitle: title || STATE.clipTitlePrefix || '',
      durationSeconds: durationSeconds,
      moments: moments,
      clipMoments: clipMoments,
      subject: subject,
      guidance: guidance,
      visualType: visualPlan.visualType,
      visualItemsText: visualPlan.visualItemsText,
      visualBrief: visualPlan.visualBrief
    });
    return { prompt: prompt, moments: moments, clipMoments: clipMoments, guidance: guidance, durationMs: durationMs, durationSeconds: durationSeconds, clipTitle: title || STATE.clipTitlePrefix || '', visualType: visualPlan.visualType, visualItems: visualPlan.visualItems, visualBrief: visualPlan.visualBrief };
  }
  function defaultIllustrationPromptForPoint(card, point){
    return illustrationPromptPartsForPoint(card, point).prompt;
  }
  function isModernIllustrationPrompt(prompt){
    var text = cleanMultilinePrompt(prompt);
    return /moments?\s+to\s+cover\s*:/i.test(text) && /(visual\s+plan|visual\s+direction|style)\s*:/i.test(text);
  }
  function isCurrentIllustrationPrompt(prompt){
    var text = cleanMultilinePrompt(prompt);
    return /full\s+(?:clip|source)\s+captions(?:\s+for\s+context)?\s*:/i.test(text) && /selected\s+span\s+to\s+illustrate\s*:/i.test(text) && /visual\s+type\s*:/i.test(text) && /visual\s+items\s*:/i.test(text);
  }
  function isLegacyIllustrationPrompt(prompt){
    var text = cleanMultilinePrompt(prompt);
    return /^Create a clean animated explainer illustration for this video moment:/i.test(text) || /Spoken context:/i.test(text);
  }
  function promptForIllustrationDialog(card, point, ill, parts){
    var stored = cleanMultilinePrompt(ill && ill.prompt || '');
    if(ill && ill.video_path) return parts.prompt;
    if(stored && isCurrentIllustrationPrompt(stored)) return stored;
    if(stored && !isLegacyIllustrationPrompt(stored) && !isModernIllustrationPrompt(stored)) return stored;
    return parts.prompt;
  }
  function previousGeneratedIllustrationPrompt(ill){
    var stored = cleanMultilinePrompt(ill && ill.prompt || '');
    return stored && ill && ill.video_path ? stored : '';
  }
  function illustrationClipRemainingMs(card, point){
    var clipEnd = parseInt(card.dataset.end, 10) || STATE.sourceDurationMs || point.ts_ms + 3000;
    return Math.max(1000, clipEnd - point.ts_ms);
  }
  function desiredIllustrationDurationMs(card, point, rawDurationMs){
    var remaining = illustrationClipRemainingMs(card, point);
    var floor = Math.min(ILLUSTRATION_MIN_MS, remaining);
    if(Number.isFinite(Number(rawDurationMs)) && Number(rawDurationMs) > 0){
      return Math.max(1000, Math.min(remaining, Math.max(Math.round(Number(rawDurationMs)), floor)));
    }
    var clipEnd = point.ts_ms + remaining;
    var natural = Math.max(1000, Math.min(clipEnd, nextPointTs(point, clipEnd)) - point.ts_ms);
    return Math.max(1000, Math.min(remaining, Math.max(floor, natural)));
  }
  function illustrationDurationForPoint(card, point){
    var ill = readPointIllustration(point);
    return desiredIllustrationDurationMs(card, point, ill && ill.duration_ms);
  }
  function openIllustrationPromptDialog(initialPrompt, parts, previousPrompt){
    return new Promise(function(resolve){
      parts = parts || { moments: [], guidance: '', durationMs: 0 };
      previousPrompt = cleanMultilinePrompt(previousPrompt || '');
      var m = document.createElement('div');
      m.className = 'ill-modal';
      var momentHtml = (parts.moments && parts.moments.length ? parts.moments : []).map(function(moment){
        return '<div class="ill-moment"><span class="ill-moment-num">#' + escHtml(moment.index) + '</span><span>' + escHtml(moment.text || '') + '</span></div>';
      }).join('') || '<div class="ill-moment"><span class="ill-moment-num">-</span><span>No moment text available</span></div>';
      var metaText = 'Covers about ' + escHtml(parts.durationSeconds || Math.max(1, Number(parts.durationMs || 0) / 1000).toFixed(1).replace(/\\.0$/, '')) + 's' + (parts.clipTitle ? ' · ' + escHtml(parts.clipTitle) : '');
      m.innerHTML =
        '<div class="ill-overlay"></div>' +
        '<div class="ill-pane" role="dialog" aria-modal="true" aria-labelledby="ill-title">' +
          '<header class="ill-head">' +
            '<h3 id="ill-title">Illustration prompt</h3>' +
            '<button class="iconbtn ill-close" type="button" aria-label="Close">&times;</button>' +
          '</header>' +
          '<p class="ill-sub">Confirm or edit the prompt sent to Hyperframes. The context below reflects the moments this animation should cover.</p>' +
          '<div class="ill-grid">' +
            '<aside class="ill-panel">' +
              '<h4>Moment context</h4>' +
              '<p class="ill-meta-line">' + metaText + '</p>' +
              '<div class="ill-moments">' + momentHtml + '</div>' +
              '<h4>Renderer guidance</h4>' +
              '<p class="ill-guidance">' + escHtml(parts.guidance || '') + '</p>' +
            '</aside>' +
            '<div class="ill-edit-panel">' +
              '<label for="ill-text">Editable prompt</label>' +
              '<textarea id="ill-text" class="ill-text" spellcheck="true"></textarea>' +
            '</div>' +
          '</div>' +
          '<footer class="ill-foot">' +
            (previousPrompt ? '<button class="ill-use-previous" type="button">Use previous</button>' : '') +
            '<button class="ill-cancel" type="button">Cancel</button>' +
            '<button class="ill-ok" type="button">Generate</button>' +
          '</footer>' +
        '</div>';
      document.body.appendChild(m);
      var textarea = m.querySelector('.ill-text');
      var ok = m.querySelector('.ill-ok');
      var cancel = m.querySelector('.ill-cancel');
      var usePrevious = m.querySelector('.ill-use-previous');
      var close = m.querySelector('.ill-close');
      var overlay = m.querySelector('.ill-overlay');
      var settled = false;
      function done(value){
        if(settled) return;
        settled = true;
        document.removeEventListener('keydown', onKey);
        try { m.remove(); } catch(_){}
        resolve(value);
      }
      function onKey(ev){
        if(ev.key === 'Escape'){
          ev.preventDefault();
          done(null);
        }
        if((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter'){
          ev.preventDefault();
          done(cleanMultilinePrompt(textarea.value || ''));
        }
      }
      textarea.value = initialPrompt || '';
      if(usePrevious) usePrevious.addEventListener('click', function(){
        textarea.value = previousPrompt;
        textarea.focus();
        textarea.setSelectionRange(0, textarea.value.length);
      });
      ok.addEventListener('click', function(){
        done(cleanMultilinePrompt(textarea.value || ''));
      });
      cancel.addEventListener('click', function(){ done(null); });
      close.addEventListener('click', function(){ done(null); });
      overlay.addEventListener('click', function(){ done(null); });
      document.addEventListener('keydown', onKey);
      setTimeout(function(){
        textarea.focus();
        textarea.setSelectionRange(0, textarea.value.length);
      }, 0);
    });
  }
  async function generateIllustrationForPoint(card, point, promptText, status, button, force){
    var ill = ensurePointIllustration(point);
    var edited = cleanMultilinePrompt(promptText || '');
    if(!edited) return false;
    var durationMs = illustrationDurationForPoint(card, point);
    if(button) button.disabled = true;
    if(status){ status.textContent = 'generating...'; status.title = ''; }
    try {
      var resp = await fetch('api/illustration-generate', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({
          point_index: point.index,
          prompt: edited,
          duration_ms: durationMs,
          force: force === true
        })
      });
      var data = await resp.json().catch(function(){ return {}; });
      if(!resp.ok) throw new Error(data.error || ('HTTP ' + resp.status));
      ill.prompt = data.prompt || edited;
      ill.video_path = data.video_path || '';
      ill.cache_key = data.cache_key || '';
      ill.duration_ms = data.duration_ms || durationMs;
      ill.generated_at = data.generated_at || '';
      ill.source_point_index = point.index;
      ill.source_ts_ms = point.ts_ms;
      ill.asset_label = nextIllustrationAssetLabel(card, point, ill.duration_ms);
      ill.explicit = true;
      if(ill.mode === 'none'){
        ill.mode = defaultIllustrationModeForNewSelection(card);
      }
      if(status){ status.textContent = data.cache === 'hit' ? 'cached' : 'generated'; status.title = ''; }
      if(card && card._captionTick) card._captionTick();
      return true;
    } catch(e) {
      var message = String(e && e.message ? e.message : e);
      if(status){ status.textContent = 'failed: ' + message; status.title = message; }
      return false;
    } finally {
      if(button) button.disabled = false;
    }
  }
  function selectedIllustrationPoints(card){
    var rows = Array.prototype.slice.call(card.querySelectorAll('.point-illustration'));
    return rows.map(function(row){
      var cb = row.querySelector('.pt-illustration-pick input');
      if(!cb || !cb.checked) return null;
      var ptIdx = parseInt(row.dataset.pt, 10);
      var point = pointById[ptIdx];
      return point ? { row: row, point: point } : null;
    }).filter(Boolean);
  }
  function targetIllustrationSuggestionCount(momentCount){
    var count = Math.max(0, Math.round(Number(momentCount || 0)));
    if(count <= 0) return 0;
    if(count <= 3) return 1;
    if(count <= 8) return 2;
    return Math.min(4, Math.ceil(count / 5));
  }
  function suggestionPoint(suggestion){
    return suggestion ? pointById[parseInt(suggestion.index, 10)] : null;
  }
  function spacedIllustrationSuggestions(card, suggestions, limit){
    var max = Math.max(0, Math.round(Number(limit || 0)));
    var minGap = Math.max(3000, ILLUSTRATION_MIN_MS - 500);
    var out = [];
    var seen = new Set();
    (suggestions || []).forEach(function(suggestion){
      if(max > 0 && out.length >= max) return;
      var point = suggestionPoint(suggestion);
      if(!point || seen.has(point.index)) return;
      var tooClose = out.some(function(existing){
        var existingPoint = suggestionPoint(existing);
        return existingPoint && Math.abs(existingPoint.ts_ms - point.ts_ms) < minGap;
      });
      if(tooClose) return;
      seen.add(point.index);
      out.push(suggestion);
    });
    return out;
  }
  function heuristicIllustrationSuggestions(card, limit){
    var rows = Array.prototype.slice.call(card.querySelectorAll('.point-illustration'));
    var clipText = promptTextFromMoments(clipScriptMomentsForCard(card));
    var candidates = rows.map(function(row){
      var ptIdx = parseInt(row.dataset.pt, 10);
      var point = pointById[ptIdx];
      var text = point ? String(point.caption || point.original_text || '') : '';
      var combined = text + ' ' + clipText;
      var graphScore = /\\b(grow|growth|increase|rising|up|usage|metric|metrics|speed|fast|progress|daily|number|numbers)\\b/i.test(combined) || /\\b\\d+(?:[.,]\\d+)?/.test(combined) ? 8 : 0;
      var listScore = /\\b(vibe coding|priority|priorities|key|feature|reason|step|first|second|things?)\\b/i.test(combined) ? 6 : 0;
      return { row: row, point: point, score: text.trim().split(/\\s+/).filter(Boolean).length + graphScore + listScore + (point && point.illustration && point.illustration.video_path ? -100 : 0) };
    }).filter(function(x){ return x.point && x.score > 0; });
    candidates.sort(function(a, b){ return b.score - a.score; });
    var max = Math.max(1, Math.min(4, Math.round(Number(limit || targetIllustrationSuggestionCount(candidates.length) || 1))));
    return spacedIllustrationSuggestions(card, candidates.map(function(x){
      return {
        index: x.point.index,
        mode: 'side_by_side',
        duration_ms: illustrationDurationForPoint(card, x.point),
        prompt: readPointIllustration(x.point).prompt || defaultIllustrationPromptForPoint(card, x.point)
      };
    }), max);
  }
  function fillMissingIllustrationSuggestions(card, suggestions, target){
    var max = Math.max(1, Math.round(Number(target || 1)));
    var out = spacedIllustrationSuggestions(card, suggestions || [], max);
    if(out.length >= max) return out;
    var seen = new Set(out.map(function(s){ return parseInt(s.index, 10); }));
    heuristicIllustrationSuggestions(card, max).forEach(function(suggestion){
      if(out.length >= max) return;
      var point = suggestionPoint(suggestion);
      if(!point || seen.has(point.index)) return;
      var candidate = spacedIllustrationSuggestions(card, out.concat([suggestion]), max);
      if(candidate.length > out.length){
        seen.add(point.index);
        out = candidate;
      }
    });
    return out;
  }
  function applyIllustrationSuggestions(card, suggestions){
    var picked = new Map((suggestions || []).map(function(s){ return [parseInt(s.index, 10), s]; }));
    var rows = Array.prototype.slice.call(card.querySelectorAll('.point-illustration'));
    rows.forEach(function(row){
      var cb = row.querySelector('.pt-illustration-pick input');
      var ptIdx = parseInt(row.dataset.pt, 10);
      var suggestion = picked.get(ptIdx);
      if(cb) cb.checked = !!suggestion;
      var point = pointById[ptIdx];
      if(!point) return;
      if(!suggestion){
        var existing = readPointIllustration(point);
        if(existing.explicit === true && !illustrationAssetKeyFrom(existing) && normalizeIllustrationModeClient(existing.mode) !== 'none'){
          var stale = ensurePointIllustration(point);
          stale.mode = 'none';
          stale.explicit = false;
          delete stale.duration_ms;
          delete stale.prompt;
          delete stale.visual_type;
          var staleSelect = row.querySelector('.pt-illustration-mode');
          var staleStatus = row.querySelector('.pt-illustration-status');
          if(staleSelect) staleSelect.value = 'none';
          if(staleStatus) staleStatus.textContent = '';
        }
        return;
      }
      var ill = ensurePointIllustration(point);
      var suggestedMode = normalizeIllustrationModeClient(suggestion.mode || 'side_by_side');
      ill.mode = suggestedMode === 'none' ? 'side_by_side' : suggestedMode;
      ill.explicit = true;
      if(suggestion.prompt) ill.prompt = cleanMultilinePrompt(suggestion.prompt);
      if(suggestion.visual_type === 'graph' || suggestion.visual_type === 'list') ill.visual_type = suggestion.visual_type;
      if(Number.isFinite(Number(suggestion.duration_ms)) && Number(suggestion.duration_ms) >= 1000){
        ill.duration_ms = desiredIllustrationDurationMs(card, point, suggestion.duration_ms);
      } else {
        ill.duration_ms = illustrationDurationForPoint(card, point);
      }
      var select = row.querySelector('.pt-illustration-mode');
      var status = row.querySelector('.pt-illustration-status');
      if(select) select.value = ill.mode;
      if(status) status.textContent = ill.video_path ? 'cached' : 'selected';
    });
    syncIllustrationBadges(card);
    scheduleSave();
  }
  async function selectSuggestedIllustrationPoints(card){
    var rows = Array.prototype.slice.call(card.querySelectorAll('.point-illustration'));
    var suggestions = [];
    var targetCount = targetIllustrationSuggestionCount(rows.length) || 1;
    try {
      var titleInput = card && card.querySelector('.title-input');
      var moments = rows.map(function(row){
        var ptIdx = parseInt(row.dataset.pt, 10);
        var point = pointById[ptIdx];
        if(!point) return null;
        var ill = point.illustration || {};
        return {
          index: point.index,
          ts_ms: point.ts_ms,
          caption: point.caption || '',
          original_text: point.original_text || '',
          has_video: !!ill.video_path
        };
      }).filter(Boolean);
      var resp = await fetch('api/illustration-suggest', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({
          clip_title: titleInput ? titleInput.value.trim() : '',
          max: targetCount,
          moments: moments
        })
      });
      if(resp.ok){
        var data = await resp.json().catch(function(){ return {}; });
        if(Array.isArray(data.selected)) suggestions = data.selected;
      }
    } catch(_){}
    suggestions = fillMissingIllustrationSuggestions(card, suggestions, targetCount);
    applyIllustrationSuggestions(card, suggestions);
    return suggestions.length;
  }
  function syncIllustrationBadges(card){
    var root = card || document;
    root.querySelectorAll('.point-caption').forEach(function(row){
      var point = pointById[parseInt(row.dataset.pt, 10)];
      var badge = row.querySelector('.pt-illustration-badge');
      if(!point || !badge) return;
      var st = illustrationStatusForPoint(point, row.closest('.clip-card'));
      badge.className = 'pt-illustration-badge' + (st.className ? ' ' + st.className : '');
      badge.textContent = st.text;
      badge.title = st.title;
    });
    root.querySelectorAll('.point-illustration').forEach(function(row){
      var point = pointById[parseInt(row.dataset.pt, 10)];
      if(!point) return;
      var ill = readPointIllustration(point);
      var select = row.querySelector('.pt-illustration-mode');
      if(select) select.value = ill.mode;
      var status = row.querySelector('.pt-illustration-status');
      if(status) status.textContent = illustrationStatusForPoint(point, row.closest('.clip-card')).text.replace(/^Animation off$/, '');
      var badge = row.querySelector('.ill-badge');
      if(badge){
        var st = illustrationStatusForPoint(point, row.closest('.clip-card'));
        badge.className = 'ill-badge' + (st.className ? ' ' + st.className : '');
        badge.textContent = st.text;
        badge.title = st.title;
      }
    });
  }

  function renderPointCaptions(card){
    var host = card.querySelector('.point-captions');
    if(!host) return;
    var pts = pointsForClip(card);
    if(pts.length === 0){
      host.innerHTML = '<div class="point-captions-empty">No analysis points in range. Adjust the range above to include points.</div>';
      return;
    }
    host.innerHTML = pts.map(function(p, i){
      var frameFile = POINT_FRAMES[p.index];
      var cropImg = frameFile
        ? '<img class="pt-crop-img" draggable="false" src="keyframes/' + encodeURIComponent(frameFile) + '" alt="">'
        : '';
      var thumb = frameFile
        ? '<img class="pt-thumb" loading="lazy" src="keyframes/' + encodeURIComponent(frameFile) + '" alt="" data-ts="' + p.ts_ms + '">'
        : '<div class="pt-thumb" style="background:#1a1f27"></div>';
      // Span: time from this point to the next one in the clip (or
      // the clip end). Gives the user a sense of how long this
      // moment actually plays for.
      var clipEnd = parseInt(card.dataset.end, 10);
      var nextTs = Math.min(clipEnd, nextPointTs(p, clipEnd));
      var spanSec = Math.max(0, (nextTs - p.ts_ms) / 1000);
      var crop = normalizeMomentCropClient(p.crop);
      var hasCrop = hasMomentCropClient(crop);
      var cropButtonClass = 'pt-crop-toggle' + (hasCrop ? ' has-crop' : '');
      return '<div class="point-caption' + (hasCrop ? ' has-crop' : '') + '" data-pt="' + p.index + '">' +
        '<div class="pt-body">' +
          '<div class="pt-media">' +
            '<div class="pt-head">' +
              '<span class="pt-num">#' + p.index + '</span>' +
              '<span class="pt-time">' + fmtSecs(p.ts_ms / 1000) + '</span>' +
              '<span class="pt-span">/ ' + spanSec.toFixed(1) + 's</span>' +
            '</div>' +
            '<div class="pt-thumb-wrap">' +
              thumb +
              '<button class="' + cropButtonClass + '" type="button" title="Moment crop" aria-label="Moment crop" aria-expanded="false"><svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M7 3v14h14"/><path d="M3 7h14v14"/></svg></button>' +
            '</div>' +
          '</div>' +
          '<div class="pt-edit">' +
            '<textarea rows="2" placeholder="caption for this moment">' + escHtml(p.caption || '') + '</textarea>' +
            '<div class="pt-meta-row">' + illustrationBadgeHtml(p, 'pt-illustration-badge', card) + '</div>' +
            '<div class="pt-crop-panel" hidden>' +
              '<div class="pt-crop-stage">' +
                cropImg +
                '<div class="pt-crop-rect" style="' + momentCropRectStyle(crop) + '">' +
                  '<span class="pt-crop-handle" data-handle="nw"></span>' +
                  '<span class="pt-crop-handle" data-handle="ne"></span>' +
                  '<span class="pt-crop-handle" data-handle="sw"></span>' +
                  '<span class="pt-crop-handle" data-handle="se"></span>' +
                '</div>' +
              '</div>' +
              '<div class="pt-crop-actions">' +
                '<button class="pt-crop-copy" type="button">Copy previous</button>' +
                '<button class="pt-crop-clear" type="button">Clear</button>' +
                '<button class="pt-crop-done primary-btn-sm" type="button">Done</button>' +
              '</div>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '</div>';
    }).join('');
    // Bind textareas to the shared point store; edits propagate to
    // other tabs and re-tick the live caption overlay so the new
    // text shows up during playback (a few hundred ms behind).
    host.querySelectorAll('textarea').forEach(function(ta){
      var row = ta.closest('.point-caption');
      var ptIdx = row ? parseInt(row.dataset.pt, 10) : NaN;
      ta.addEventListener('input', function(){
        if(pointById[ptIdx]) pointById[ptIdx].caption = ta.value;
        // Mark every clip card containing this point as "edited" so
        // its overlay falls back to point-window captions (the
        // edited text) instead of the word-chunk timings.
        document.querySelectorAll('.clip-card').forEach(function(card){
          var s = parseInt(card.dataset.start, 10);
          var e = parseInt(card.dataset.end, 10);
          var p = pointById[ptIdx];
          if(p && p.ts_ms >= s && p.ts_ms <= e){
            card.dataset.captionsEdited = '1';
            invalidateVoiceoverPreview(card);
            if(card._captionTick) card._captionTick();
          }
        });
        document.querySelectorAll('.point-caption[data-pt="' + ptIdx + '"] textarea').forEach(function(other){
          if(other !== ta) other.value = ta.value;
        });
        scheduleSave();
      });
    });
    host.querySelectorAll('.pt-crop-toggle').forEach(function(btn){
      btn.addEventListener('click', function(){
        var row = btn.closest('.point-caption');
        var panel = row && row.querySelector('.pt-crop-panel');
        if(!panel) return;
        var open = panel.hasAttribute('hidden');
        if(open){
          host.querySelectorAll('.pt-crop-panel').forEach(function(p){ p.hidden = true; });
          host.querySelectorAll('.pt-crop-toggle').forEach(function(b){ b.setAttribute('aria-expanded', 'false'); });
        }
        panel.hidden = !open;
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      });
    });
    host.querySelectorAll('.pt-crop-rect').forEach(function(rect){
      rect.addEventListener('pointerdown', function(ev){
        ev.preventDefault();
        ev.stopPropagation();
        var row = rect.closest('.point-caption');
        var stage = rect.closest('.pt-crop-stage');
        var ptIdx = row ? parseInt(row.dataset.pt, 10) : NaN;
        if(!stage || !Number.isFinite(ptIdx)) return;
        var mode = ev.target && ev.target.classList && ev.target.classList.contains('pt-crop-handle') ? ev.target.dataset.handle : 'move';
        var startCrop = normalizeMomentCropClient(pointById[ptIdx] && pointById[ptIdx].crop);
        var startX = ev.clientX;
        var startY = ev.clientY;
        var stageBox = stage.getBoundingClientRect();
        if(!stageBox.width || !stageBox.height) return;
        rect.setPointerCapture(ev.pointerId);
        function move(moveEv){
          var dx = (moveEv.clientX - startX) / stageBox.width;
          var dy = (moveEv.clientY - startY) / stageBox.height;
          var next = { left:startCrop.left, top:startCrop.top, right:startCrop.right, bottom:startCrop.bottom };
          var width = 1 - startCrop.left - startCrop.right;
          var height = 1 - startCrop.top - startCrop.bottom;
          if(mode === 'move'){
            next.left = Math.max(0, Math.min(1 - width, startCrop.left + dx));
            next.right = Math.max(0, 1 - next.left - width);
            next.top = Math.max(0, Math.min(1 - height, startCrop.top + dy));
            next.bottom = Math.max(0, 1 - next.top - height);
          } else {
            if(mode.indexOf('w') >= 0) next.left = startCrop.left + dx;
            if(mode.indexOf('e') >= 0) next.right = startCrop.right - dx;
            if(mode.indexOf('n') >= 0) next.top = startCrop.top + dy;
            if(mode.indexOf('s') >= 0) next.bottom = startCrop.bottom - dy;
          }
          next = clampCropRect(next);
          setPointCrop(ptIdx, next);
        }
        function done(doneEv){
          try { rect.releasePointerCapture(doneEv.pointerId); } catch(_){}
          rect.removeEventListener('pointermove', move);
          rect.removeEventListener('pointerup', done);
          rect.removeEventListener('pointercancel', done);
          scheduleSave();
        }
        rect.addEventListener('pointermove', move);
        rect.addEventListener('pointerup', done);
        rect.addEventListener('pointercancel', done);
      });
    });
    host.querySelectorAll('.pt-crop-copy').forEach(function(btn){
      btn.addEventListener('click', function(){
        var row = btn.closest('.point-caption');
        var card = row && row.closest('.clip-card');
        var ptIdx = row ? parseInt(row.dataset.pt, 10) : NaN;
        if(!card || !Number.isFinite(ptIdx)) return;
        var prev = previousPointInCard(card, ptIdx);
        setPointCrop(ptIdx, prev ? normalizeMomentCropClient(prev.crop) : null);
        scheduleSave();
      });
    });
    host.querySelectorAll('.pt-crop-clear').forEach(function(btn){
      btn.addEventListener('click', function(){
        var row = btn.closest('.point-caption');
        var ptIdx = row ? parseInt(row.dataset.pt, 10) : NaN;
        if(!Number.isFinite(ptIdx)) return;
        setPointCrop(ptIdx, null);
        scheduleSave();
      });
    });
    host.querySelectorAll('.pt-crop-done').forEach(function(btn){
      btn.addEventListener('click', function(){
        var row = btn.closest('.point-caption');
        var panel = row && row.querySelector('.pt-crop-panel');
        var toggle = row && row.querySelector('.pt-crop-toggle');
        if(panel) panel.hidden = true;
        if(toggle) toggle.setAttribute('aria-expanded', 'false');
      });
    });
    // Click any thumbnail to seek the clip's player to that moment.
    host.querySelectorAll('.pt-thumb').forEach(function(img){
      img.addEventListener('click', function(){
        var card = host.closest('.clip-card');
        var v = card ? card.querySelector('.clip-player') : null;
        var ts = parseInt(img.dataset && img.dataset.ts, 10);
        if(v && Number.isFinite(ts)){
          if(!v.getAttribute('src')){ v.setAttribute('src','source.mp4'); v.load(); }
          var go = function(){ try { v.currentTime = ts/1000; v.play(); } catch(_){} };
          if(v.readyState >= 1) go();
          else v.addEventListener('loadedmetadata', go, {once:true});
        }
      });
    });
    if(card.classList.contains('collapsed')) refreshClipSummary(card);
  }

  function renderPointIllustrations(card){
    var host = card.querySelector('.point-illustrations');
    if(!host) return;
    var pts = pointsForClip(card);
    if(pts.length === 0){
      host.innerHTML = '<div class="point-captions-empty">No analysis points in range. Adjust the range above to include points.</div>';
      return;
    }
    var assets = illustrationAssetsForCard(card);
    host.innerHTML = pts.map(function(p){
      var effective = effectiveIllustrationForPoint(card, p);
      var ill = effective.ill;
      var illMode = normalizeIllustrationModeClient(effective.mode);
      var hasIllVideo = !!(effective.asset && effective.asset.video_path);
      var illUrl = illustrationUrlForAsset(effective.asset);
      var selectedAssetKey = effective.assetKey;
      var illVideo = hasIllVideo && illUrl
        ? '<video class="ill-thumb-video" muted playsinline preload="metadata" src="' + illUrl + '"></video>'
        : '';
      var thumb = hasIllVideo
        ? illVideo
        : '<button class="ill-empty-thumb" type="button" data-ts="' + p.ts_ms + '">Generate animation</button>';
      var modeOption = function(value, label){
        return '<option value="' + value + '"' + (illMode === value ? ' selected' : '') + '>' + label + '</option>';
      };
      var assetOption = function(asset){
        var label = illustrationAssetLabel(asset);
        var continuation = Number.isFinite(asset.source_ts_ms) && p.ts_ms > asset.source_ts_ms && p.ts_ms < asset.source_ts_ms + asset.duration_ms;
        if(continuation) label += ' (continue)';
        return '<option value="' + escHtml(asset.key) + '"' + (selectedAssetKey === asset.key ? ' selected' : '') + '>' + escHtml(label) + '</option>';
      };
      var coverSec = Math.max(1, illustrationDurationForPoint(card, p) / 1000);
      var status = illustrationStatusForPoint(p, card);
      var statusText = status.text === 'Animation off' ? '' : status.text;
      var fullText = (p.caption || p.original_text || '').replace(/\\s+/g, ' ').trim();
      var text = shortMomentLabel(fullText, 6);
      var rowClass = 'point-illustration' + (effective.inherited ? ' is-inherited' : '');
      var statusClass = 'ill-row-status' + (status.className ? ' ' + status.className : '');
      var previewButton = hasIllVideo ? '<button class="ill-preview-btn" type="button">Preview</button>' : '';
      var explicitIll = readPointIllustration(p);
      var pickChecked = !effective.inherited && normalizeIllustrationModeClient(explicitIll.mode) !== 'none' && explicitIll.explicit === true && !illustrationAssetKeyFrom(explicitIll);
      return '<div class="' + rowClass + '" data-pt="' + p.index + '">' +
        '<div class="ill-body">' +
          '<div class="ill-media">' +
            '<div class="ill-head">' +
              '<span class="ill-num">#' + p.index + '</span>' +
              '<span class="ill-time">' + fmtSecs(p.ts_ms / 1000) + '</span>' +
              '<span class="ill-span">/ covers up to ' + coverSec.toFixed(1) + 's</span>' +
            '</div>' +
            '<div class="ill-thumb-wrap">' +
              thumb +
              '<label class="pt-illustration-pick" title="Select for illustration generation"><input type="checkbox"' + (pickChecked ? ' checked' : '') + '><span></span></label>' +
            '</div>' +
          '</div>' +
          '<div class="ill-edit">' +
            '<div class="ill-title-row">' +
              '<p class="ill-text" title="' + escHtml(fullText || 'No caption text') + '">' + escHtml(text || 'No caption text') + '</p>' +
              '<span class="' + statusClass + '" title="' + escHtml(status.title) + '">' + escHtml(statusText || 'Off') + '</span>' +
            '</div>' +
            '<div class="ill-controls">' +
              '<label><span>Mode</span><select class="pt-illustration-mode">' +
                modeOption('none', 'Original only') +
                modeOption('side_by_side', 'Side by side') +
                modeOption('animation_only', 'Animation only') +
              '</select></label>' +
              '<label><span>Asset</span><select class="pt-illustration-asset">' +
                '<option value="">No animation selected</option>' +
                assets.map(assetOption).join('') +
              '</select></label>' +
              '<span class="ill-row-actions">' +
                previewButton +
                '<button class="pt-illustration-generate" type="button">' + (hasIllVideo ? 'Regenerate' : 'Generate') + '</button>' +
              '</span>' +
              '<span class="pt-illustration-status hint-small">' + escHtml(statusText) + '</span>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '</div>';
    }).join('');
    host.querySelectorAll('.pt-illustration-mode').forEach(function(sel){
      var row = sel.closest('.point-illustration');
      var ptIdx = row ? parseInt(row.dataset.pt, 10) : NaN;
      sel.addEventListener('change', function(){
        var point = pointById[ptIdx];
        if(!point) return;
        var effective = effectiveIllustrationForPoint(card, point);
        var nextMode = normalizeIllustrationModeClient(sel.value);
        var ill = ensurePointIllustration(point);
        if(nextMode !== 'none' && effective.asset && !illustrationAssetKeyFrom(ill)) applyIllustrationAssetToPoint(point, effective.asset);
        if(nextMode === 'none'){
          delete ill.video_path;
          delete ill.cache_key;
          delete ill.source_point_index;
          delete ill.source_ts_ms;
          delete ill.asset_label;
        }
        ill.mode = nextMode;
        ill.explicit = true;
        renderPointIllustrations(card);
        renderPointCaptions(card);
        if(card && card._captionTick) card._captionTick();
        scheduleSave();
      });
    });
    host.querySelectorAll('.pt-illustration-asset').forEach(function(sel){
      var row = sel.closest('.point-illustration');
      var ptIdx = row ? parseInt(row.dataset.pt, 10) : NaN;
      sel.addEventListener('change', function(){
        var point = pointById[ptIdx];
        if(!point) return;
        var ill = ensurePointIllustration(point);
        var key = sel.value || '';
        if(!key){
          delete ill.video_path;
          delete ill.cache_key;
          delete ill.source_point_index;
          delete ill.source_ts_ms;
          delete ill.asset_label;
          ill.explicit = true;
        } else {
          var asset = findIllustrationAssetByKey(card, key);
          if(asset) applyIllustrationAssetToPoint(point, asset);
          if(ill.mode === 'none'){
            ill.mode = defaultIllustrationModeForNewSelection(card);
            var modeSelect = row.querySelector('.pt-illustration-mode');
            if(modeSelect) modeSelect.value = ill.mode;
          }
        }
        renderPointIllustrations(card);
        renderPointCaptions(card);
        if(card._captionTick) card._captionTick();
        scheduleSave();
      });
    });
    host.querySelectorAll('.pt-illustration-pick input').forEach(function(cb){
      cb.addEventListener('change', function(ev){
        ev.stopPropagation();
        var row = cb.closest('.point-illustration');
        var point = row && pointById[parseInt(row.dataset.pt, 10)];
        if(cb.checked && point){
          var effective = effectiveIllustrationForPoint(card, point);
          var ill = ensurePointIllustration(point);
          var selectedMode = defaultIllustrationModeForNewSelection(card);
          if(effective.asset && !illustrationAssetKeyFrom(ill)) applyIllustrationAssetToPoint(point, effective.asset);
          ill.mode = selectedMode;
          ill.explicit = true;
          var select = row.querySelector('.pt-illustration-mode');
          if(select) select.value = selectedMode;
          renderPointIllustrations(card);
          renderPointCaptions(card);
          if(card._captionTick) card._captionTick();
          scheduleSave();
        } else if(point) {
          var current = ensurePointIllustration(point);
          if(!illustrationAssetKeyFrom(current)){
            current.mode = 'none';
            current.explicit = false;
            delete current.duration_ms;
            delete current.prompt;
            delete current.visual_type;
            renderPointIllustrations(card);
            renderPointCaptions(card);
            if(card._captionTick) card._captionTick();
            scheduleSave();
          }
        }
      });
    });
    host.querySelectorAll('.pt-illustration-generate').forEach(function(btn){
      var row = btn.closest('.point-illustration');
      var ptIdx = row ? parseInt(row.dataset.pt, 10) : NaN;
      btn.addEventListener('click', async function(){
        var point = pointById[ptIdx];
        if(!card || !point) return;
        var ill = ensurePointIllustration(point);
        var promptParts = illustrationPromptPartsForPoint(card, point);
        var existingPrompt = promptForIllustrationDialog(card, point, ill, promptParts);
        var edited = await openIllustrationPromptDialog(existingPrompt, promptParts, previousGeneratedIllustrationPrompt(ill));
        if(edited == null) return;
        edited = cleanMultilinePrompt(edited);
        if(!edited) return;
        var status = row && row.querySelector('.pt-illustration-status');
        var ok = await generateIllustrationForPoint(card, point, edited, status, btn, !!ill.video_path);
        if(ok){
          btn.textContent = 'Regenerate';
          renderPointIllustrations(card);
          renderPointCaptions(card);
          scheduleSave();
        }
      });
    });
    host.querySelectorAll('.ill-empty-thumb').forEach(function(btn){
      btn.addEventListener('click', function(){
        var row = btn.closest('.point-illustration');
        var gen = row && row.querySelector('.pt-illustration-generate');
        if(gen) gen.click();
      });
    });
    host.querySelectorAll('.ill-preview-btn').forEach(function(btn){
      btn.addEventListener('click', function(){
        var row = btn.closest('.point-illustration');
        var ptIdx = row ? parseInt(row.dataset.pt, 10) : NaN;
        var point = pointById[ptIdx];
        if(!point) return;
        previewIllustrationAsset(card, point);
      });
    });
    host.querySelectorAll('.ill-thumb,.ill-thumb-video').forEach(function(el){
      el.addEventListener('click', function(){
        var v = card ? card.querySelector('.clip-player') : null;
        var row = el.closest('.point-illustration');
        var point = row && pointById[parseInt(row.dataset.pt, 10)];
        if(v && point){
          if(!v.getAttribute('src')){ v.setAttribute('src','source.mp4'); v.load(); }
          var go = function(){ try { v.currentTime = point.ts_ms/1000; v.play(); } catch(_){} };
          if(v.readyState >= 1) go();
          else v.addEventListener('loadedmetadata', go, {once:true});
        }
      });
    });
    syncIllustrationBadges(card);
    if(card.classList.contains('collapsed')) refreshClipSummary(card);
  }

  function escHtml(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function fmtSecs(s){ var m=Math.floor(s/60), x=(s%60); return m+':'+(x<10?'0':'')+x.toFixed(1); }

  document.addEventListener('click', async function(ev){
    var selectBtn = ev.target.closest && ev.target.closest('.moments-select-suggested');
    if(selectBtn){
      var selectCard = selectBtn.closest('.clip-card');
      if(!selectCard) return;
      ev.preventDefault();
      await selectSuggestedIllustrationPoints(selectCard);
      return;
    }
    var genBtn = ev.target.closest && ev.target.closest('.moments-generate-selected');
    if(!genBtn) return;
    var card = genBtn.closest('.clip-card');
    if(!card) return;
    ev.preventDefault();
    var selected = selectedIllustrationPoints(card);
    if(selected.length === 0){
      await selectSuggestedIllustrationPoints(card);
      selected = selectedIllustrationPoints(card);
    }
    if(selected.length === 0) return;
    genBtn.disabled = true;
    var originalText = genBtn.textContent;
    var generated = 0;
    for(var i = 0; i < selected.length; i++){
      var item = selected[i];
      var status = item.row.querySelector('.pt-illustration-status');
      var rowBtn = item.row.querySelector('.pt-illustration-generate');
      genBtn.textContent = 'Generating ' + (i + 1) + '/' + selected.length;
      var promptParts = illustrationPromptPartsForPoint(card, item.point);
      var promptText = promptForIllustrationDialog(card, item.point, readPointIllustration(item.point), promptParts);
      var ok = await generateIllustrationForPoint(card, item.point, promptText, status, rowBtn, false);
      if(ok){
        generated++;
        var modeSelect = item.row.querySelector('.pt-illustration-mode');
        if(modeSelect) modeSelect.value = ensurePointIllustration(item.point).mode;
        if(rowBtn) rowBtn.textContent = 'Regenerate';
      }
    }
    if(generated > 0){
      renderPointIllustrations(card);
      renderPointCaptions(card);
      scheduleSave();
    }
    genBtn.textContent = originalText;
    genBtn.disabled = false;
  });

  // ─── Resizable two-column panes ──────────────────────────────────
  function setupSplitter(container, storageKey, minPct, maxPct){
    if(!container || container.dataset.splitterReady === '1') return;
    var splitter = Array.prototype.find.call(container.children, function(el){
      return el.classList && el.classList.contains('layout-splitter');
    });
    if(!splitter) return;
    container.dataset.splitterReady = '1';
    try {
      var saved = localStorage.getItem(storageKey);
      if(saved) container.style.setProperty('--left', saved + '%');
    } catch(_){}
    function setFromClientX(x){
      var rect = container.getBoundingClientRect();
      if(!rect.width) return;
      var pct = ((x - rect.left) / rect.width) * 100;
      pct = Math.max(minPct, Math.min(maxPct, pct));
      container.style.setProperty('--left', pct.toFixed(1) + '%');
      try { localStorage.setItem(storageKey, pct.toFixed(1)); } catch(_){}
    }
    splitter.addEventListener('pointerdown', function(ev){
      ev.preventDefault();
      splitter.classList.add('dragging');
      document.body.classList.add('is-resizing');
      try { splitter.setPointerCapture(ev.pointerId); } catch(_){}
      setFromClientX(ev.clientX);
    });
    splitter.addEventListener('pointermove', function(ev){
      if(!splitter.classList.contains('dragging')) return;
      setFromClientX(ev.clientX);
    });
    function stop(ev){
      if(!splitter.classList.contains('dragging')) return;
      splitter.classList.remove('dragging');
      document.body.classList.remove('is-resizing');
      try { splitter.releasePointerCapture(ev.pointerId); } catch(_){}
    }
    splitter.addEventListener('pointerup', stop);
    splitter.addEventListener('pointercancel', stop);
  }
  function setupClipGridSplitter(card){
    setupSplitter(card.querySelector('.clip-grid'), 'aicw-video-split-clip', 30, 70);
  }
  function setupClipGridHeight(card){
    var grid = card && card.querySelector('.clip-grid');
    var left = card && card.querySelector('.clip-grid-left');
    if(!grid || !left || grid.dataset.heightReady === '1') return;
    grid.dataset.heightReady = '1';
    var mq = window.matchMedia ? window.matchMedia('(max-width: 900px)') : null;
    function sync(){
      if(mq && mq.matches){
        grid.style.removeProperty('--clip-grid-h');
        return;
      }
      var h = Math.ceil(left.getBoundingClientRect().height || left.offsetHeight || 0);
      if(h > 0) grid.style.setProperty('--clip-grid-h', Math.max(320, h) + 'px');
    }
    sync();
    if(typeof ResizeObserver !== 'undefined'){
      var ro = new ResizeObserver(sync);
      ro.observe(left);
      grid._heightObserver = ro;
    } else {
      window.addEventListener('resize', sync);
    }
    if(mq && mq.addEventListener) mq.addEventListener('change', sync);
    else if(mq && mq.addListener) mq.addListener(sync);
    var video = card.querySelector('.clip-player');
    if(video){
      video.addEventListener('loadedmetadata', sync);
      video.addEventListener('loadeddata', sync);
    }
    setTimeout(sync, 0);
  }
  setupSplitter(document.querySelector('.panel-grid'), 'aicw-video-split-panel', 32, 74);
  document.querySelectorAll('.clip-card').forEach(setupClipGridSplitter);
  document.querySelectorAll('.clip-card').forEach(setupClipGridHeight);

  // Defaults from config.json (server-side). Per-clip ⚙ Settings
  // override these; falling back to these when the card carries no
  // override yet (data-caption-style="" etc.).
  var DEFAULTS = STATE.defaults || { caption_style:'bold-white-bottom', caption_animation:'word-highlight', reframe:'letterbox-blur' };
  var CAPTION_STYLE_IDS = ${JSON.stringify(ALL_STYLES)};
  var CAPTION_STYLE_SET = new Set(CAPTION_STYLE_IDS);
  function normalizeCaptionStyleClient(value){
    var raw = (typeof value === 'string' ? value : '').trim();
    var aliases = {
      'plain':'plain-bottom',
      'plain-top':'plain-bottom',
      'tiktok-yellow':'tiktok-yellow-bottom',
      'tiktok-yellow-top':'tiktok-yellow-bottom',
      'bold-white':'bold-white-bottom',
      'bold-white-top':'bold-white-bottom',
      'neon':'neon-bottom',
      'neon-top':'neon-bottom',
      'pastel':'pastel-bottom',
      'pastel-top':'pastel-bottom',
      'mrbeast-impact':'beast-impact-bottom',
      'beast-impact':'beast-impact-bottom',
      'beast-impact-top':'beast-impact-bottom',
      'creator-thin':'creator-thin-bottom',
      'creator-thin-top':'creator-thin-bottom',
      'karaoke':'karaoke-bottom',
      'karaoke-top':'karaoke-bottom'
    };
    var mapped = aliases[raw] || raw;
    return CAPTION_STYLE_SET.has(mapped) ? mapped : 'plain-bottom';
  }
  function captionStylePlacementClient(style){
    return normalizeCaptionStyleClient(style).endsWith('-top') ? 'top' : 'bottom';
  }
  function captionStyleBaseClient(style){
    return normalizeCaptionStyleClient(style).replace(/-(top|bottom)$/,'');
  }
  function setOverlayStyleDataset(ov, style){
    if(!ov) return;
    var normalized = normalizeCaptionStyleClient(style);
    ov.dataset.style = normalized;
    ov.dataset.styleBase = captionStyleBaseClient(normalized);
    ov.dataset.placement = captionStylePlacementClient(normalized);
  }

  function clipSetting(card, key){
    var attr = 'data-' + key.replace(/_/g,'-');
    var val = card.getAttribute(attr) || '';
    if(key === 'caption_style') return normalizeCaptionStyleClient(val || DEFAULTS[key] || '');
    if(val) return val;
    return DEFAULTS[key] || '';
  }

  function previewAspectFromVariant(value){
    if(value === 'youtube-shorts') return '9:16';
    if(value === 'linkedin') return '1:1';
    return value || '';
  }

  function applyPreviewState(card){
    var wrap = card.querySelector('.clip-video-wrap');
    if(!wrap) return;
    var select = card.querySelector('.clip-preview-aspect');
    var aspect = select ? previewAspectFromVariant(select.value) : '';
    if(aspect) wrap.setAttribute('data-preview-aspect', aspect);
    else wrap.removeAttribute('data-preview-aspect');
    var cropOn = clipSetting(card, 'reframe') === 'crop';
    wrap.setAttribute('data-crop-preview', cropOn ? '1' : '0');
    var player = card.querySelector('.clip-player');
    if(player){
      var cropX = Number(card.getAttribute('data-crop-x-norm'));
      if(cropOn && Number.isFinite(cropX)){
        player.style.objectPosition = (Math.max(0, Math.min(1, cropX)) * 100).toFixed(1) + '% 50%';
      } else {
        player.style.objectPosition = '50% 50%';
      }
    }
    var cropCheck = card.querySelector('.clip-crop-check');
    if(cropCheck) cropCheck.checked = cropOn;
  }

  function setCardReframe(card, value){
    card.setAttribute('data-reframe', value);
    var reframeSel = card.querySelector('.cs-reframe');
    if(reframeSel) reframeSel.value = value;
    var cropCheck = card.querySelector('.clip-crop-check');
    if(cropCheck) cropCheck.checked = value === 'crop';
    applyPreviewState(card);
  }

  function readPlan(){
    var clips = [];
    document.querySelectorAll('.clip-card').forEach(function(card){
      var baseId = card.dataset.id;
      var start_ms = parseInt(card.dataset.start, 10);
      var end_ms = parseInt(card.dataset.end, 10);
      var sp = parseInt(card.dataset.startPoint, 10);
      var ep = parseInt(card.dataset.endPoint, 10);
      var title = card.querySelector('.title-input').value.trim() || defaultClipTitle('Clip ' + baseId);
      // Per-clip render settings (caption style/animation, reframe).
      var captionStyle = clipSetting(card, 'caption_style');
      var captionAnim  = clipSetting(card, 'caption_animation');
      var reframe      = clipSetting(card, 'reframe');
      var faceEmojiEnabled = card.getAttribute('data-face-emoji-enabled') === '1';
      var faceEmoji = faceEmojiForCard(card);
      var faceBlur = faceBlurForCard(card);
      var faceImitateSpeaking = faceImitateSpeakingForCard(card);
      var cropXNorm = Number(card.getAttribute('data-crop-x-norm'));
      var voiceoverEnabled = card.getAttribute('data-voiceover-enabled') === '1';
      var voiceoverVoice = (card.getAttribute('data-voiceover-voice') || '').trim();
      var renderTitle = (card.getAttribute('data-render-title') || '').trim();
      // Caption lines are joined from this clip's points (in order). Editing any
      // point's caption updates POINTS in place, so this always reflects the
      // latest text the user typed in any tab.
      var caption_lines = [];
      pointsForClip(card).forEach(function(p){
        var t = (p.caption || '').trim();
        if(t) caption_lines.push(t);
      });
      // The new model: one entry per clip (no aspects/durations
      // multiplier — those become render-time choices in the Render…
      // dialog). Default aspect 9:16 stays so existing renderer code
      // that reads aspect_ratio keeps working until the dialog ships.
      var clip = {
        id: baseId,
        start_ms: start_ms, end_ms: end_ms,
        title: title,
        reframe: reframe,
        aspect_ratio: '9:16',
        caption_style: captionStyle,
        caption_animation: captionAnim,
        face_emoji_enabled: faceEmojiEnabled,
        face_emoji: faceEmoji,
        face_blur: faceBlur,
        face_imitate_speaking: faceImitateSpeaking,
        voiceover_enabled: voiceoverEnabled,
      };
      if(Number.isFinite(cropXNorm)) clip.crop_x_norm = Math.max(0, Math.min(1, cropXNorm));
      if(voiceoverVoice) clip.voiceover_voice = voiceoverVoice;
      if(renderTitle) clip.render_title = renderTitle;
      if(Number.isFinite(sp) && Number.isFinite(ep)){ clip.start_point = sp; clip.end_point = ep; }
      if(caption_lines.length) clip.caption_lines = caption_lines;
      clips.push(clip);
    });
    return { version: 2, points: POINTS, clips: clips };
  }

  // Click on a segment thumbnail seeks the clip's own player to that segment's start.
  document.querySelectorAll('.segment-cell').forEach(function(cell){
    var thumb = cell.querySelector('.segment-thumb');
    if(!thumb) return;
    thumb.addEventListener('click', function(){
      var card = cell.closest('.clip-card');
      var v = card ? card.querySelector('.clip-player') : document.getElementById('src-video');
      var t = parseInt(cell.dataset.segStart, 10) / 1000;
      if(v){
        if(!v.getAttribute('src')){ v.setAttribute('src', 'source.mp4'); v.load(); }
        var doSeek = function(){ try { v.currentTime = t; v.play(); } catch(e){} };
        if(v.readyState >= 1) doSeek();
        else v.addEventListener('loadedmetadata', doSeek, {once:true});
      }
    });
  });

  // ─── Per-clip range slider with point-snapping ────────────────────
  function setupRange(card){
    var sourceMs = parseFloat(card.dataset.sourceMs) || 1;
    var track = card.querySelector('.range-track');
    if(!track) return;
    var hIn = card.querySelector('.range-in');
    var hOut = card.querySelector('.range-out');
    var active = card.querySelector('.range-active');
    var inLabel = card.querySelector('.range-in-label');
    var outLabel = card.querySelector('.range-out-label');
    var durSpan = card.querySelector('.range-dur');
    var video = card.querySelector('.clip-player');

    function pct(ms){ return (ms / sourceMs) * 100; }
    function nearestPoint(ms){
      if(POINTS.length === 0) return null;
      var best = POINTS[0], bestD = Math.abs(POINTS[0].ts_ms - ms);
      for(var i=1;i<POINTS.length;i++){
        var d = Math.abs(POINTS[i].ts_ms - ms);
        if(d < bestD){ best = POINTS[i]; bestD = d; }
      }
      return best;
    }
    function render(){
      var s = parseInt(card.dataset.start, 10);
      var e = parseInt(card.dataset.end, 10);
      var sp = parseInt(card.dataset.startPoint, 10);
      var ep = parseInt(card.dataset.endPoint, 10);
      hIn.style.left = pct(s) + '%';
      hOut.style.left = pct(e) + '%';
      active.style.left = pct(s) + '%';
      active.style.width = (pct(e) - pct(s)) + '%';
      if(inLabel) inLabel.textContent = Number.isFinite(sp) ? ('point #' + sp + ' (' + fmtSecs(s/1000) + ')') : (fmtSecs(s/1000));
      if(outLabel) outLabel.textContent = Number.isFinite(ep) ? ('point #' + ep + ' (' + fmtSecs(e/1000) + ')') : (fmtSecs(e/1000));
      if(durSpan) durSpan.textContent = '(' + ((e - s) / 1000).toFixed(1) + 's)';
    }

    function attachDrag(handle, which){
      var dragging = false;
      handle.addEventListener('pointerdown', function(e){
        dragging = true;
        handle.setPointerCapture(e.pointerId);
        e.preventDefault();
      });
      handle.addEventListener('pointermove', function(e){
        if(!dragging) return;
        var rect = track.getBoundingClientRect();
        var x = Math.min(rect.right, Math.max(rect.left, e.clientX));
        var rawMs = Math.round(((x - rect.left) / rect.width) * sourceMs);
        // Hold Shift to bypass snapping and place the handle anywhere
        // on the track. Default behaviour snaps to the nearest point.
        var freeMove = !!e.shiftKey;
        var snap = freeMove ? null : nearestPoint(rawMs);
        var newMs = snap ? snap.ts_ms : rawMs;
        if(which === 'in'){
          var endMs = parseInt(card.dataset.end, 10);
          if(snap && parseInt(card.dataset.endPoint, 10) <= snap.index) return;
          if(newMs >= endMs) return;
          card.dataset.start = String(newMs);
          if(snap) card.dataset.startPoint = String(snap.index);
          else card.removeAttribute('data-start-point');
        } else {
          var startMs = parseInt(card.dataset.start, 10);
          if(snap && parseInt(card.dataset.startPoint, 10) >= snap.index) return;
          if(newMs <= startMs) return;
          card.dataset.end = String(newMs);
          if(snap) card.dataset.endPoint = String(snap.index);
          else card.removeAttribute('data-end-point');
        }
        render();
        renderPointCaptions(card);
        renderPointIllustrations(card);
        if(video && video.readyState >= 1){ try { video.currentTime = newMs / 1000; } catch(e){} }
      });
      handle.addEventListener('pointerup', function(e){
        if(!dragging) return;
        dragging = false;
        try { handle.releasePointerCapture(e.pointerId); } catch(_){}
        invalidateVoiceoverPreview(card);
        scheduleSave();
        renderTimeline();
      });
    }
    attachDrag(hIn, 'in');
    attachDrag(hOut, 'out');

    var playBtn = card.querySelector('.play-region');
    var playhead = card.querySelector('.range-playhead');
    var ctCur = card.querySelector('.ct-cur');
    var ctRel = card.querySelector('.ct-rel');

    function clipBoundsMs(){
      return [parseInt(card.dataset.start, 10), parseInt(card.dataset.end, 10)];
    }

    // Always-on playhead: reflects the clip player's current time at all times,
    // clamped visually to the [start..end] markers (the video is also clamped
    // there, see the timeupdate handler below).
    function updatePlayhead(){
      if(!playhead || !video) return;
      var t = isFinite(video.currentTime) ? video.currentTime : 0;
      var b = clipBoundsMs();
      var ms = Math.min(b[1], Math.max(b[0], t * 1000));
      playhead.style.left = (ms / sourceMs * 100) + '%';
      if(ctCur) ctCur.textContent = fmtSecs(ms / 1000);
      if(ctRel){
        var rel = (ms - b[0]) / 1000;
        var len = (b[1] - b[0]) / 1000;
        ctRel.textContent = '+' + rel.toFixed(1) + 's of ' + len.toFixed(1) + 's';
      }
    }
    if(video){
      // Clip-bound auto-loop: whenever currentTime drifts outside [start..end],
      // snap it back. Applies to native playback, scrubbing via the player's
      // own controls, and the "Play region" button alike.
      video.addEventListener('timeupdate', function(){
        var b = clipBoundsMs();
        var t = video.currentTime;
        var sNow = b[0] / 1000;
        var eNow = b[1] / 1000;
        if(t >= eNow){ try { video.currentTime = sNow; } catch(_){} }
        else if(t < sNow - 0.05){ try { video.currentTime = sNow; } catch(_){} }
        updatePlayhead();
      });
      video.addEventListener('loadedmetadata', updatePlayhead);
      video.addEventListener('seeked', updatePlayhead);
    }

    // Drag the playhead to scrub the video — clamped to the clip range.
    if(playhead){
      var dragging = false;
      playhead.addEventListener('pointerdown', function(e){
        e.preventDefault();
        dragging = true;
        playhead.setPointerCapture(e.pointerId);
        if(video && !video.getAttribute('src')){ video.setAttribute('src', 'source.mp4'); video.load(); }
      });
      playhead.addEventListener('pointermove', function(e){
        if(!dragging) return;
        var rect = track.getBoundingClientRect();
        var x = Math.min(rect.right, Math.max(rect.left, e.clientX));
        var rawMs = Math.round(((x - rect.left) / rect.width) * sourceMs);
        var b = clipBoundsMs();
        var ms = Math.min(b[1], Math.max(b[0], rawMs));
        playhead.style.left = ((ms / sourceMs) * 100) + '%';
        if(video){ try { video.currentTime = ms / 1000; } catch(_){} }
      });
      playhead.addEventListener('pointerup', function(e){
        dragging = false;
        try { playhead.releasePointerCapture(e.pointerId); } catch(_){}
      });
    }

    // Click on empty track area also seeks — clamped to the clip range.
    track.addEventListener('click', function(e){
      var t = e.target;
      if(t.classList.contains('range-handle') || t.classList.contains('range-playhead')) return;
      var rect = track.getBoundingClientRect();
      var x = Math.min(rect.right, Math.max(rect.left, e.clientX));
      var rawMs = Math.round(((x - rect.left) / rect.width) * sourceMs);
      var b = clipBoundsMs();
      var ms = Math.min(b[1], Math.max(b[0], rawMs));
      if(video){
        if(!video.getAttribute('src')){ video.setAttribute('src', 'source.mp4'); video.load(); }
        var go = function(){ try { video.currentTime = ms / 1000; } catch(_){} };
        if(video.readyState >= 1) go();
        else video.addEventListener('loadedmetadata', go, {once:true});
      }
    });

    // "Play region" just kicks off playback at the clip start; the timeupdate
    // handler keeps it inside the markers automatically.
    playBtn.addEventListener('click', function(){
      if(!video) return;
      if(!video.paused){ try { video.pause(); } catch(_){} return; }
      if(!video.getAttribute('src')){ video.setAttribute('src', 'source.mp4'); video.load(); }
      var startPlay = function(){
        var b = clipBoundsMs();
        var t = video.currentTime * 1000;
        if(t < b[0] || t >= b[1] - 50){ try { video.currentTime = b[0] / 1000; } catch(_){} }
        var p = video.play();
        if(p && typeof p.catch === 'function') p.catch(function(){});
        setTimeout(function(){
          if(card._captionTick) card._captionTick();
          var demo = card.querySelector('.clip-illustration-player');
          if(demo && !demo.paused){
            var p2 = demo.play();
            if(p2 && typeof p2.catch === 'function') p2.catch(function(){});
          }
        }, 60);
      };
      if(video.readyState >= 1) startPlay();
      else video.addEventListener('loadedmetadata', startPlay, {once:true});
    });
    if(video){
      var syncPlayBtn = function(){
        playBtn.textContent = video.paused ? '▶ Play region' : '■ Pause';
        playBtn.classList.toggle('looping', !video.paused);
        if(active) active.classList.toggle('looping', !video.paused);
      };
      video.addEventListener('play', syncPlayBtn);
      video.addEventListener('pause', syncPlayBtn);
    }

    render();
    renderPointCaptions(card);
    renderPointIllustrations(card);
  }
  document.querySelectorAll('.clip-card').forEach(setupRange);

  // ─── Live caption preview overlay ─────────────────────────────────
  // Approximate match for the final libass render. The overlay reads the
  // clip's points (from POINTS) on every render — so editing a per-moment
  // textarea immediately changes what shows up on the player above.
  // Group whisper word-timings into 2-3 word phrases for the caption
  // overlay so it tracks actual speech (TikTok-style). Punctuation
  // tokens stay attached to the previous word; phrase breaks happen on
  // sentence-ending punctuation OR a > 250 ms inter-word gap OR after
  // 3 words. Each chunk lingers ~200 ms past its last word so it
  // doesn't flicker out before the next one starts.
  function buildCaptionChunks(words){
    var chunks = [];
    var cur = null;
    var GAP_MS = 250;
    var MAX_WORDS = 3;
    var PUNCT_RE = /^[.,;:!?'"\\)\\]\\u2014\\u2013-]+$/;
    // whisper occasionally tokenises words mid-character (e.g. "Coding"
    // → ["C", "oding"]). Token "fragments" are: a single capital letter,
    // OR a token that starts with lowercase AND the immediately
    // preceding word doesn't already end with whitespace/punctuation.
    function isFragmentLeading(token, prevToken){
      if(!prevToken) return false;
      // Single capital letter followed by a lowercase token → glue,
      // except the pronoun "I" which Whisper commonly emits as a
      // normal word ("I come", "I love").
      if(/^[A-Z]$/.test(prevToken) && prevToken !== 'I' && /^[a-z]/.test(token)) return true;
      return false;
    }
    for (var i = 0; i < words.length; i++){
      var w = words[i];
      var t = (w && w.text || '').trim();
      if(!t) continue;
      var isPunct = PUNCT_RE.test(t);
      if(cur === null){
        if(isPunct) continue;
        cur = { startMs: w.startMs, endMs: w.endMs, text: t, count: 1 };
        continue;
      }
      if(isPunct){
        cur.text += t;
        cur.endMs = Math.max(cur.endMs, w.endMs);
        if(/[.!?]$/.test(t)){ chunks.push(cur); cur = null; }
        continue;
      }
      // Detect a fragment-leading token and glue it to the previous
      // word (no space, no chunk break).
      var lastTok = cur.text.split(/\\s+/).pop();
      if(isFragmentLeading(t, lastTok)){
        cur.text += t;
        cur.endMs = w.endMs;
        continue;
      }
      var gap = w.startMs - cur.endMs;
      if(cur.count >= MAX_WORDS || gap > GAP_MS){
        chunks.push(cur);
        cur = { startMs: w.startMs, endMs: w.endMs, text: t, count: 1 };
      } else {
        cur.text += ' ' + t;
        cur.endMs = w.endMs;
        cur.count += 1;
      }
    }
    if(cur) chunks.push(cur);
    // Linger up to 200 ms after the last word, but never overlap the
    // next chunk's start.
    for (var j = 0; j < chunks.length; j++){
      var nextStart = j + 1 < chunks.length ? chunks[j+1].startMs : Infinity;
      chunks[j].endMs = Math.min(nextStart, chunks[j].endMs + 200);
    }
    return chunks;
  }
  var ALL_CHUNKS = (STATE.words && STATE.words.length > 0) ? buildCaptionChunks(STATE.words) : [];

  function captionWindowsForCard(card){
    var s = parseInt(card.dataset.start, 10);
    var e = parseInt(card.dataset.end, 10);
    // Point captions are the editor's source of truth. Transcript
    // chunks are only a fallback when no moment captions exist.
    var inside = POINTS.filter(function(p){ return p.ts_ms >= s && p.ts_ms < e; });
    var pointWindows = inside.map(function(p, i){
      var startMs = p.ts_ms;
      var endMs = (i + 1 < inside.length) ? inside[i+1].ts_ms : e;
      return { startMs: startMs, endMs: endMs, text: (p.caption || '').trim(), index: p.index };
    });
    if(pointWindows.some(function(w){ return w.text; })) return pointWindows;
    if(ALL_CHUNKS.length > 0){
      var chs = ALL_CHUNKS.filter(function(c){ return c.startMs >= s && c.startMs < e; });
      if(chs.length > 0){
        return chs.map(function(c, i){
          return {
            startMs: c.startMs,
            endMs: c.endMs,
            text: c.text,
          };
        });
      }
    }
    return pointWindows;
  }
  function activeWindow(windows, tMs){
    for(var i = windows.length - 1; i >= 0; i--){
      if(tMs >= windows[i].startMs && tMs < windows[i].endMs) return windows[i];
    }
    return null;
  }
  function illustrationUrlForPoint(point){
    var ill = readPointIllustration(point);
    if(ill.cache_key) return 'illustrations/' + encodeURIComponent(ill.cache_key) + '/video.mp4';
    var m = String(ill.video_path || '').match(/cache\\/illustrations\\/([a-f0-9]{24})\\/video\\.mp4$/);
    return m ? 'illustrations/' + encodeURIComponent(m[1]) + '/video.mp4' : '';
  }
  function illustrationUrlForAsset(asset){
    if(!asset) return '';
    if(asset.cache_key) return 'illustrations/' + encodeURIComponent(asset.cache_key) + '/video.mp4';
    var m = String(asset.video_path || '').match(/cache\\/illustrations\\/([a-f0-9]{24})\\/video\\.mp4$/);
    return m ? 'illustrations/' + encodeURIComponent(m[1]) + '/video.mp4' : '';
  }
  function activeIllustrationSegmentForCard(card, tMs){
    var segments = illustrationSegmentsForCardClient(card);
    for(var sIdx = 0; sIdx < segments.length; sIdx++){
      var segment = segments[sIdx];
      if(tMs >= segment.startMs && tMs < segment.endMs) return segment;
    }
    return null;
  }
  function illustrationSegmentsForCardClient(card){
    var clipStart = parseInt(card.dataset.start, 10);
    var clipEnd = parseInt(card.dataset.end, 10);
    if(!Number.isFinite(clipStart) || !Number.isFinite(clipEnd) || clipEnd <= clipStart) return [];
    var events = POINTS.filter(function(point){
      return point && typeof point.ts_ms === 'number' && point.ts_ms < clipEnd && isIllustrationTimelineEventClient(point.illustration);
    }).sort(function(a, b){ return a.ts_ms - b.ts_ms; });
    var raw = [];
    for(var i = 0; i < events.length; i++){
      var point = events[i];
      var ill = readPointIllustration(point);
      var mode = normalizeIllustrationModeClient(ill.mode);
      if(mode === 'none') continue;
      var url = illustrationUrlForPoint(point);
      if(!url) continue;
      var durationMs = Math.max(1000, Number(ill.duration_ms || ILLUSTRATION_MIN_MS));
      var nextEventTs = i + 1 < events.length ? events[i + 1].ts_ms : Infinity;
      var startMs = Math.max(clipStart, point.ts_ms);
      var endMs = Math.min(clipEnd, point.ts_ms + Math.max(ILLUSTRATION_MIN_MS, durationMs), nextEventTs);
      if(endMs > startMs) raw.push({ point: point, mode: mode, url: url, assetKey: illustrationAssetKeyFrom(ill), startMs: startMs, endMs: endMs });
    }
    if(raw.length <= 1) return raw;
    var merged = [];
    raw.forEach(function(segment){
      var prev = merged[merged.length - 1];
      if(prev && prev.mode === segment.mode && prev.url === segment.url && Math.abs(prev.endMs - segment.startMs) <= 1){
        prev.endMs = segment.endMs;
      } else {
        merged.push(segment);
      }
    });
    return merged;
  }
  function effectiveIllustrationForPoint(card, point){
    var explicit = readPointIllustration(point);
    var explicitMode = normalizeIllustrationModeClient(explicit.mode);
    if(isIllustrationTimelineEventClient(point && point.illustration)){
      return {
        inherited: false,
        sourcePoint: point,
        mode: explicitMode,
        ill: explicit,
        assetKey: illustrationAssetKeyFrom(explicit),
        asset: illustrationAssetKeyFrom(explicit) ? generatedIllustrationAssetForPoint(point, explicit) : null
      };
    }
    var segments = illustrationSegmentsForCardClient(card);
    for(var i = 0; i < segments.length; i++){
      var segment = segments[i];
      if(point.ts_ms >= segment.startMs && point.ts_ms < segment.endMs){
        var sourceIll = readPointIllustration(segment.point);
        return {
          inherited: true,
          sourcePoint: segment.point,
          mode: segment.mode,
          ill: sourceIll,
          assetKey: illustrationAssetKeyFrom(sourceIll),
          asset: generatedIllustrationAssetForPoint(segment.point, sourceIll)
        };
      }
    }
    return { inherited: false, sourcePoint: point, mode: 'none', ill: explicit, assetKey: '', asset: null };
  }
  function syncIllustrationPreview(card, tMs){
    var wrap = card.querySelector('.clip-video-wrap');
    var source = card.querySelector('.clip-player');
    var demo = card.querySelector('.clip-illustration-player');
    if(!wrap || !source || !demo) return;
    var segment = activeIllustrationSegmentForCard(card, tMs);
    if(!segment){
      wrap.removeAttribute('data-illustration-mode');
      try { demo.pause(); } catch(_){}
      return;
    }
    wrap.setAttribute('data-illustration-mode', segment.mode);
    if(demo.getAttribute('src') !== segment.url){
      try { demo.pause(); } catch(_){}
      demo.setAttribute('src', segment.url);
      demo.muted = true;
      demo.playsInline = true;
      demo.load();
    }
    try { demo.playbackRate = source.playbackRate || 1; } catch(_){}
    var desired = Math.max(0, (tMs - segment.startMs) / 1000);
    var dur = Number.isFinite(demo.duration) && demo.duration > 0 ? demo.duration : Math.max(.1, (segment.endMs - segment.startMs) / 1000);
    if(dur > 0) desired = desired % dur;
    if(Math.abs((demo.currentTime || 0) - desired) > .12){
      try { demo.currentTime = desired; } catch(_){}
    }
    if(source.paused || source.ended){
      try { demo.pause(); } catch(_){}
    } else {
      var p = demo.play();
      if(p && typeof p.catch === 'function') p.catch(function(){
        demo.addEventListener('canplay', function once(){
          demo.removeEventListener('canplay', once);
          if(!source.paused && !source.ended){
            var p2 = demo.play();
            if(p2 && typeof p2.catch === 'function') p2.catch(function(){});
          }
        }, {once:true});
      });
    }
  }
  function previewIllustrationAsset(card, point){
    var effective = effectiveIllustrationForPoint(card, point);
    var url = illustrationUrlForAsset(effective.asset);
    if(!url) return;
    var demo = card.querySelector('.clip-illustration-player');
    var source = card.querySelector('.clip-player');
    var wasPaused = !source || source.paused;
    if(source) { try { source.pause(); } catch(_){} }
    if(!demo) return;
    demo.muted = true;
    demo.playsInline = true;
    if(demo.getAttribute('src') !== url){
      demo.setAttribute('src', url);
      demo.load();
    }
    var start = function(){
      try { demo.currentTime = 0; } catch(_){}
      var p = demo.play();
      if(p && typeof p.catch === 'function') p.catch(function(){});
    };
    if(demo.readyState >= 1) start();
    else demo.addEventListener('loadedmetadata', start, {once:true});
    var wrap = card.querySelector('.clip-video-wrap');
    if(wrap){
      wrap.setAttribute('data-illustration-mode', effective.mode === 'none' ? 'animation_only' : effective.mode);
    }
    setTimeout(function(){
      if(wasPaused){
        try { demo.pause(); } catch(_){}
        if(card._captionTick) card._captionTick();
      }
    }, Math.min(3000, Math.max(1200, Number((effective.asset && effective.asset.duration_ms) || 2000))));
  }
  // Per-clip caption settings live on the card's data attributes
  // (set by the ⚙ Settings popover and seeded from config.renderDefaults).
  function getCardOverlayStyle(card){
    return clipSetting(card, 'caption_style');
  }
  function getCardOverlayAnimation(card){
    return clipSetting(card, 'caption_animation');
  }
  // Independent of caption-style. Style is colour/shape; animation is
  // how words appear over time. karaoke style implies word-highlight.
  function renderOverlay(card, win, tMs, _style){
    var ov = card.querySelector('.caption-overlay');
    if(!ov) return;
    if(!win || !win.text){ ov.innerHTML = ''; return; }
    var style = normalizeCaptionStyleClient(getCardOverlayStyle(card));
    setOverlayStyleDataset(ov, style);
    var anim = getCardOverlayAnimation(card);
    ov.dataset.anim = anim;
    if(captionStyleBaseClient(style) === 'karaoke' && anim === 'static') anim = 'word-highlight';
    if(anim === 'static'){
      ov.innerHTML = '<span class="cap">' + escHtml(win.text) + '</span>';
      return;
    }
    var words = win.text.split(/\\s+/).filter(Boolean);
    var dur = Math.max(1, win.endMs - win.startMs);
    var rel = Math.max(0, Math.min(dur, tMs - win.startMs));
    var activeIdx = Math.floor(rel / dur * words.length);
    if(activeIdx >= words.length) activeIdx = words.length - 1;
    var html = '<span class="cap">' + words.map(function(w, i){
      var cls = 'cap-word';
      if(i === activeIdx) cls += ' active';
      // word-pop: type-in reveal (only show words up to active).
      if(anim === 'word-pop' && i > activeIdx) cls += ' hidden';
      return '<span class="' + cls + '">' + escHtml(w) + '</span>';
    }).join(' ') + '</span>';
    ov.innerHTML = html;
  }
  function faceEmojiEnabled(card){
    return card.getAttribute('data-face-emoji-enabled') === '1';
  }
  function faceEmojiForCard(card){
    var raw = (card.getAttribute('data-face-emoji') || DEFAULT_FACE_EMOJI).trim() || DEFAULT_FACE_EMOJI;
    if(raw.toLowerCase && raw.toLowerCase() === FACE_EMOJI_NONE) return FACE_EMOJI_NONE;
    return FACE_EMOJI_ASSETS[raw] ? raw : DEFAULT_FACE_EMOJI;
  }
  function faceEmojiAssetForCard(card){
    var emoji = faceEmojiForCard(card);
    if(emoji === FACE_EMOJI_NONE) return '';
    return FACE_EMOJI_ASSETS[emoji] || FACE_EMOJI_ASSETS[DEFAULT_FACE_EMOJI] || '';
  }
  function faceEmojiPresentationForCard(card){
    var emoji = faceEmojiForCard(card);
    var p = FACE_EMOJI_PRESENTATION[emoji] || {};
    return {
      scale: Number.isFinite(Number(p.scale)) ? Number(p.scale) : 1,
      yOffset: Number.isFinite(Number(p.yOffset)) ? Number(p.yOffset) : 0,
    };
  }
  function faceBlurForCard(card){
    var raw = (card.getAttribute('data-face-blur') || 'none').trim();
    return raw === 'soft' || raw === 'strong' ? raw : 'none';
  }
  function faceImitateSpeakingForCard(card){
    return card.getAttribute('data-face-imitate-speaking') === '1';
  }
  function facePrivacyEnabled(card){
    return faceEmojiEnabled(card) && (faceBlurForCard(card) !== 'none' || faceEmojiForCard(card) !== FACE_EMOJI_NONE);
  }
  function activeFacesAt(tMs){
    if(!Array.isArray(POINTS) || POINTS.length === 0) return [];
    for(var i = POINTS.length - 1; i >= 0; i--){
      var p = POINTS[i];
      if(!p || typeof p.ts_ms !== 'number') continue;
      if(p.ts_ms > tMs) continue;
      var faces = p.visual_metadata && Array.isArray(p.visual_metadata.faces)
        ? p.visual_metadata.faces
        : [];
      faces = faces.filter(function(f){
        return f && isFinite(f.x) && isFinite(f.y) && isFinite(f.width) && isFinite(f.height) && f.width > 0.01 && f.height > 0.01;
      });
      if(faces.length > 0) return faces;
    }
    return [];
  }
  function activePointAt(tMs){
    if(!Array.isArray(POINTS) || POINTS.length === 0) return null;
    var best = null;
    for(var i = 0; i < POINTS.length; i++){
      var p = POINTS[i];
      if(!p || typeof p.ts_ms !== 'number') continue;
      if(p.ts_ms <= tMs) best = p;
      else break;
    }
    return best;
  }
  function momentCropForTime(tMs){
    var point = activePointAt(tMs);
    if(!point) return null;
    var crop = normalizeMomentCropClient(point.crop);
    return hasMomentCropClient(crop) ? crop : null;
  }
  function resetMomentCropPreview(card){
    var video = card.querySelector('.clip-player');
    var faceOv = card.querySelector('.face-emoji-overlay');
    if(video) video.style.transform = '';
    if(faceOv) faceOv.style.transform = '';
  }
  function applyMomentCropPreview(card, tMs){
    var crop = momentCropForTime(tMs);
    if(!crop){ resetMomentCropPreview(card); return; }
    var wrap = card.querySelector('.clip-video-wrap');
    var video = card.querySelector('.clip-player');
    if(!wrap || !video){ return; }
    var box = wrap.getBoundingClientRect();
    if(!box.width || !box.height){ resetMomentCropPreview(card); return; }
    var keepW = Math.max(0.05, 1 - crop.left - crop.right);
    var keepH = Math.max(0.05, 1 - crop.top - crop.bottom);
    var zoom = Math.max(1 / keepW, 1 / keepH);
    var visibleW = 1 / zoom;
    var visibleH = 1 / zoom;
    var sourceLeft = crop.left + (keepW - visibleW) / 2;
    var sourceTop = crop.top + (keepH - visibleH) / 2;
    sourceLeft = Math.max(0, Math.min(1 - visibleW, sourceLeft));
    sourceTop = Math.max(0, Math.min(1 - visibleH, sourceTop));
    var tx = -sourceLeft * box.width * zoom;
    var ty = -sourceTop * box.height * zoom;
    var matrix = 'matrix(' + zoom.toFixed(5) + ',0,0,' + zoom.toFixed(5) + ',' + tx.toFixed(1) + ',' + ty.toFixed(1) + ')';
    video.style.transform = matrix;
    var faceOv = card.querySelector('.face-emoji-overlay');
    if(faceOv) faceOv.style.transform = matrix;
  }
  function faceMomentCountForCard(card){
    if(!Array.isArray(POINTS) || POINTS.length === 0) return 0;
    var start = parseInt(card.dataset.start, 10);
    var end = parseInt(card.dataset.end, 10);
    if(!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;
    var sorted = POINTS.slice().sort(function(a,b){ return (a.ts_ms || 0) - (b.ts_ms || 0); });
    var count = 0;
    for(var i = 0; i < sorted.length; i++){
      var p = sorted[i];
      if(!p || typeof p.ts_ms !== 'number') continue;
      if(p.ts_ms >= end) break;
      var nextTs = i + 1 < sorted.length && typeof sorted[i + 1].ts_ms === 'number' ? sorted[i + 1].ts_ms : end;
      if(nextTs <= start) continue;
      var faces = p.visual_metadata && Array.isArray(p.visual_metadata.faces) ? p.visual_metadata.faces : [];
      if(faces.some(function(f){ return f && isFinite(f.x) && isFinite(f.y) && isFinite(f.width) && isFinite(f.height) && f.width > 0.01 && f.height > 0.01; })) count++;
    }
    return count;
  }
  function syncFaceEmojiHint(card){
    var pane = card.querySelector('.clip-tab-settings');
    var hint = pane && pane.querySelector('.cs-face-hint');
    if(!hint) return;
    var count = faceMomentCountForCard(card);
    var enabled = faceEmojiEnabled(card);
    hint.classList.toggle('is-warn', count === 0);
    hint.classList.toggle('is-ok', count > 0);
    if(enabled && !facePrivacyEnabled(card)){
      hint.textContent = 'Choose blur or emoji to apply face privacy.';
    } else if(count > 0){
      hint.textContent = 'Detected in ' + count + ' moment' + (count === 1 ? '' : 's') + '.';
    } else if(enabled) {
      hint.textContent = 'No detected faces. Center fallback will be used.';
    } else {
      hint.textContent = 'No detected faces.';
    }
  }
  function fallbackFaceEmojiRegion(){
    return { x: 0.5, y: 0.5, width: 0, height: 0, fallback_diameter: FACE_EMOJI_FALLBACK_DIAMETER };
  }
  function videoSourceToOverlayRect(video, box, f, presentation){
    var presentationScale = presentation ? Math.max(0.5, Math.min(1.8, Number(presentation.scale) || 1)) : 1;
    var yOffsetNorm = presentation ? Math.max(-0.25, Math.min(0.25, Number(presentation.yOffset) || 0)) : 0;
    var vw = video && video.videoWidth ? video.videoWidth : 0;
    var vh = video && video.videoHeight ? video.videoHeight : 0;
    var bw = box && box.width ? box.width : 0;
    var bh = box && box.height ? box.height : 0;
    if(f && f.fallback_diameter){
      var diameter = Math.max(0.1, Math.min(1, Number(f.fallback_diameter)));
      if(!vw || !vh || !bw || !bh){
        var fallbackBase = bw || bh || 1;
        var fallbackSize0 = Math.max(24, Math.min(720, Math.round(fallbackBase * diameter * presentationScale)));
        return { x: bw / 2, y: bh / 2 + fallbackSize0 * yOffsetNorm, width: fallbackSize0, height: fallbackSize0, size: fallbackSize0 };
      }
      var wrapFallback = video.closest('.clip-video-wrap');
      var fitFallback = wrapFallback && wrapFallback.getAttribute('data-preview-aspect') && wrapFallback.getAttribute('data-crop-preview') === '1' ? 'cover' : 'contain';
      var scaleFallback = fitFallback === 'cover' ? Math.max(bw / vw, bh / vh) : Math.min(bw / vw, bh / vh);
      var drawWFallback = vw * scaleFallback;
      var fallbackSize = Math.max(24, Math.min(720, Math.round(drawWFallback * diameter * presentationScale)));
      return { x: bw / 2, y: bh / 2 + fallbackSize * yOffsetNorm, width: fallbackSize, height: fallbackSize, size: fallbackSize };
    }
    if(!vw || !vh || !bw || !bh){
      var cx0 = Math.max(0, Math.min(1, f.x + f.width / 2));
      var cy0 = Math.max(0, Math.min(1, f.y + f.height / 2 + yOffsetNorm * Math.max(f.width, f.height)));
      var fallbackSize = Math.max(22, Math.min(420, Math.round(Math.max(f.width * bw, f.height * bh) * FACE_EMOJI_SCALE * presentationScale)));
      return { x: cx0 * bw, y: cy0 * bh, width: fallbackSize, height: fallbackSize, size: fallbackSize };
    }
    var wrap = video.closest('.clip-video-wrap');
    var fit = wrap && wrap.getAttribute('data-preview-aspect') && wrap.getAttribute('data-crop-preview') === '1' ? 'cover' : 'contain';
    var scale = fit === 'cover' ? Math.max(bw / vw, bh / vh) : Math.min(bw / vw, bh / vh);
    var drawW = vw * scale;
    var drawH = vh * scale;
    var cropX = 0.5;
    if(wrap && fit === 'cover'){
      var card = wrap.closest('.clip-card');
      var rawCropX = card ? Number(card.getAttribute('data-crop-x-norm')) : NaN;
      if(Number.isFinite(rawCropX)) cropX = Math.max(0, Math.min(1, rawCropX));
    }
    var ox = fit === 'cover' ? (bw - drawW) * cropX : (bw - drawW) / 2;
    var oy = (bh - drawH) / 2;
    var cx = Math.max(0, Math.min(1, f.x + f.width / 2));
    var cy = Math.max(0, Math.min(1, f.y + f.height / 2));
    cy = Math.max(0, Math.min(1, cy + yOffsetNorm * Math.max(f.width, f.height)));
    var rawW = Math.max(1, f.width * vw * scale);
    var rawH = Math.max(1, f.height * vh * scale);
    var boxSize = Math.max(rawW, rawH) * FACE_EMOJI_SCALE * presentationScale;
    return {
      x: ox + cx * vw * scale,
      y: oy + cy * vh * scale,
      width: Math.max(28, Math.min(520, Math.round(rawW * 1.35))),
      height: Math.max(28, Math.min(520, Math.round(rawH * 1.45))),
      size: Math.max(24, Math.min(420, Math.round(boxSize))),
    };
  }
  function wordSpeakingAt(tMs){
    if(!STATE.words || !STATE.words.length) return false;
    for(var i = 0; i < STATE.words.length; i++){
      var w = STATE.words[i];
      if(!w || !w.text || !w.text.trim()) continue;
      if(tMs >= w.startMs && tMs < w.endMs) return true;
      if(w.startMs > tMs) break;
    }
    return false;
  }
  function mouthOpenForWindow(win, tMs){
    void win;
    return wordSpeakingAt(tMs);
  }
  function renderFaceEmoji(card, tMs, speaking){
    var host = card.querySelector('.face-emoji-overlay');
    if(!host) return;
    if(!facePrivacyEnabled(card)){ host.innerHTML = ''; return; }
    var blurMode = faceBlurForCard(card);
    var emojiAsset = faceEmojiAssetForCard(card);
    var presentation = faceEmojiPresentationForCard(card);
    var faces = activeFacesAt(tMs);
    if(faces.length === 0 && faceMomentCountForCard(card) === 0) faces = [fallbackFaceEmojiRegion()];
    if(faces.length === 0){ host.innerHTML = ''; return; }
    var video = card.querySelector('.clip-player');
    var wrap = video && video.closest('.clip-video-wrap');
    var box = (wrap || host).getBoundingClientRect();
    host.innerHTML = faces.slice(0, 6).map(function(f){
      var r = videoSourceToOverlayRect(video, box, f, presentation);
      var html = '';
      if(blurMode !== 'none'){
        html += '<span class="face-blur face-blur-' + blurMode + '" style="left:' + r.x.toFixed(1) + 'px;top:' + r.y.toFixed(1) + 'px;width:' + r.width + 'px;height:' + r.height + 'px"></span>';
      }
      if(emojiAsset){
        var opacity = blurMode === 'none' ? '1' : '.82';
        html += '<img class="face-emoji" src="' + escHtml(emojiAsset) + '" alt="" style="left:' + r.x.toFixed(1) + 'px;top:' + r.y.toFixed(1) + 'px;width:' + r.size + 'px;height:' + r.size + 'px;opacity:' + opacity + '">';
      }
      var mouthAsset = speaking === true && faceImitateSpeakingForCard(card) ? FACE_MOUTH_ASSETS.speaking : '';
      if(mouthAsset){
        var mouthSize = Math.max(18, Math.round(r.size * .34));
        var mouthY = r.y + r.size * .2;
        html += '<img class="face-mouth" src="' + escHtml(mouthAsset) + '" alt="" style="left:' + r.x.toFixed(1) + 'px;top:' + mouthY.toFixed(1) + 'px;width:' + mouthSize + 'px;height:' + mouthSize + 'px">';
      }
      return html;
    }).join('');
  }
  function setupCaptionPreview(card){
    var video = card.querySelector('.clip-player');
    var ov = card.querySelector('.caption-overlay');
    if(!video || !ov) return;
    function tick(){
      var t = (video.currentTime || 0) * 1000;
      var win = activeWindow(captionWindowsForCard(card), t);
      syncIllustrationPreview(card, t);
      renderOverlay(card, win, t, ov.dataset.style || 'bold-white-bottom');
      var clipStartMs = Number(card.dataset.start || 0);
      var canImitateNow = !video.paused && Math.max(0, t - clipStartMs) >= 120;
      renderFaceEmoji(card, t, canImitateNow && mouthOpenForWindow(win, t));
      applyMomentCropPreview(card, t);
    }
    video.addEventListener('timeupdate', tick);
    video.addEventListener('seeked', tick);
    video.addEventListener('loadedmetadata', tick);
    // For karaoke/word-pop the active word advances faster than timeupdate
    // fires — drive a rAF loop while playing for smooth word stepping.
    var raf = 0;
    function loop(){
      if(video.paused || video.ended) return;
      tick();
      raf = requestAnimationFrame(loop);
    }
    video.addEventListener('play', function(){ cancelAnimationFrame(raf); raf = requestAnimationFrame(loop); });
    video.addEventListener('pause', function(){ cancelAnimationFrame(raf); tick(); });
    card._captionTick = tick;
    tick();
  }
  document.querySelectorAll('.clip-card').forEach(setupCaptionPreview);

  // Bundle the per-card initialisation so we can re-run it on dynamically
  // added clip cards (the "Add clip" form below).
  function setupCard(card){
    setupClipGridSplitter(card);
    setupClipGridHeight(card);
    setupRange(card);
    setupCaptionPreview(card);
    syncSettingsTab(card);
    // Lazy-load the new card's video (the IntersectionObserver only watched
    // cards that existed at page load).
    var v = card.querySelector('.clip-player');
    if(v && !v.getAttribute('src')){
      v.setAttribute('src', 'source.mp4');
      v.load();
      var startMs = parseInt(card.dataset.start, 10);
      v.addEventListener('loadedmetadata', function once(){
        v.removeEventListener('loadedmetadata', once);
        try { v.currentTime = startMs / 1000; } catch(e){}
      });
    }
  }

  // ─── Add Clip ─────────────────────────────────────────────────────
  // Adds one full-timeline clip immediately. The user can trim it with
  // the handles after it appears at the end of the list.
  function renumberClipCards(){
    document.querySelectorAll('.clip-card').forEach(function(c, i){
      var n = c.querySelector('.clip-num');
      if(n) n.textContent = '#' + (i + 1);
    });
  }

  (function setupAddClipDialog(){
    var openBtn = document.getElementById('add-clip-open');
    var status = document.getElementById('add-clip-status');
    if(!openBtn) return;
    function shortCaption(p){
      return (p.caption || '').trim().split(/\\s+/).slice(0, 5).join(' ').replace(/[.!?,:;]+$/, '');
    }
    openBtn.addEventListener('click', function(){
      var template = document.querySelector('.clip-card');
      var stack = document.querySelector('.clip-stack');
      if(!template || !stack){
        if(status) status.textContent = 'no clip template available';
        return;
      }
      var pStart = POINTS[0] || { index: 0, ts_ms: 0, caption: '' };
      var pEnd = POINTS[POINTS.length - 1] || { index: 0, ts_ms: STATE.sourceDurationMs || 0, caption: '' };
      var startMs = 0;
      var endMs = Math.max(1000, STATE.sourceDurationMs || pEnd.ts_ms || 0);
      var card = template.cloneNode(true);
      var newId = 'clip_' + Date.now().toString(36);
      var title = defaultClipTitle(shortCaption(pStart) || 'Full video');
      card.id = 'clip-' + newId;
      card.classList.remove('collapsed');
      card.dataset.id = newId;
      card.dataset.start = String(startMs);
      card.dataset.end = String(endMs);
      card.dataset.order = String(Date.now());
      card.dataset.fullTimeline = '1';
      if(POINTS.length > 0) card.dataset.startPoint = String(pStart.index);
      else card.removeAttribute('data-start-point');
      if(POINTS.length > 0) card.dataset.endPoint = String(pEnd.index);
      else card.removeAttribute('data-end-point');
      card.dataset.activeTab = 'clip';
      card.dataset.faceEmojiEnabled = '0';
      card.dataset.faceEmoji = DEFAULT_FACE_EMOJI;
      card.dataset.faceBlur = 'none';
      card.dataset.voiceoverEnabled = '0';
      card.dataset.voiceoverVoice = '';
      delete card.dataset.voiceoverVideoUrl;
      delete card.dataset.voiceoverAudioUrl;
      delete card.dataset.captionsEdited;
      card.querySelectorAll('.clip-tab').forEach(function(t){
        var active = t.dataset.clipTab === 'clip';
        t.classList.toggle('active', active);
        t.setAttribute('aria-selected', active ? 'true' : 'false');
      });
      var titleInput = card.querySelector('.title-input');
      if(titleInput) titleInput.value = title;
      var summary = card.querySelector('.clip-summary');
      if(summary) summary.hidden = true;
      var reason = card.querySelector('.clip-reason');
      if(reason) reason.textContent = 'user-added full-timeline clip';
      var badge = card.querySelector('[data-rendered-count]');
      if(badge) badge.textContent = '0';
      card.querySelectorAll('input[type="radio"][name^="cs-style-"]').forEach(function(input){
        input.name = 'cs-style-' + newId;
      });
      var v = card.querySelector('.clip-player');
      if(v){ v.removeAttribute('src'); v.load && v.load(); }
      var ov = card.querySelector('.caption-overlay'); if(ov) ov.innerHTML = '';
      var faceOv = card.querySelector('.face-emoji-overlay'); if(faceOv) faceOv.innerHTML = '';
      var ctCur = card.querySelector('.ct-cur'); if(ctCur) ctCur.textContent = fmtSecs(pStart.ts_ms / 1000);
      var renders = card.querySelector('.renders');
      if(renders){
        renders.setAttribute('data-slug', title.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,50) || newId);
        renders.innerHTML = emptyRendersHtml('none yet — click "▶ Render…" above to render this clip');
      }
      var pc = card.querySelector('.point-captions');
      if(pc){ pc.setAttribute('data-clip', newId); pc.innerHTML = ''; }
      var pi = card.querySelector('.point-illustrations');
      if(pi){ pi.setAttribute('data-clip', newId); pi.innerHTML = ''; }
      stack.appendChild(card);
      setupCard(card);
      renumberClipCards();
      if(status) status.textContent = 'added full-timeline clip';
      renderTimeline();
      scheduleSave();
      setTimeout(function(){ card.scrollIntoView({behavior:'smooth', block:'start'}); }, 30);
    });
  })();

  // Caption text edits propagate live: re-tick every clip whose card has
  // been wired up (cheap — each tick just reads POINTS which the textarea
  // input handler already updated).
  document.addEventListener('input', function(ev){
    if(ev.target.tagName !== 'TEXTAREA') return;
    if(!ev.target.closest('.point-captions')) return;
    document.querySelectorAll('.clip-card').forEach(function(card){
      if(card._captionTick) card._captionTick();
    });
  });

  // ─── Caption padding tracks the rendered output's 9:16 aspect ────
  // The preview <video> element is always 16:9 in the UI, but the
  // final render letterboxes the source into a portrait frame. Caption
  // text must sit inside that visible frame, not on the black bars.
  // Hard-coded to 9:16 — output sizes are picked at render time, but
  // 9:16 is the canonical preview aspect (it's the most-constrained).
  (function(){
    var target = 9 / 16;
    var player = 16 / 9;
    var contentFrac = target / player;
    var sidePct = Math.max(5, ((1 - contentFrac) / 2) * 100 + 2);
    document.documentElement.style.setProperty('--cap-pad-x', sidePct.toFixed(1) + '%');
  })();

  // ─── Timeline ─────────────────────────────────────────────────────
  // Two views of the same data:
  //   • Mini strip (in the summary): always visible, single row, every
  //     clip drawn at its source-relative position. Lets the user see
  //     placement at a glance even when the timeline is collapsed.
  //   • Multitrack body (in the <details>): one row per clip + a source
  //     row up top with point ticks. Each row holds just its own clip
  //     bar so overlapping clips don't stack.
  function renderTimeline(){
    var srcMs = STATE.sourceDurationMs || 1;
    var cards = Array.from(document.querySelectorAll('.clip-card'));
    var clips = cards.map(function(card, i){
      var s = parseInt(card.dataset.start, 10);
      var e = parseInt(card.dataset.end, 10);
      var title = card.querySelector('.title-input').value.trim() || ('Clip ' + (i+1));
      var left = s / srcMs * 100;
      var width = (e - s) / srcMs * 100;
      return { id: card.id, title: title, left: left, width: width };
    });

    // Mini single-row preview (shown when collapsed).
    var mini = document.getElementById('timeline-mini');
    if(mini){
      var miniTicks = POINTS.map(function(p){
        return '<div class="tm-tick" style="left:' + (p.ts_ms / srcMs * 100) + '%" title="#' + p.index + ' ' + fmtSecs(p.ts_ms / 1000) + '"></div>';
      }).join('');
      var miniBars = clips.map(function(b){
        return '<div class="tm-bar" data-target="' + b.id + '" title="' + escHtml(b.title) + '" style="left:' + b.left + '%;width:' + b.width + '%"></div>';
      }).join('');
      mini.innerHTML = miniTicks + miniBars;
    }

    // Multitrack body (shown when expanded). One row per clip.
    var host = document.getElementById('timeline-host');
    if(!host) return;
    var rows = '';
    var ticks = POINTS.map(function(p){
      return '<div class="tl-tick" style="left:' + (p.ts_ms / srcMs * 100) + '%" title="#' + p.index + ' ' + fmtSecs(p.ts_ms / 1000) + '"></div>';
    }).join('');
    rows += '<div class="tl-row tl-source"><span class="tl-row-label">source</span>' + ticks + '</div>';
    clips.forEach(function(b, i){
      rows += '<div class="tl-row tl-clip-row">' +
        '<span class="tl-row-label">#' + (i+1) + '</span>' +
        '<a class="tl-bar" href="#' + b.id + '" title="' + escHtml(b.title) + '" style="left:' + b.left + '%;width:' + b.width + '%">' + escHtml(b.title) + '</a>' +
        '</div>';
    });
    host.innerHTML = rows;

    function scrollToClip(id, ev){
      var el = document.getElementById(id);
      if(!el) return;
      if(ev) ev.preventDefault();
      activateTab('source');
      setTimeout(function(){ el.scrollIntoView({behavior:'smooth',block:'start'}); }, 30);
      try { history.replaceState(null,'','#'+id); } catch(e){}
    }
    host.querySelectorAll('.tl-bar').forEach(function(a){
      a.addEventListener('click', function(ev){ scrollToClip(a.getAttribute('href').slice(1), ev); });
    });
    // Mini bars: stop the click from toggling the <details> open/close.
    if(mini){
      mini.querySelectorAll('.tm-bar').forEach(function(b){
        b.addEventListener('click', function(ev){
          ev.preventDefault();
          ev.stopPropagation();
          scrollToClip(b.dataset.target);
        });
      });
    }
  }
  renderTimeline();
  // Re-render the timeline whenever a clip title changes.
  document.addEventListener('input', function(ev){
    if(ev.target.classList.contains('title-input')) renderTimeline();
  });

  function setSaveState(state){
    if(!status) return;
    status.classList.remove('saving','error');
    if(state === 'saving'){ status.classList.add('saving'); status.textContent = 'saving…'; }
    else if(state === 'error'){ status.classList.add('error'); status.textContent = 'save failed'; }
    else { status.textContent = 'auto-saved ✓'; }
  }
  function flash(text){
    if(!status) return;
    status.textContent = text;
    setTimeout(function(){ setSaveState('saved'); }, 1800);
  }

  // ─── Empty-state placeholder for Rendered panels ──────────────────
  // One card. Same shape on every empty list (per-clip "Rendered"
  // tab, the video-level "Rendered clips" panel, post-Add-clip).
  function emptyRendersHtml(hint){
    return '<div class="render-empty-grid"><div class="render-card-empty render-card-empty-solo"><span class="rce-label">' + escHtml(hint) + '</span></div></div>';
  }

  // ─── Auto-save (debounced) ────────────────────────────────────────
  var saveTimer = null;
  function scheduleSave(){
    if(saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function(){ doSave(true); }, 500);
  }
  async function doSave(quiet){
    var plan = readPlan();
    preview.textContent = JSON.stringify(plan, null, 2);
    if(plan.clips.length === 0){
      if(!quiet) flash('no clips yet');
      return false;
    }
    setSaveState('saving');
    try {
      var r = await fetch('api/save', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(plan) });
      if(!r.ok){ setSaveState('error'); return false; }
      setSaveState('saved');
      return true;
    } catch(e) { flash('save failed: ' + e.message); return false; }
  }

  document.addEventListener('input', scheduleSave);
  document.addEventListener('change', function(ev){
    if(ev.target.matches && ev.target.matches('.clip-preview-aspect')) return;
    scheduleSave();
  });
  // Top-bar "Save" + "Render clips" are gone — saves are debounced
  // automatically and rendering is per-clip via the ▶ Render… button
  // on each clip card.

  // Inner clip tabs: Clip ↔ Rendered (N) ↔ Settings.
  document.addEventListener('click', function(ev){
    var tab = ev.target.closest && ev.target.closest('.clip-tab');
    if(!tab) return;
    var card = tab.closest('.clip-card');
    if(!card) return;
    card.dataset.activeTab = tab.dataset.clipTab;
    card.querySelectorAll('.clip-tab').forEach(function(t){
      t.classList.toggle('active', t === tab);
    });
    if(tab.dataset.clipTab === 'settings') syncSettingsTab(card);
  });

  // Right-pane tabs inside Edit: Captions ↔ Illustrations.
  document.addEventListener('click', function(ev){
    var tab = ev.target.closest && ev.target.closest('.right-pane-tab');
    if(!tab) return;
    var pane = tab.closest('.clip-grid-right');
    if(!pane) return;
    pane.dataset.rightTab = tab.dataset.rightTab || 'captions';
    pane.querySelectorAll('.right-pane-tab').forEach(function(t){
      t.classList.toggle('active', t === tab);
    });
  });

  // ─── Clip card collapse (per clip, persisted in sessionStorage) ──
  function fmtSecsShort(ms){
    var s = Math.floor((ms||0)/1000);
    return Math.floor(s/60) + ':' + String(s%60).padStart(2,'0');
  }
  function refreshClipSummary(card){
    var span = card.querySelector('.clip-summary');
    if(!span) return;
    var title = (card.querySelector('.title-input') || {}).value || '';
    var s = parseInt(card.dataset.start,10), e = parseInt(card.dataset.end,10);
    var moments = 0;
    try { moments = pointsForClip(card).length; } catch(_){
      moments = card.querySelectorAll('.point-caption').length;
    }
    var rendered = 0;
    var badge = card.querySelector('[data-rendered-count]');
    if(badge) rendered = parseInt(badge.textContent || '0', 10) || 0;
    span.hidden = false;
    span.innerHTML = '<span class="cs-title">' + escHtml(title) + '</span>' +
      '<span class="cs-meta">' + fmtSecsShort(s) + '–' + fmtSecsShort(e) + ' · ' + ((e-s)/1000).toFixed(1) + 's</span>' +
      '<span class="cs-counts">' + moments + ' moment' + (moments === 1 ? '' : 's') + ' · ' + rendered + ' rendered</span>' +
      '<button class="clip-summary-expand" type="button">Expand</button>';
  }
  function setClipCollapsed(card, collapsed){
    card.classList.toggle('collapsed', collapsed);
    var summary = card.querySelector('.clip-summary');
    if(summary) summary.hidden = !collapsed;
    if(collapsed) refreshClipSummary(card);
    var toggle = card.querySelector('.clip-toggle');
    if(toggle){
      toggle.setAttribute('title', collapsed ? 'Expand clip' : 'Collapse clip');
      toggle.setAttribute('aria-label', collapsed ? 'Expand clip' : 'Collapse clip');
    }
  }
  function applyCollapsedFromStorage(){
    document.querySelectorAll('.clip-card').forEach(function(card){
      var key = 'aicw-video-clip-collapsed:' + (card.dataset.id || '');
      var collapsed = false;
      try { collapsed = sessionStorage.getItem(key) === '1'; } catch(_){}
      setClipCollapsed(card, collapsed);
    });
  }
  applyCollapsedFromStorage();
  document.addEventListener('click', function(ev){
    var expand = ev.target.closest && ev.target.closest('.clip-summary-expand');
    if(expand){
      var expandCard = expand.closest('.clip-card');
      if(!expandCard) return;
      ev.preventDefault();
      setClipCollapsed(expandCard, false);
      var expandKey = 'aicw-video-clip-collapsed:' + (expandCard.dataset.id || '');
      try { sessionStorage.setItem(expandKey, '0'); } catch(_){}
      return;
    }
    var btn = ev.target.closest && ev.target.closest('.clip-toggle');
    if(!btn) return;
    var card = btn.closest('.clip-card');
    if(!card) return;
    ev.preventDefault();
    var was = card.classList.contains('collapsed');
    setClipCollapsed(card, !was);
    var key = 'aicw-video-clip-collapsed:' + (card.dataset.id || '');
    try { sessionStorage.setItem(key, (!was) ? '1' : '0'); } catch(_){}
  });
  // Keep the summary in sync with title edits while collapsed (the
  // input is hidden so editing happens via expand → edit → collapse,
  // but if a user sets the title while expanded we still update).
  document.addEventListener('input', function(ev){
    if(!ev.target.classList.contains('title-input')) return;
    var card = ev.target.closest('.clip-card');
    if(card && card.classList.contains('collapsed')) refreshClipSummary(card);
  });

  // Per-clip Settings tab: seed the radio + selects from the card's
  // data-* attributes (or DEFAULTS) on first paint, then persist back
  // to the attributes on every change.
  function syncSettingsTab(card){
    var pane = card.querySelector('.clip-tab-settings');
    if(!pane) return;
    var styleVal = clipSetting(card, 'caption_style');
    var animVal  = clipSetting(card, 'caption_animation');
    var reframeVal = clipSetting(card, 'reframe');
    var checkedStyle = null;
    pane.querySelectorAll('input[type="radio"]').forEach(function(r){
      r.checked = (r.value === styleVal);
      if(r.checked) checkedStyle = r;
    });
    var animSel = pane.querySelector('.cs-anim');
    if(animSel) animSel.value = animVal;
    var reframeSel = pane.querySelector('.cs-reframe');
    if(reframeSel) reframeSel.value = reframeVal;
    var faceEnabled = pane.querySelector('.cs-face-enabled');
    if(faceEnabled) faceEnabled.checked = card.getAttribute('data-face-emoji-enabled') === '1';
    var faceBlur = pane.querySelector('.cs-face-blur');
    if(faceBlur) faceBlur.value = faceBlurForCard(card);
    var faceEmoji = pane.querySelector('.cs-face-emoji');
    if(faceEmoji) faceEmoji.value = faceEmojiForCard(card);
    syncFaceEmojiHint(card);
    var voiceEnabled = pane.querySelector('.cs-voice-enabled');
    if(voiceEnabled) voiceEnabled.checked = card.getAttribute('data-voiceover-enabled') === '1';
    var imitateSpeaking = pane.querySelector('.cs-face-imitate-speaking');
    if(imitateSpeaking) imitateSpeaking.checked = faceImitateSpeakingForCard(card);
    var voiceSelect = pane.querySelector('.cs-voice-select');
    if(voiceSelect) voiceSelect.value = card.getAttribute('data-voiceover-voice') || '';
    applyPreviewState(card);
    ensureVoiceoverPreviewForCard(card, pane);
    if(card.dataset.activeTab === 'settings' && checkedStyle){
      var selectedTile = checkedStyle.closest('.cs-style-pick');
      if(selectedTile) selectedTile.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }
  document.querySelectorAll('.clip-card').forEach(syncSettingsTab);

  // ⚙ button just switches the card to its Settings tab.
  document.addEventListener('click', function(ev){
    var btn = ev.target.closest && ev.target.closest('.clip-settings-btn');
    if(!btn) return;
    var card = btn.closest('.clip-card');
    if(!card) return;
    card.dataset.activeTab = 'settings';
    card.querySelectorAll('.clip-tab').forEach(function(t){
      t.classList.toggle('active', t.dataset.clipTab === 'settings');
    });
    syncSettingsTab(card);
  });

  // Preview-only output shape + quick crop toggle in the video area.
  // The shape changes only the editor preview; the Render dialog still
  // decides which sizes are exported. The crop checkbox maps to the
  // existing saved reframe setting so rendering follows the same choice.
  document.addEventListener('change', function(ev){
    if(ev.target.matches && ev.target.matches('.clip-preview-aspect')){
      var card = ev.target.closest('.clip-card');
      if(card) applyPreviewState(card);
      return;
    }
    if(ev.target.matches && ev.target.matches('.clip-crop-check')){
      var cropCard = ev.target.closest('.clip-card');
      if(!cropCard) return;
      setCardReframe(cropCard, ev.target.checked ? 'crop' : 'letterbox-blur');
      scheduleSave();
    }
  });

  // Persist per-clip settings on change. The card's data-* attributes
  // are the canonical store; readPlan() reads them straight back into
  // plan.json.
  document.addEventListener('change', function(ev){
    var pane = ev.target.closest && ev.target.closest('.clip-tab-settings');
    if(!pane) return;
    var card = pane.closest('.clip-card');
    if(!card) return;
    if(ev.target.matches('input[type="radio"]')){
      var nextStyle = normalizeCaptionStyleClient(ev.target.value);
      card.setAttribute('data-caption-style', nextStyle);
      var ov = card.querySelector('.caption-overlay');
      setOverlayStyleDataset(ov, nextStyle);
      if(card._captionTick) card._captionTick();
    } else if(ev.target.matches('.cs-anim')){
      card.setAttribute('data-caption-animation', ev.target.value);
      var ov2 = card.querySelector('.caption-overlay');
      if(ov2) ov2.dataset.anim = ev.target.value;
      if(card._captionTick) card._captionTick();
    } else if(ev.target.matches('.cs-reframe')){
      setCardReframe(card, ev.target.value);
    } else if(ev.target.matches('.cs-face-enabled')){
      card.setAttribute('data-face-emoji-enabled', ev.target.checked ? '1' : '0');
      syncFaceEmojiHint(card);
      if(card._captionTick) card._captionTick();
    } else if(ev.target.matches('.cs-face-blur')){
      card.setAttribute('data-face-blur', ev.target.value || 'none');
      syncFaceEmojiHint(card);
      if(card._captionTick) card._captionTick();
    } else if(ev.target.matches('.cs-face-emoji')){
      card.setAttribute('data-face-emoji', ev.target.value || FACE_EMOJI_NONE);
      syncFaceEmojiHint(card);
      if(card._captionTick) card._captionTick();
    } else if(ev.target.matches('.cs-face-imitate-speaking')){
      card.setAttribute('data-face-imitate-speaking', ev.target.checked ? '1' : '0');
      if(card._captionTick) card._captionTick();
    } else if(ev.target.matches('.cs-voice-enabled')){
      stopVoicePreviewAudio();
      card.setAttribute('data-voiceover-enabled', ev.target.checked ? '1' : '0');
      if(ev.target.checked){
        generateVoiceoverPreviewForCard(card, pane, {statusText:'Generating...'});
      } else {
        applyVoiceoverPreviewSource(card);
      }
    } else if(ev.target.matches('.cs-voice-select')){
      stopVoicePreviewAudio();
      card.setAttribute('data-voiceover-voice', ev.target.value || '');
      invalidateVoiceoverPreview(card);
      if(card.getAttribute('data-voiceover-enabled') === '1'){
        generateVoiceoverPreviewForCard(card, pane, {statusText:'Generating...'});
      }
    }
    scheduleSave();
  });

  document.addEventListener('click', async function(ev){
    var btn = ev.target.closest && ev.target.closest('.cs-voice-preview');
    if(!btn) return;
    var pane = btn.closest('.clip-tab-settings');
    var card = pane && pane.closest('.clip-card');
    if(!card) return;
    var status = pane.querySelector('.cs-voice-status');
    try {
      var data = await generateVoiceoverPreviewForCard(card, pane, {statusText:'Generating...', failureText:'Preview failed'});
      if(!data) return;
      var startMs = parseInt(card.dataset.start, 10) || 0;
      if(card.dataset.voiceoverAudioUrl){
        await playVoicePreviewAudio(card.dataset.voiceoverAudioUrl, startMs);
      }
    } catch(e) {
      if(status) status.textContent = e && e.message ? e.message : 'Preview failed';
    }
  });

  // Per-clip kebab menu (Delete clip…). Open/close + outside-click.
  document.addEventListener('click', function(ev){
    var btn = ev.target.closest && ev.target.closest('.clip-kebab-btn');
    if(btn){
      var card = btn.closest('.clip-card');
      if(!card) return;
      ev.stopPropagation();
      var pop = card.querySelector('.clip-kebab-pop');
      if(!pop) return;
      var willOpen = pop.hasAttribute('hidden');
      // Close any other open kebab pops first.
      document.querySelectorAll('.clip-kebab-pop').forEach(function(p){ if(p !== pop) p.hidden = true; });
      pop.hidden = !willOpen;
      btn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
      return;
    }
    // Outside click → close all open kebab pops.
    if(!ev.target.closest('.clip-kebab-pop')){
      document.querySelectorAll('.clip-kebab-pop').forEach(function(p){ p.hidden = true; });
      document.querySelectorAll('.clip-kebab-btn').forEach(function(b){ b.setAttribute('aria-expanded', 'false'); });
    }
  });

  // Per-clip Export as tutorial. Posts the current in-memory plan so
  // edited captions/ranges are included even if debounce-save has not
  // fired yet. The server writes tutorials/<clip-title>-<timestamp>/.
  document.addEventListener('click', async function(ev){
    var btn = ev.target.closest && ev.target.closest('.clip-export-tutorial-btn');
    if(!btn) return;
    var card = btn.closest('.clip-card');
    if(!card) return;
    ev.preventDefault();
    ev.stopPropagation();
    document.querySelectorAll('.clip-kebab-pop').forEach(function(p){ p.hidden = true; });
    document.querySelectorAll('.clip-kebab-btn').forEach(function(b){ b.setAttribute('aria-expanded', 'false'); });
    pauseAllMedia();

    var originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Exporting...';
    setSaveState('saving');
    try {
      var resp = await fetch('api/export-tutorial', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({
          clip_id: card.dataset.id,
          plan: readPlan(),
          open_folder: true
        })
      });
      var data = await resp.json().catch(function(){ return {}; });
      if(!resp.ok) throw new Error(data.error || ('HTTP ' + resp.status));
      flash('tutorial exported' + (data.stepCount ? ' · ' + data.stepCount + ' steps' : ''));
    } catch(e) {
      flash('tutorial export failed: ' + (e && e.message ? e.message : e));
    } finally {
      btn.disabled = false;
      btn.textContent = originalText;
    }
  });

  // Per-clip Delete (in the kebab menu). Confirms before dropping the
  // clip from plan.json. Already-rendered .mp4s on disk are preserved.
  document.addEventListener('click', async function(ev){
    var btn = ev.target.closest && ev.target.closest('.clip-delete-btn');
    if(!btn) return;
    var card = btn.closest('.clip-card');
    if(!card) return;
    var title = card.querySelector('.title-input').value.trim() || ('clip #' + (card.dataset.id || ''));
    if(!confirm('Delete "' + title + '"? Already-rendered files are kept.')) return;
    card.parentNode.removeChild(card);
    renumberClipCards();
    renderTimeline();
    scheduleSave();
  });

  // ─── Render… dialog ───────────────────────────────────────────────
  // Per-clip ▶ Render button opens a modal that lists size variants
  // (TikTok / YouTube Shorts / IG / LinkedIn / YouTube). User
  // toggles 1+, hits Render, the dialog shows a progress line per
  // variant streamed from /api/render-stream NDJSON.
  function pauseAllVideos(){
    document.querySelectorAll('video').forEach(function(v){
      try { v.pause(); } catch(_){}
    });
  }
  function findClipCardById(clipId){
    var cards = document.querySelectorAll('.clip-card');
    for(var i = 0; i < cards.length; i++){
      if(cards[i].dataset.id === clipId) return cards[i];
    }
    return null;
  }
  function persistRenderTitle(clipId, value){
    var card = findClipCardById(clipId);
    if(!card) return;
    var title = String(value || '').trim();
    if(title) card.setAttribute('data-render-title', title);
    else card.removeAttribute('data-render-title');
  }

  var RENDER_VARIANTS = null; // lazy-loaded on first open
  async function loadVariants(){
    if(RENDER_VARIANTS) return RENDER_VARIANTS;
    try {
      var r = await fetch('api/render-variants');
      var d = await r.json();
      RENDER_VARIANTS = d.variants || [];
    } catch(e){ RENDER_VARIANTS = []; }
    return RENDER_VARIANTS;
  }
  function ensureRenderModal(){
    var m = document.getElementById('render-modal');
    if(m) return m;
    m = document.createElement('div');
    m.id = 'render-modal';
    m.className = 'render-modal';
    m.hidden = true;
    m.innerHTML =
      '<div class="rm-overlay"></div>' +
      '<div class="rm-pane" role="dialog" aria-modal="true" aria-labelledby="rm-title">' +
        '<header class="rm-head">' +
          '<h3 id="rm-title">Render clip</h3>' +
          '<button class="iconbtn rm-close" type="button" aria-label="Close">✕</button>' +
        '</header>' +
        '<p class="rm-sub">Pick the sizes to render. Each one becomes its own .mp4.</p>' +
        '<label class="rm-name-row"><span>File name</span><input id="rm-title-input" type="text" autocomplete="off"></label>' +
        '<div class="rm-variants" id="rm-variants"></div>' +
        '<div class="rm-progress" id="rm-progress" hidden></div>' +
        '<footer class="rm-foot">' +
          '<button class="ghost-btn rm-cancel" type="button">Close</button>' +
          '<button class="primary-btn rm-go" type="button" disabled>Render</button>' +
        '</footer>' +
      '</div>';
    document.body.appendChild(m);
    m.querySelector('.rm-close').addEventListener('click', closeRenderModal);
    m.querySelector('.rm-cancel').addEventListener('click', closeRenderModal);
    m.querySelector('.rm-overlay').addEventListener('click', closeRenderModal);
    m.querySelector('#rm-title-input').addEventListener('input', function(ev){
      if(!m.dataset.clipId) return;
      persistRenderTitle(m.dataset.clipId, ev.target.value);
      scheduleSave();
    });
    return m;
  }
  function hasUnsavedRenderRows(m){
    return Array.prototype.some.call(m.querySelectorAll('.rm-prow.done'), function(row){
      return !row.classList.contains('saved');
    });
  }
  function closeRenderModal(evOrForce){
    var force = evOrForce === true;
    if(evOrForce && evOrForce.preventDefault) evOrForce.preventDefault();
    var m = document.getElementById('render-modal');
    if(!m) return;
    if(!force && m.dataset.sessionId && hasUnsavedRenderRows(m)){
      var ok = confirm("Are you sure? You didn't save every rendered clip. Close and discard the unsaved renders?");
      if(!ok) return;
    }
    // Bail-out path: if a render session is alive but never promoted,
    // tell the server to wipe the tmp dir so we don't leak files.
    var sid = m.dataset.sessionId;
    if(sid){
      try {
        fetch('api/discard-renders', {
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ session_id: sid }),
          keepalive: true,
        }).catch(function(){});
      } catch(_){}
      m.dataset.sessionId = '';
    }
    // Stop any inline preview videos so audio doesn't keep playing.
    m.querySelectorAll('video').forEach(function(v){ try { v.pause(); } catch(_){} v.removeAttribute('src'); v.load && v.load(); });
    m.classList.remove('rendering');
    m.hidden = true;
    delete m.dataset.clipId;
  }
  async function openRenderModal(clipId, clipTitle, previewVariant){
    pauseAllVideos();
    var m = ensureRenderModal();
    m.dataset.clipId = clipId;
    m.dataset.sessionId = '';
    m.classList.remove('rendering');
    delete m.dataset.urlBase;
    m.querySelector('#rm-title').textContent = 'Render: ' + (clipTitle || clipId);
    var titleInput = m.querySelector('#rm-title-input');
    var card = findClipCardById(clipId);
    var savedRenderTitle = card ? (card.getAttribute('data-render-title') || '').trim() : '';
    if(titleInput) titleInput.value = savedRenderTitle || clipTitle || clipId;
    var variants = await loadVariants();
    var grid = m.querySelector('#rm-variants');
    grid.hidden = false;
    var selectedAspects = new Set(['9:16']);
    if(previewVariant) selectedAspects.add(previewVariant);
    grid.innerHTML = variants.map(function(v, i){
      var checked = selectedAspects.has(v.aspect_ratio) ? ' checked' : '';
      var label = (v.name || v.aspect_ratio);
      return '<label class="rm-variant">' +
        '<input type="checkbox" value="' + v.aspect_ratio + '"' + checked + '>' +
        '<div class="rm-variant-body">' +
          '<div class="rm-variant-name">' + escHtml(label) + ' <span class="rm-variant-dim">' + v.w + '×' + v.h + '</span></div>' +
          '<div class="rm-variant-for">' + escHtml(v.for) + '</div>' +
        '</div>' +
      '</label>';
    }).join('');
    var prog = m.querySelector('#rm-progress');
    prog.innerHTML = ''; prog.hidden = true;
    var go = m.querySelector('.rm-go');
    go.disabled = false; go.textContent = 'Render';
    var refreshGo = function(){
      var n = grid.querySelectorAll('input[type="checkbox"]:checked').length;
      go.disabled = n === 0 || go.dataset.busy === '1';
      go.textContent = n > 1 ? ('Render ' + n + ' variants') : 'Render';
    };
    grid.querySelectorAll('input[type="checkbox"]').forEach(function(cb){
      cb.addEventListener('change', refreshGo);
    });
    refreshGo();
    go.onclick = function(){ runRenderModal(clipId); };
    m.hidden = false;
  }
  async function runRenderModal(clipId){
    pauseAllVideos();
    var m = document.getElementById('render-modal');
    var grid = m.querySelector('#rm-variants');
    var go = m.querySelector('.rm-go');
    var prog = m.querySelector('#rm-progress');
    var aspects = Array.prototype.slice.call(grid.querySelectorAll('input[type="checkbox"]:checked')).map(function(c){ return c.value; });
    var renderTitleInput = m.querySelector('#rm-title-input');
    var renderTitle = renderTitleInput ? renderTitleInput.value.trim() : '';
    if(aspects.length === 0) return;
    persistRenderTitle(clipId, renderTitle);
    go.dataset.busy = '1'; go.disabled = true; go.textContent = 'Rendering…';
    m.classList.add('rendering');
    grid.hidden = true;
    prog.hidden = false; prog.innerHTML = '';
    grid.querySelectorAll('input[type="checkbox"]').forEach(function(c){ c.disabled = true; });

    // One row per variant; rows update in place as progress events arrive.
    var rowByAspect = {};
    aspects.forEach(function(ar){
      var v = (RENDER_VARIANTS || []).find(function(x){ return x.aspect_ratio === ar; });
      var nm = v ? (v.name + '[' + v.w + 'x' + v.h + ']') : ar;
      var row = document.createElement('div');
      row.className = 'rm-prow';
      row.innerHTML =
        '<div class="rm-prow-head">' +
          '<label class="rm-prow-keep" title="Keep this render when saving"><input type="checkbox" class="rm-keep-cb" disabled checked><span></span></label>' +
          '<span class="rm-prow-name">' + escHtml(nm) + '</span>' +
          '<span class="rm-prow-status">queued</span>' +
          '<button class="rm-keep-one" type="button" disabled>Keep</button>' +
        '</div>' +
        '<div class="rm-prow-bar"><div class="rm-prow-fill"></div></div>' +
        '<div class="rm-prow-preview" hidden></div>';
      prog.appendChild(row);
      rowByAspect[ar] = row;
    });

    // Save the plan once before kicking off — renderer reads from disk.
    await doSave(true);

    // Per-session state held on the modal element so the footer button
    // and the close handler can read it back.
    m.dataset.sessionId = '';
    m.dataset.kept = '';

    function markRenderRowSaved(row){
      row.classList.add('saved');
      var statusEl = row.querySelector('.rm-prow-status');
      if(statusEl) statusEl.textContent = 'saved in Rendered';
      var cb = row.querySelector('.rm-keep-cb');
      if(cb){ cb.checked = false; cb.disabled = true; }
      var keepOne = row.querySelector('.rm-keep-one');
      if(keepOne){ keepOne.disabled = true; keepOne.textContent = 'Saved'; }
    }
    var refreshKeptCount = function(){
      var cbs = prog.querySelectorAll('.rm-keep-cb');
      var checked = 0;
      cbs.forEach(function(cb){ if(!cb.disabled && cb.checked) checked++; });
      m.dataset.kept = String(checked);
      var unsaved = hasUnsavedRenderRows(m);
      go.textContent = checked > 0
        ? ('Keep ' + checked + (checked === 1 ? ' selected' : ' selected'))
        : (unsaved ? 'Discard' : 'Close');
    };
    async function keepOneRender(row){
      var btn = row.querySelector('.rm-keep-one');
      var cb = row.querySelector('.rm-keep-cb');
      var filename = (btn && btn.dataset.filename) || (cb && cb.dataset.filename) || '';
      var sessionId = m.dataset.sessionId || '';
      if(!filename || !sessionId) return;
      btn.disabled = true;
      btn.textContent = 'Keeping…';
      var statusEl = row.querySelector('.rm-prow-status');
      var prevStatus = statusEl ? statusEl.textContent : '';
      if(statusEl) statusEl.textContent = 'saving to Rendered…';
      try {
        var resp = await fetch('api/promote-renders', {
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ session_id: sessionId, files: [filename], keep_session: true }),
        });
        var data = await resp.json().catch(function(){ return {}; });
        if(!resp.ok) throw new Error(data.error || ('HTTP ' + resp.status));
        if(typeof data.promoted === 'number' && data.promoted !== 1) throw new Error('Saved ' + data.promoted + ' of 1 render');
        markRenderRowSaved(row);
        await loadRenders();
        refreshKeptCount();
      } catch(e){
        btn.disabled = false;
        btn.textContent = 'Keep';
        if(statusEl) statusEl.textContent = 'keep failed: ' + (e.message || prevStatus || 'unknown error');
      }
    }

    try {
      var r = await fetch('api/render-stream', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ clip_id: clipId, aspects: aspects, render_title: renderTitle }),
      });
      if(!r.ok || !r.body) throw new Error('start failed: ' + r.status);
      var reader = r.body.getReader();
      var dec = new TextDecoder('utf-8');
      var buf = '';
      while(true){
        var read = await reader.read();
        if(read.done) break;
        buf += dec.decode(read.value, { stream: true });
        var lines = buf.split('\\n');
        buf = lines.pop() || '';
        for (var i = 0; i < lines.length; i++){
          var line = lines[i].trim();
          if(!line) continue;
          var ev; try { ev = JSON.parse(line); } catch(_){ continue; }
          if(ev.type === 'session'){
            m.dataset.sessionId = ev.session_id || '';
            m.dataset.urlBase = ev.url_base || '';
            continue;
          }
          var row = rowByAspect[ev.aspect_ratio];
          if(ev.type === 'variant-start' && row){
            row.querySelector('.rm-prow-status').textContent = 'rendering… 0%';
          } else if(ev.type === 'variant-progress' && row){
            row.querySelector('.rm-prow-status').textContent = 'rendering… ' + ev.percent + '%';
            row.querySelector('.rm-prow-fill').style.width = ev.percent + '%';
          } else if(ev.type === 'variant-done' && row){
            row.classList.add('done');
            row.querySelector('.rm-prow-status').textContent = '✓ done in ' + (ev.elapsed_ms/1000).toFixed(1) + 's';
            row.querySelector('.rm-prow-fill').style.width = '100%';
            // Inline preview — checkbox enables, default checked.
            var cb = row.querySelector('.rm-keep-cb');
            cb.disabled = false; cb.dataset.filename = ev.filename || '';
            cb.addEventListener('change', refreshKeptCount);
            var keepOne = row.querySelector('.rm-keep-one');
            if(keepOne){
              keepOne.disabled = false;
              keepOne.dataset.filename = ev.filename || '';
              keepOne.addEventListener('click', keepOneRender.bind(null, row));
            }
            var pv = row.querySelector('.rm-prow-preview');
            if(pv && ev.url){
              pv.hidden = false;
              var renderUrl = escHtml(ev.url || '');
              pv.innerHTML = '<video controls preload="metadata" src="' + renderUrl + '"></video>' +
                '<a class="rm-prow-download" href="' + renderUrl + '" download="' + escHtml(ev.filename || 'render.mp4') + '">Download video</a>';
            }
          } else if(ev.type === 'variant-error' && row){
            row.classList.add('error');
            row.querySelector('.rm-prow-status').textContent = '✕ ' + ev.message;
            // Disable + uncheck — nothing to keep here.
            var cbe = row.querySelector('.rm-keep-cb');
            if(cbe){ cbe.disabled = true; cbe.checked = false; }
            var keepErr = row.querySelector('.rm-keep-one');
            if(keepErr) keepErr.disabled = true;
          }
        }
      }
      // All variants settled. Switch the footer over to "Save / Discard".
      refreshKeptCount();
      go.dataset.busy = '';
      go.disabled = false;
      go.onclick = function(){ promoteRenderModal(); };
    } catch(e){
      go.textContent = '✕ ' + e.message;
      go.dataset.busy = '';
      grid.hidden = false;
    }
  }

  // Walk every keep-checkbox, send the checked filenames to the
  // server, and close the dialog when the response lands.
  async function promoteRenderModal(){
    var m = document.getElementById('render-modal');
    if(!m) return;
    var sessionId = m.dataset.sessionId;
    if(!sessionId){ closeRenderModal(true); return; }
    var go = m.querySelector('.rm-go');
    go.disabled = true;
    var prevText = go.textContent;
    go.textContent = 'Saving…';
    var keep = [];
    m.querySelectorAll('.rm-keep-cb').forEach(function(cb){
      if(!cb.disabled && cb.checked && cb.dataset.filename){ keep.push(cb.dataset.filename); }
    });
    try {
      var resp = await fetch('api/promote-renders', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ session_id: sessionId, files: keep }),
      });
      var data = await resp.json().catch(function(){ return {}; });
      if(!resp.ok){
        throw new Error(data.error || ('HTTP ' + resp.status));
      }
      if(keep.length > 0 && typeof data.promoted === 'number' && data.promoted !== keep.length){
        throw new Error('Saved ' + data.promoted + ' of ' + keep.length + ' selected renders');
      }
      m.dataset.sessionId = '';
      await loadRenders();
      closeRenderModal(true);
    } catch(e){
      go.textContent = '✕ ' + (e.message || prevText);
      go.disabled = false;
    }
  }
  document.addEventListener('keydown', function(ev){
    if(ev.key === 'Escape'){
      var m = document.getElementById('render-modal');
      if(m && !m.hidden) closeRenderModal();
    }
  });
  document.addEventListener('click', async function(ev){
    var btn = ev.target.closest && ev.target.closest('.clip-render-btn');
    if(!btn) return;
    var card = btn.closest('.clip-card');
    if(!card) return;
    ev.preventDefault();
    pauseAllVideos();
    var clipId = card.dataset.id;
    var title = (card.querySelector('.title-input') && card.querySelector('.title-input').value) || clipId;
    var previewSelect = card.querySelector('.clip-preview-aspect');
    var previewVariant = previewSelect ? previewSelect.value : '';
    openRenderModal(clipId, title, previewVariant);
  });

  // ─── Past renders: fetch + populate per-clip "Previously rendered" ─
  function timeAgoLabel(value){
    var ms = typeof value === 'number' ? value : Date.parse(value || '');
    if(!Number.isFinite(ms)) return '';
    var diff = Date.now() - ms;
    if(diff < 0) diff = 0;
    var sec = Math.floor(diff / 1000);
    if(sec < 45) return 'just now';
    var min = Math.floor(sec / 60);
    if(min < 60) return min + 'm ago';
    var hr = Math.floor(min / 60);
    if(hr < 24) return hr + 'h ago';
    var day = Math.floor(hr / 24);
    if(day < 30) return day + 'd ago';
    var mo = Math.floor(day / 30);
    if(mo < 12) return mo + 'mo ago';
    return Math.floor(day / 365) + 'y ago';
  }
  function renderCreatedLabel(rec){
    return timeAgoLabel(rec.created_ms || rec.rendered_at) || rec.stamp || '';
  }
  function renderCreatedTitle(rec){
    var ms = rec.created_ms || Date.parse(rec.rendered_at || '');
    if(Number.isFinite(ms) && ms > 0) return new Date(ms).toLocaleString();
    return rec.stamp || '';
  }
  function renderCardActionsHtml(rec){
    return '<span class="render-actions">' +
      '<a class="render-dl" href="' + rec.url + '" download="' + rec.file + '">download</a>' +
      '<button class="render-kebab-btn" type="button" aria-label="Render actions" aria-haspopup="menu" aria-expanded="false">⋮</button>' +
      '<div class="render-kebab-pop" hidden role="menu">' +
        '<button class="render-delete-btn" type="button" role="menuitem">Delete render...</button>' +
      '</div>' +
    '</span>';
  }
  async function loadRenders(){
    try {
      var r = await fetch('api/renders');
      var d = await r.json();
      // Group by slug
      var bySlug = {};
      (d.renders || []).forEach(function(rec){
        bySlug[rec.slug] = bySlug[rec.slug] || [];
        bySlug[rec.slug].push(rec);
      });
      document.querySelectorAll('.renders').forEach(function(host){
        var slug = host.dataset.slug;
        var list = bySlug[slug] || [];
        // Update the per-card "Rendered (N)" count badge.
        var card = host.closest('.clip-card');
        if(card){
          var badge = card.querySelector('[data-rendered-count]');
          if(badge) badge.textContent = String(list.length);
          if(card.classList.contains('collapsed')) refreshClipSummary(card);
        }
        if(list.length === 0){
          host.innerHTML = emptyRendersHtml('none yet — click "▶ Render…" above to render this clip');
          return;
        }
        host.innerHTML = list.slice(0, 24).map(function(rec){
          return '<div class="render-card" data-render-dir="' + escHtml(rec.dir) + '" data-render-file="' + escHtml(rec.file) + '">' +
            '<video controls preload="none" poster="' + (rec.posterUrl || '') + '" src="' + rec.url + '"></video>' +
            '<div class="render-meta"><span class="render-stamp" title="' + escHtml(renderCreatedTitle(rec)) + '">' + escHtml(renderCreatedLabel(rec)) + '</span>' +
            renderCardActionsHtml(rec) + '</div>' +
            '</div>';
        }).join('');
      });

      // Video-level "Rendered" panel (right of the source video).
      // Two independent filters: by clip (slug) + by output size
      // (format_label, e.g. "instagram[1080x1350]"). Selections are
      // remembered in window._vrFilter / window._vrFilterFormat so
      // re-renders preserve the user's view.
      var vrList = document.getElementById('video-renders-list');
      var vrCount = document.getElementById('video-renders-count');
      var vrFilter = document.getElementById('video-renders-filter');
      if(vrList && vrCount){
        var renders = d.renders || [];
        var total = renders.length;
        vrCount.textContent = String(total);
        vrCount.classList.toggle('has', total > 0);
        if(total === 0){
          vrList.innerHTML = emptyRendersHtml('none yet — click "▶ Render…" on any clip below');
          if(vrFilter){ vrFilter.hidden = true; vrFilter.innerHTML = ''; }
        } else {
          // Tally renders per slug and per format_label.
          var byFormat = {};
          renders.forEach(function(rec){
            var fl = rec.format_label || '';
            if(!fl) return;
            byFormat[fl] = (byFormat[fl] || 0) + 1;
          });
          var slugs = Object.keys(bySlug).sort();
          var formats = Object.keys(byFormat).sort();

          // Reconcile current selections with what's still present.
          var pickedSlug = window._vrFilter || '';
          if(pickedSlug && slugs.indexOf(pickedSlug) < 0) pickedSlug = '';
          var pickedFmt = window._vrFilterFormat || '';
          if(pickedFmt && formats.indexOf(pickedFmt) < 0) pickedFmt = '';
          window._vrFilter = pickedSlug;
          window._vrFilterFormat = pickedFmt;

          if(vrFilter){
            var bits = [];
            if(slugs.length >= 2){
              var clipOpts = '<option value=""' + (pickedSlug===''?' selected':'') + '>All clips · ' + total + '</option>';
              clipOpts += slugs.map(function(slug){
                return '<option value="' + escHtml(slug) + '"' + (pickedSlug===slug?' selected':'') + '>' + escHtml(slug) + ' · ' + bySlug[slug].length + '</option>';
              }).join('');
              bits.push('<label class="vr-filter-label">Clip <select class="vr-filter-select" id="vr-filter-select">' + clipOpts + '</select></label>');
            }
            if(formats.length >= 2){
              var fmtOpts = '<option value=""' + (pickedFmt===''?' selected':'') + '>All sizes</option>';
              fmtOpts += formats.map(function(fl){
                return '<option value="' + escHtml(fl) + '"' + (pickedFmt===fl?' selected':'') + '>' + escHtml(fl) + ' · ' + byFormat[fl] + '</option>';
              }).join('');
              bits.push('<label class="vr-filter-label">Size <select class="vr-filter-select" id="vr-filter-size-select">' + fmtOpts + '</select></label>');
            }
            if(bits.length > 0){
              vrFilter.hidden = false;
              vrFilter.innerHTML = bits.join('');
            } else {
              vrFilter.hidden = true; vrFilter.innerHTML = '';
            }
          }

          // Apply both filters: filter bySlug rows by format_label
          // before rendering. Drop slugs that end up empty so we don't
          // emit an empty group header.
          var matchFmt = function(rec){ return !pickedFmt || rec.format_label === pickedFmt; };
          var visibleSlugs = pickedSlug ? [pickedSlug] : slugs;
          var groups = visibleSlugs.map(function(slug){
            return { slug: slug, recs: (bySlug[slug] || []).filter(matchFmt) };
          }).filter(function(g){ return g.recs.length > 0; });

          if(groups.length === 0){
            vrList.innerHTML = emptyRendersHtml('no renders match the current filter');
          } else {
            vrList.innerHTML = groups.map(function(g){
              var cards = g.recs.slice(0, 24).map(function(rec){
                return '<div class="vr-card" data-render-dir="' + escHtml(rec.dir) + '" data-render-file="' + escHtml(rec.file) + '">' +
                  '<video controls preload="none" poster="' + (rec.posterUrl || '') + '" src="' + rec.url + '"></video>' +
                  '<div class="vr-meta"><span class="vr-stamp" title="' + escHtml(renderCreatedTitle(rec)) + '">' + escHtml(renderCreatedLabel(rec)) + '</span>' +
                  renderCardActionsHtml(rec) + '</div>' +
                  '</div>';
              }).join('');
              return '<div class="vr-group">' +
                '<h4 class="vr-group-h">' + escHtml(g.slug) + ' (' + g.recs.length + ')</h4>' +
                '<div class="vr-grid">' + cards + '</div>' +
                '</div>';
            }).join('');
          }
        }
      }
    } catch(e) { /* network not ready or server lacks endpoint — ignore */ }
  }
  loadRenders();

  document.addEventListener('click', async function(ev){
    var renderMenuBtn = ev.target.closest && ev.target.closest('.render-kebab-btn');
    if(renderMenuBtn){
      ev.preventDefault();
      ev.stopPropagation();
      var pop = renderMenuBtn.parentElement && renderMenuBtn.parentElement.querySelector('.render-kebab-pop');
      var willOpen = pop && pop.hasAttribute('hidden');
      document.querySelectorAll('.render-kebab-pop').forEach(function(p){ p.hidden = true; });
      document.querySelectorAll('.render-kebab-btn').forEach(function(b){ b.setAttribute('aria-expanded', 'false'); });
      if(pop){
        pop.hidden = !willOpen;
        renderMenuBtn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
      }
      return;
    }

    var deleteBtn = ev.target.closest && ev.target.closest('.render-delete-btn');
    if(deleteBtn){
      ev.preventDefault();
      ev.stopPropagation();
      var card = deleteBtn.closest('.render-card,.vr-card');
      if(!card) return;
      var dir = card.dataset.renderDir || '';
      var file = card.dataset.renderFile || '';
      if(!dir || !file) return;
      if(!confirm('Delete rendered clip "' + file + '"? This removes the .mp4 file.')) return;
      pauseAllMedia();
      deleteBtn.disabled = true;
      try {
        var resp = await fetch('api/delete-render', {
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ dir: dir, file: file }),
        });
        var data = await resp.json().catch(function(){ return {}; });
        if(!resp.ok) throw new Error(data.error || ('HTTP ' + resp.status));
        await loadRenders();
        flash('render deleted');
      } catch(e) {
        flash('delete failed: ' + (e && e.message ? e.message : e));
        deleteBtn.disabled = false;
      }
      return;
    }

    if(!ev.target.closest || !ev.target.closest('.render-kebab-pop')){
      document.querySelectorAll('.render-kebab-pop').forEach(function(p){ p.hidden = true; });
      document.querySelectorAll('.render-kebab-btn').forEach(function(b){ b.setAttribute('aria-expanded', 'false'); });
    }
  });

  // ─── Rendered: expand-to-full-width + filter dropdown changes ────
  (function(){
    var btn = document.getElementById('video-renders-expand');
    if(btn){
      btn.addEventListener('click', function(){
        var on = !document.body.classList.contains('vr-expanded');
        document.body.classList.toggle('vr-expanded', on);
        btn.setAttribute('aria-label', on ? 'Collapse to right column' : 'Expand to full width');
        var ex = btn.querySelector('.vr-ic-expand');
        var co = btn.querySelector('.vr-ic-collapse');
        if(ex && co){ ex.hidden = on; co.hidden = !on; }
      });
    }
    var filter = document.getElementById('video-renders-filter');
    if(filter){
      filter.addEventListener('change', function(ev){
        var t = ev.target;
        if(!t || !t.matches) return;
        if(t.id === 'vr-filter-select'){
          window._vrFilter = t.value || '';
          loadRenders();
        } else if(t.id === 'vr-filter-size-select'){
          window._vrFilterFormat = t.value || '';
          loadRenders();
        }
      });
    }
  })();

  // Initial preview render
  preview.textContent = JSON.stringify(readPlan(), null, 2);
})();
`;
