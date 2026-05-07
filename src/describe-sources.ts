import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { runProc } from "./run.js";
import { config } from "./config.js";
import { getOrTranscribeWords } from "./transcript-cache.js";
import { getFfmpegPath, getFfprobePath } from "./ffmpeg.js";
import { proofreadCaptions } from "./caption-proofread.js";
import { aiCliAvailable, firstAvailableAiCliToolLabel, getCliProvider, type LLMProvider } from "./llm/index.js";
import { probeAudioUsability } from "./media-audio.js";
import {
  cleanupTranscriptText,
  firstWordsFromTranscript,
  joinRawTranscriptWords,
} from "./transcript-text.js";
import {
  loadProjectV2,
  sourceDescriptionPath,
  sourceThumbsDir,
  type SourceFile,
  type SourceDescription,
  type NormalizedVisualRegion,
  type VisualMomentMetadata,
} from "./project-v2.js";
import { detectLocalFacesInThumbnails } from "./local-face-detection.js";

// Describe-all orchestrator. Yields progress events that the hub
// streams to the page. Audio files first (they're tiny, fast) so the
// video describe step has a complete table for matching downstream.

export type DescribeEvent =
  | { type: "start"; total: number }
  | { type: "file-start"; index: number; kind: "audio" | "video"; filename: string; stage: string }
  | { type: "file-progress"; index: number; filename: string; stage: string; progress?: number }
  | { type: "file-done"; index: number; filename: string; title?: string }
  | { type: "file-skip"; index: number; filename: string; reason: string }
  | { type: "done"; describedAudios: number; describedVideos: number }
  | { type: "error"; message: string };

export type DescribeOptions = {
  visualContext?: string;
  force?: boolean;
  llmProvider?: LLMProvider;
  llmLabel?: string;
  onlySourceSlug?: string;
  aiSceneAnalysis?: boolean;
};

export async function* describeAllSources(
  projectRoot: string,
  opts: DescribeOptions = {},
): AsyncGenerator<DescribeEvent> {
  const aiSceneAnalysis = opts.aiSceneAnalysis === true;
  const project = await loadProjectV2(projectRoot);
  if (!project) {
    yield { type: "error", message: "not a v2 project (no .aicw-meta.json with version: 2)" };
    return;
  }
  const selectedAudios = opts.onlySourceSlug
    ? []
    : project.sourceAudios;
  const selectedVideos = opts.onlySourceSlug
    ? project.sourceVideos.filter((v) => v.slug === opts.onlySourceSlug || v.originalName === opts.onlySourceSlug)
    : project.sourceVideos;
  const all: SourceFile[] = [...selectedAudios, ...selectedVideos];
  yield { type: "start", total: all.length };
  if (opts.onlySourceSlug && all.length === 0) {
    yield { type: "error", message: `source not found: ${opts.onlySourceSlug}` };
    return;
  }

  let describedAudios = 0;
  let describedVideos = 0;

  // Audio first (faster, gives a lookup table).
  for (let i = 0; i < selectedAudios.length; i++) {
    const file = selectedAudios[i]!;
    const idx = i;
    const sidecarPath = sourceDescriptionPath(file.sourcePath);
    if (existsSync(sidecarPath) && !opts.force) {
      yield { type: "file-skip", index: idx, filename: file.originalName, reason: "already described" };
      describedAudios++;
      continue;
    }
    yield { type: "file-start", index: idx, kind: "audio", filename: file.originalName, stage: "transcribing" };
    try {
      const words = await getOrTranscribeWords(file.sourcePath);
      const rawFullText = joinRawTranscriptWords(words);
      const fullText = cleanupTranscriptText(rawFullText);
      const desc: SourceDescription = {
        kind: "audio",
        filename: file.originalName,
        title: titleFromText(fullText),
        durationMs: words.length > 0 ? words[words.length - 1]!.endMs : undefined,
        transcript: { fullText, originalText: rawFullText, words },
        describedAt: new Date().toISOString(),
      };
      await writeFile(sidecarPath, JSON.stringify(desc, null, 2));
      describedAudios++;
      yield { type: "file-done", index: idx, filename: file.originalName, title: desc.title };
    } catch (e) {
      yield { type: "error", message: `audio "${file.originalName}": ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  // Then videos. Each video gets transcript + thumbnails + (claude
  // summary, if available). We import describer + analyzer lazily to
  // avoid pulling them into builds that don't need them.
  const audioOffset = selectedAudios.length;
  for (let i = 0; i < selectedVideos.length; i++) {
    const file = selectedVideos[i]!;
    const idx = audioOffset + i;
    const sidecarPath = sourceDescriptionPath(file.sourcePath);
    if (existsSync(sidecarPath) && !opts.force) {
      yield { type: "file-skip", index: idx, filename: file.originalName, reason: "already described" };
      describedVideos++;
      continue;
    }
    yield { type: "file-start", index: idx, kind: "video", filename: file.originalName, stage: "checking audio" };
    let words: { startMs: number; endMs: number; text: string }[] = [];
    let visualOnly = false;
    try {
      const audio = await probeAudioUsability(file.sourcePath);
      visualOnly = !audio.hasUsableAudio;
      if (visualOnly) {
        yield {
          type: "file-progress",
          index: idx,
          filename: file.originalName,
          stage: audio.reason === "no_audio_stream" ? "no audio track detected" : "audio track is silent",
        };
      } else {
        yield { type: "file-progress", index: idx, filename: file.originalName, stage: "transcribing" };
        words = await getOrTranscribeWords(file.sourcePath, { skipAudioProbe: true });
        if (words.length === 0) visualOnly = true;
      }
    } catch (e) {
      yield {
        type: "error",
        message: `video "${file.originalName}" transcription failed: ${e instanceof Error ? e.message : String(e)}`,
      };
      visualOnly = true;
    }

    const durationMs = await samplingDurationMs(file.sourcePath, words);
    const initialIntervalMs = words.length > 0
      ? config.visualSampleWithAudioIntervalMs
      : config.visualSampleWithoutAudioIntervalMs;
    yield {
      type: "file-progress",
      index: idx,
      filename: file.originalName,
      stage: words.length > 0
        ? `sampling transcript/video frames every ${fmtSeconds(initialIntervalMs)}`
        : `sampling visual frames every ${fmtSeconds(initialIntervalMs)}`,
    };
    const sampleTimesMs = sampleTimestamps(durationMs, initialIntervalMs);
    let moments = sampleMomentsAtTimes(words, durationMs, sampleTimesMs);
    const thumbsDir = sourceThumbsDir(file);
    await mkdir(thumbsDir, { recursive: true });
    const extractedThumbs = await extractThumbnailsForMoments(file, moments, thumbsDir);
    const thumbnails = thumbnailRefs(file, moments, extractedThumbs);
    if (extractedThumbs.length > 0) {
      yield {
        type: "file-progress",
        index: idx,
        filename: file.originalName,
        stage: `detecting faces locally in ${extractedThumbs.length} sampled frames`,
      };
      try {
        const localVisual = await detectLocalFacesInThumbnails(extractedThumbs);
        applyVisualMetadataToMoments(moments, localVisual);
      } catch {
        yield {
          type: "file-progress",
          index: idx,
          filename: file.originalName,
          stage: "local face detection unavailable; continuing without local face boxes",
        };
      }
    }
    let visualSummary = "";
    if (visualOnly) {
      yield {
        type: "file-progress",
        index: idx,
        filename: file.originalName,
        stage: aiSceneAnalysis && llmAvailable(opts, { requiresImages: true })
          ? `Calling ${llmLabel(opts, { requiresImages: true })} to describe ${extractedThumbs.length} sampled frames`
          : "AI scene analysis is off; using local face detection and saved context only",
      };
      let visual: VisualDescribeResult = { summary: "", moments: [] };
      if (aiSceneAnalysis) {
        for await (const ev of describeVisualMoments({
          fileName: file.originalName,
          context: opts.visualContext ?? "",
          captionLanguage: config.caption_language,
          thumbs: extractedThumbs,
          llmProvider: opts.llmProvider,
          llmLabel: opts.llmLabel,
        })) {
          if (ev.type === "progress") {
            yield { type: "file-progress", index: idx, filename: file.originalName, stage: ev.stage, progress: ev.progress };
          } else {
            visual = ev.result;
          }
        }
      }
      visualSummary = visual.summary;
      const byTs = new Map(visual.moments.map((m) => [m.ts_ms, m]));
      const fallbackVisualCaption = compactVisualCaption(visualSummary || opts.visualContext || "");
      for (const m of moments) {
        const describedMoment = byTs.get(m.ts_ms);
        let described = describedMoment
          ? describedMoment.text
          : fillMissingVisualCaption(m.ts_ms, visual.moments, fallbackVisualCaption);
        if (describedMoment?.is_key_moment === false) described = "";
        if (!described && !describedMoment && fallbackVisualCaption && m.ts_ms <= 8000) described = fallbackVisualCaption;
        m.original_text = compactVisualCaption(described);
        m.text = m.original_text;
        m.is_key_moment = describedMoment?.is_key_moment ?? Boolean(m.text);
      }
      applyVisualMetadataToMoments(moments, visual.moments);
    } else if (moments.length > 0) {
      if (aiSceneAnalysis && llmAvailable(opts, { requiresImages: true }) && extractedThumbs.length > 0) {
        yield {
          type: "file-progress",
          index: idx,
          filename: file.originalName,
          stage: `Calling ${llmLabel(opts, { requiresImages: true })} to analyze ${extractedThumbs.length} sampled frames for crop, faces, and privacy`,
        };
        let visual: VisualDescribeResult = { summary: "", moments: [] };
        for await (const ev of describeVisualMoments({
          fileName: file.originalName,
          context: opts.visualContext ?? titleFromText(cleanupTranscriptText(joinRawTranscriptWords(words))),
          captionLanguage: config.caption_language,
          thumbs: extractedThumbs,
          llmProvider: opts.llmProvider,
          llmLabel: opts.llmLabel,
        })) {
          if (ev.type === "progress") {
            yield { type: "file-progress", index: idx, filename: file.originalName, stage: ev.stage, progress: ev.progress };
          } else {
            visual = ev.result;
          }
        }
        if (visual.summary) visualSummary = visual.summary;
        applyVisualMetadataToMoments(moments, visual.moments);
      } else if (!aiSceneAnalysis) {
        yield {
          type: "file-progress",
          index: idx,
          filename: file.originalName,
          stage: "AI scene analysis is off; skipping visual descriptions and keyframe labels",
        };
      }
      yield {
        type: "file-progress",
        index: idx,
        filename: file.originalName,
        stage: aiSceneAnalysis && llmAvailable(opts)
          ? `Calling ${llmLabel(opts)} to proofread transcript captions`
          : "Cleaning transcript captions locally",
      };
      const proofread = await proofreadCaptions(
        moments.map((m) => m.original_text ?? ""),
        { captionLanguage: config.caption_language, llmProvider: opts.llmProvider, useAi: aiSceneAnalysis },
      );
      for (let j = 0; j < moments.length; j++) {
        moments[j]!.text = proofread[j] || cleanupTranscriptText(moments[j]!.original_text ?? "");
      }
    }

    const rawFullText = joinRawTranscriptWords(words);
    const fullText = cleanupTranscriptText(rawFullText);
    const titleText = fullText || visualSummary || opts.visualContext || path.basename(file.originalName, path.extname(file.originalName));
    const desc: SourceDescription = {
      kind: "video",
      filename: file.originalName,
      title: titleFromText(titleText),
      durationMs: words.length > 0 ? words[words.length - 1]!.endMs : await probeDurationMs(file.sourcePath),
      transcript: { fullText, originalText: rawFullText, words },
      visualContext: visualOnly ? (opts.visualContext?.trim() || undefined) : undefined,
      summary: visualSummary || undefined,
      thumbnails,
      moments: moments.map((m) => ({
        ts_ms: m.ts_ms,
        thumbnail: `${file.slug}/thumbs/${m.ts_ms}.jpg`,
        text: m.text,
        original_text: m.original_text,
        is_key_moment: m.is_key_moment,
        visual_metadata: m.visual_metadata,
      })),
      describedAt: new Date().toISOString(),
    };
    await writeFile(sidecarPath, JSON.stringify(desc, null, 2));
    describedVideos++;
    yield { type: "file-done", index: idx, filename: file.originalName, title: desc.title };
  }

  yield { type: "done", describedAudios, describedVideos };
}

// ─── helpers ──────────────────────────────────────────────────────────

function titleFromText(text: string): string {
  return firstWordsFromTranscript(text, 5);
}

function llmAvailable(opts: DescribeOptions, mode: { requiresImages?: boolean } = {}): boolean {
  return Boolean(opts.llmProvider) || aiCliAvailable(mode);
}

function llmLabel(opts: DescribeOptions, mode: { requiresImages?: boolean } = {}): string {
  if (opts.llmLabel) return opts.llmLabel;
  if (opts.llmProvider) return opts.llmProvider.name;
  return firstAvailableAiCliToolLabel(mode);
}

const VisualDescribeResponseSchema = z.object({
  summary: z.string().default(""),
  moments: z.array(z.object({
    timestamp_ms: z.number().int().nonnegative(),
    is_key_moment: z.boolean().default(false),
    text: z.string().default(""),
    visual_metadata: z.object({
      main_focus: z.unknown().optional(),
      faces: z.unknown().optional(),
      text_regions: z.unknown().optional(),
      crop_regions: z.unknown().optional(),
      privacy_risks: z.unknown().optional(),
      safe_caption_zones: z.unknown().optional(),
    }).optional(),
  })).default([]),
});

type VisualMomentDescription = {
  ts_ms: number;
  is_key_moment: boolean;
  text: string;
  visual_metadata?: VisualMomentMetadata;
};

type VisualDescribeResult = {
  summary: string;
  moments: VisualMomentDescription[];
};

type VisualDescribeEvent =
  | { type: "progress"; stage: string; progress?: number }
  | { type: "done"; result: VisualDescribeResult };

async function* describeVisualMoments(args: {
  fileName: string;
  context: string;
  captionLanguage: string;
  thumbs: Array<{ ts_ms: number; path: string }>;
  llmProvider?: LLMProvider;
  llmLabel?: string;
}): AsyncGenerator<VisualDescribeEvent> {
  const fallbackSummary = cleanupTranscriptText(args.context) || `Silent video: ${args.fileName}`;
  const provider = args.llmProvider ?? (aiCliAvailable({ requiresImages: true }) ? getCliProvider({ requiresImages: true }) : null);
  const providerLabel = args.llmLabel ?? provider?.name ?? firstAvailableAiCliToolLabel({ requiresImages: true });
  if (!provider || args.thumbs.length === 0) {
    yield { type: "done", result: { summary: fallbackSummary, moments: [] } };
    return;
  }
  const batches = chunkArray(args.thumbs, config.visualAiMaxFramesPerCall);
  const allMoments: VisualMomentDescription[] = [];
  const totalFrames = args.thumbs.length;
  let summary = "";
  try {
    let processedFrames = 0;
    for (const picked of batches) {
      const images = [];
      const startFrame = processedFrames + 1;
      const endFrame = processedFrames + picked.length;
      for (let i = 0; i < picked.length; i++) {
        const thumb = picked[i]!;
        yield {
          type: "progress",
          stage: `visual frame ${processedFrames + i + 1}/${totalFrames} at ${fmtSeconds(thumb.ts_ms)} queued`,
          progress: (processedFrames + i) / totalFrames,
        };
        const data = (await readFile(thumb.path)).toString("base64");
        images.push({ data, mimeType: "image/jpeg" });
      }
      const timestamps = picked.map((t) => t.ts_ms);
      yield {
        type: "progress",
        stage: `analyzing visual frames ${startFrame}-${endFrame}/${totalFrames} with ${providerLabel}`,
        progress: processedFrames / totalFrames,
      };
      const { parsed } = await provider.sampleJson<unknown>({
        prompt: buildVisualPrompt(args.fileName, args.context, timestamps, args.captionLanguage),
        images,
        systemPrompt:
          `You infer video intervals, key moments, and visual regions from sampled frames. Write captions in ${args.captionLanguage}. Return JSON only.`,
        maxTokens: 4200,
      });
      const validated = VisualDescribeResponseSchema.parse(parsed);
      if (validated.summary && !summary) summary = validated.summary;
      for (const m of validated.moments) {
        allMoments.push({
          ts_ms: nearestTimestamp(m.timestamp_ms, timestamps),
          is_key_moment: m.is_key_moment,
          text: compactVisualCaption(m.text),
          visual_metadata: normalizeVisualMetadata(m.visual_metadata),
        });
      }
      processedFrames += picked.length;
      yield {
        type: "progress",
        stage: `analyzed visual frames ${startFrame}-${endFrame}/${totalFrames}`,
        progress: processedFrames / totalFrames,
      };
    }
    yield {
      type: "done",
      result: {
        summary: cleanupTranscriptText(summary || fallbackSummary),
        moments: allMoments.sort((a, b) => a.ts_ms - b.ts_ms),
      },
    };
  } catch (e) {
    yield {
      type: "progress",
      stage: `visual frame analysis failed; using fallback captions (${e instanceof Error ? e.message : String(e)})`,
    };
    yield { type: "done", result: { summary: fallbackSummary, moments: [] } };
  }
}

function buildVisualPrompt(fileName: string, context: string, timestampsMs: number[], captionLanguage: string): string {
  return [
    `Analyze frames from a video file: ${fileName}.`,
    `Frame timestamps in milliseconds, in order: ${timestampsMs.join(", ")}.`,
    `Caption language: ${captionLanguage}.`,
    context.trim()
      ? `User-provided context for the whole video: ${context.trim()}`
      : "No user context was provided. Infer only from visible UI and on-screen content.",
    "",
    "Each frame is a fixed time interval sample. Decide whether it is a key moment worth captioning.",
    "Write moment text as short captions for a rendered short video overlay only when is_key_moment is true.",
    `Every non-empty moment text must be written in ${captionLanguage}.`,
    "Do not describe the image as an image. Describe what is happening in the video at that moment.",
    "Also return visual metadata that can be used later for crop suggestions, face/privacy tools, and caption placement.",
    "Every moment object must include visual_metadata, even when is_key_moment is false or text is empty.",
    "For non-key moments, keep text empty but still return visual_metadata with faces, privacy risks, crop regions, and safe caption zones.",
    "Face/head detection is required privacy metadata. If any human face or head is visible, return a best-effort faces box around it so it can be blurred or covered later.",
    "Do not leave faces empty when people are visible, including small background people, side profiles, backs of heads, blurry faces, partial faces, and faces on posters/screens.",
    'For every faces box, also add a matching privacy_risks entry with type "face".',
    "All coordinates must be normalized 0..1 relative to the full source frame, with origin at the top-left.",
    "",
    "Return JSON in this exact shape:",
    "{",
    '  "summary": "one concise paragraph describing what the video shows",',
    '  "moments": [',
    "    {",
    '      "timestamp_ms": <one of the provided timestamps>,',
    '      "is_key_moment": true,',
    '      "text": "0-6 word caption for the action/state at this moment",',
    '      "visual_metadata": {',
    '        "main_focus": { "x": 0.25, "y": 0.10, "width": 0.50, "height": 0.72, "confidence": 0.9, "label": "presenter or UI area" },',
    '        "faces": [{ "x": 0.42, "y": 0.18, "width": 0.12, "height": 0.16, "confidence": 0.8, "label": "speaker" }],',
    '        "text_regions": [{ "x": 0.08, "y": 0.12, "width": 0.55, "height": 0.10, "confidence": 0.7, "text": "important visible UI text" }],',
    '        "crop_regions": [{ "aspect_ratio": "1:1", "x": 0.20, "y": 0.02, "width": 0.60, "height": 0.96, "confidence": 0.8, "reason": "keeps presenter and UI action" }],',
    '        "privacy_risks": [{ "type": "face|email|name|document|address|other", "severity": "low|medium|high", "x": 0.40, "y": 0.20, "width": 0.10, "height": 0.08, "label": "what may need blur or emoji replacement" }],',
    '        "safe_caption_zones": [{ "x": 0.08, "y": 0.72, "width": 0.84, "height": 0.20, "confidence": 0.8, "reason": "does not cover face or key UI text" }]',
    "      }",
    "    }",
    "  ]",
    "}",
    "",
    "Rules:",
    "- One moment per provided frame.",
    "- Never omit visual_metadata. Use empty arrays for specific visual_metadata fields only when that kind of region is genuinely absent.",
    "- Use exact timestamps from the list.",
    "- Set is_key_moment=true only for intervals that should become visible moments/captions.",
    "- Set is_key_moment=false and text=\"\" for repeated frames, pauses, loading, unimportant cursor movement, transitions, or errors that do not support the user's story.",
    "- Each moment text must be 0-6 words, suitable as large on-video caption text.",
    "- Use imperative action-label phrasing, not third-person narration.",
    "- Good: Open Revdoku folder, Sign in, Run invoice review, Select Gemma model.",
    "- Bad: Opens Revdoku folder, Signs into Revdoku, Runs invoice review, The user selects Gemma.",
    "- Use the user context as the story filter; captions should support that topic.",
    "- Be concrete when relevant: app names, buttons, UI state, cursor/action if evident.",
    "- For incidental mistakes, failed sign-in/auth attempts, loading screens, transitions, cursor pauses, or unrelated detours, return an empty string unless the moment is essential.",
    "- For terminal/browser UI, summarize the action; do not copy raw screen text or list fields.",
    "- Screencast captions should be terse, for example: Enable local Ollama, Configure Gemma model, Run invoice review.",
    "- Never use words like screenshot, frame, image, photo, shown, depicts, or visible.",
    "- Do not invent spoken dialogue.",
    "- main_focus is the smallest region that preserves the main subject/action.",
    "- faces is required privacy metadata: include every visible human face/head, including side profiles, backs of heads, partial faces, small/background people, and faces on posters/screens if they could identify a person.",
    "- text_regions should include important visible UI/document text, not every tiny label.",
    "- crop_regions should include useful crops for 9:16, 1:1, 4:5, and 16:9 when possible.",
    '- privacy_risks should include a type="face" entry for every faces region, plus emails, names, invoices, addresses, private documents, or credentials.',
    "- safe_caption_zones should avoid faces, main_focus, and important text_regions.",
    "- Use empty arrays for missing faces/text/privacy/crop/safe zones. Use null for missing main_focus.",
  ].join("\n");
}

type VisualMetadataInput = {
  main_focus?: unknown;
  faces?: unknown;
  text_regions?: unknown;
  crop_regions?: unknown;
  privacy_risks?: unknown;
  safe_caption_zones?: unknown;
};

type RegionInput = {
  x?: unknown;
  y?: unknown;
  width?: unknown;
  height?: unknown;
  w?: unknown;
  h?: unknown;
  bbox?: unknown;
  confidence?: unknown;
  label?: unknown;
  text?: unknown;
  type?: unknown;
  severity?: unknown;
  aspect_ratio?: unknown;
  reason?: unknown;
};

function normalizeVisualMetadata(input: VisualMetadataInput | undefined): VisualMomentMetadata | undefined {
  if (!input) return undefined;
  const main_focus = normalizeRegion(input.main_focus);
  const faces = normalizeRegionList(input.faces);
  const privacy_risks = normalizeRegionList(input.privacy_risks);
  for (const risk of privacy_risks) {
    if (!isFaceLikeRegion(risk)) continue;
    if (faces.some((face) => similarRegion(face, risk))) continue;
    faces.push({
      ...risk,
      label: risk.label || "face",
      type: risk.type || "face",
    });
  }
  const metadata: VisualMomentMetadata = {
    main_focus: main_focus ?? null,
    faces,
    text_regions: normalizeRegionList(input.text_regions),
    crop_regions: normalizeRegionList(input.crop_regions),
    privacy_risks,
    safe_caption_zones: normalizeRegionList(input.safe_caption_zones),
  };
  const hasAny =
    !!main_focus ||
    (metadata.faces?.length ?? 0) > 0 ||
    (metadata.text_regions?.length ?? 0) > 0 ||
    (metadata.crop_regions?.length ?? 0) > 0 ||
    (metadata.privacy_risks?.length ?? 0) > 0 ||
    (metadata.safe_caption_zones?.length ?? 0) > 0;
  return hasAny ? metadata : undefined;
}

function isFaceLikeRegion(region: NormalizedVisualRegion): boolean {
  const type = (region.type || "").toLowerCase();
  const label = (region.label || "").toLowerCase();
  const reason = (region.reason || "").toLowerCase();
  return type === "face" || /\b(face|head|person)\b/.test(`${label} ${reason}`);
}

function similarRegion(a: NormalizedVisualRegion, b: NormalizedVisualRegion): boolean {
  const ax = a.x + a.width / 2;
  const ay = a.y + a.height / 2;
  const bx = b.x + b.width / 2;
  const by = b.y + b.height / 2;
  const centerClose = Math.abs(ax - bx) <= 0.05 && Math.abs(ay - by) <= 0.05;
  const sizeClose = Math.abs(a.width - b.width) <= 0.08 && Math.abs(a.height - b.height) <= 0.08;
  if (centerClose && sizeClose) return true;

  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  const overlap = Math.max(0, right - left) * Math.max(0, bottom - top);
  const smallerArea = Math.min(a.width * a.height, b.width * b.height);
  return smallerArea > 0 && overlap / smallerArea >= 0.55;
}

function normalizeRegionList(value: unknown): NormalizedVisualRegion[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => normalizeRegion(entry))
    .filter((entry): entry is NormalizedVisualRegion => !!entry);
}

function normalizeRegion(value: unknown): NormalizedVisualRegion | undefined {
  if (!value || typeof value !== "object") return undefined;
  const input = value as RegionInput;
  const bbox = Array.isArray(input.bbox) ? input.bbox : undefined;
  const x = clamp01(readNumber(input.x ?? bbox?.[0] ?? 0));
  const y = clamp01(readNumber(input.y ?? bbox?.[1] ?? 0));
  let width = clamp01(readNumber(input.width ?? input.w ?? bbox?.[2]));
  let height = clamp01(readNumber(input.height ?? input.h ?? bbox?.[3]));
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return undefined;
  width = Math.min(width, Math.max(0.001, 1 - x));
  height = Math.min(height, Math.max(0.001, 1 - y));
  const region: NormalizedVisualRegion = { x, y, width, height };
  const confidence = readNumber(input.confidence);
  if (Number.isFinite(confidence)) region.confidence = clamp01(confidence);
  const label = readString(input.label);
  if (label) region.label = label;
  const text = readString(input.text);
  if (text) region.text = text;
  const type = readString(input.type);
  if (type) region.type = type;
  const severity = readString(input.severity);
  if (severity === "low" || severity === "medium" || severity === "high") region.severity = severity;
  const aspectRatio = readString(input.aspect_ratio);
  if (aspectRatio) region.aspect_ratio = aspectRatio;
  const reason = readString(input.reason);
  if (reason) region.reason = reason;
  return region;
}

function readNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim()) return Number(value);
  return Number.NaN;
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, 240) : "";
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function compactVisualCaption(text: string): string {
  let s = cleanupTranscriptText(text)
    .replace(/^\s*(the\s+)?user\s+/i, "")
    .replace(/^\s*(this|the)\s+(video|screencast|screen\s+recording|recording)\s+(shows|showing|demonstrates|depicts|captures|is\s+about)\s+/i, "")
    .replace(/^\s*(this\s+)?(screenshot|screen shot|frame|image|photo)\s+(shows|showing|depicts|captures|contains)\s+/i, "")
    .replace(/^\s*(we\s+can\s+see|you\s+can\s+see|it\s+shows|shown\s+is|visible\s+is|there\s+is|there\s+are)\s+/i, "")
    .replace(/\b(this\s+)?(screenshot|screen shot|frame|image|photo)\b/gi, "")
    .replace(/\b(shows|showing|depicts|captures)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  s = (s.split(/[.!?]/)[0] || s).trim();
  s = imperativeVisualCaption(s);
  const words = s.split(/\s+/).filter(Boolean);
  if (words.length > 6) s = words.slice(0, 6).join(" ");
  return s;
}

function imperativeVisualCaption(text: string): string {
  const replacements: Array<[RegExp, string]> = [
    [/^opens\b/i, "Open"],
    [/^runs\b/i, "Run"],
    [/^selects\b/i, "Select"],
    [/^chooses\b/i, "Choose"],
    [/^clicks\b/i, "Click"],
    [/^reviews\b/i, "Review"],
    [/^configures\b/i, "Configure"],
    [/^checks\b/i, "Check"],
    [/^creates\b/i, "Create"],
    [/^starts\b/i, "Start"],
    [/^enables\b/i, "Enable"],
    [/^loads\b/i, "Load"],
    [/^sets\b/i, "Set"],
    [/^enters\b/i, "Enter"],
    [/^types\b/i, "Type"],
    [/^shows\b/i, "Show"],
    [/^signs\s+into\b/i, "Sign in to"],
    [/^signs\s+in\b/i, "Sign in"],
    [/^logs\s+into\b/i, "Log in to"],
    [/^logs\s+in\b/i, "Log in"],
  ];
  let out = text.trim();
  for (const [re, replacement] of replacements) {
    if (re.test(out)) return out.replace(re, replacement);
  }
  return out;
}

function fillMissingVisualCaption(
  tsMs: number,
  described: Array<{ ts_ms: number; text: string }>,
  fallback: string,
): string {
  const nonEmpty = described
    .filter((m) => m.text.trim())
    .sort((a, b) => a.ts_ms - b.ts_ms);
  if (nonEmpty.length === 0) return fallback;

  let prev: { ts_ms: number; text: string } | undefined;
  let next: { ts_ms: number; text: string } | undefined;
  for (const m of nonEmpty) {
    if (m.ts_ms <= tsMs) prev = m;
    else { next = m; break; }
  }

  // Opening beats need some context even before the first semantically
  // specific frame appears.
  if (!prev) return fallback || next?.text || "";
  if (!next) return tsMs - prev.ts_ms <= 10000 ? prev.text : fallback;

  const prevDist = tsMs - prev.ts_ms;
  const nextDist = next.ts_ms - tsMs;
  if (Math.min(prevDist, nextDist) > 10000) return fallback;
  return prevDist <= nextDist ? prev.text : next.text;
}

function applyVisualMetadataToMoments(
  moments: SampledMoment[],
  described: Array<{ ts_ms: number; visual_metadata?: VisualMomentMetadata }>,
): void {
  const metadataByTs = new Map(described.map((m) => [m.ts_ms, m.visual_metadata]));
  for (const m of moments) {
    const visualMetadata =
      metadataByTs.get(m.ts_ms) ?? fillMissingVisualMetadata(m.ts_ms, described);
    if (visualMetadata) m.visual_metadata = mergeVisualMetadata(m.visual_metadata, visualMetadata);
  }
}

function mergeVisualMetadata(
  existing: VisualMomentMetadata | undefined,
  incoming: VisualMomentMetadata | undefined,
): VisualMomentMetadata | undefined {
  if (!existing) return incoming;
  if (!incoming) return existing;
  return {
    main_focus: incoming.main_focus ?? existing.main_focus ?? null,
    faces: mergeRegionLists(existing.faces, incoming.faces),
    text_regions: mergeRegionLists(existing.text_regions, incoming.text_regions),
    crop_regions: mergeRegionLists(existing.crop_regions, incoming.crop_regions),
    privacy_risks: mergeRegionLists(existing.privacy_risks, incoming.privacy_risks),
    safe_caption_zones: mergeRegionLists(existing.safe_caption_zones, incoming.safe_caption_zones),
  };
}

function mergeRegionLists(
  existing: NormalizedVisualRegion[] | undefined,
  incoming: NormalizedVisualRegion[] | undefined,
): NormalizedVisualRegion[] {
  const out = [...(existing ?? [])];
  for (const region of incoming ?? []) {
    if (out.some((prev) => similarRegion(prev, region))) continue;
    out.push(region);
  }
  return out;
}

function fillMissingVisualMetadata(
  tsMs: number,
  described: Array<{ ts_ms: number; visual_metadata?: VisualMomentMetadata }>,
): VisualMomentMetadata | undefined {
  const withMetadata = described
    .filter((m) => !!m.visual_metadata)
    .sort((a, b) => a.ts_ms - b.ts_ms);
  let best: { ts_ms: number; visual_metadata?: VisualMomentMetadata } | undefined;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const m of withMetadata) {
    const dist = Math.abs(m.ts_ms - tsMs);
    if (dist < bestDist) {
      best = m;
      bestDist = dist;
    }
  }
  return best && bestDist <= 10000 ? best.visual_metadata : undefined;
}

function pickEvenThumbs<T>(items: T[], max: number): T[] {
  if (items.length <= max) return items;
  const out: T[] = [];
  for (let i = 0; i < max; i++) {
    const idx = Math.round((i / Math.max(1, max - 1)) * (items.length - 1));
    out.push(items[idx]!);
  }
  return out;
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunkSize = Math.max(1, Math.round(size));
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    out.push(items.slice(i, i + chunkSize));
  }
  return out;
}

function nearestTimestamp(ts: number, allowed: number[]): number {
  let best = allowed[0] ?? ts;
  let bestDist = Math.abs(best - ts);
  for (const t of allowed) {
    const d = Math.abs(t - ts);
    if (d < bestDist) {
      best = t;
      bestDist = d;
    }
  }
  return best;
}

type SampledMoment = {
  ts_ms: number;
  text?: string;
  original_text?: string;
  is_key_moment?: boolean;
  visual_metadata?: VisualMomentMetadata;
};

async function samplingDurationMs(
  videoPath: string,
  words: { startMs: number; endMs: number; text: string }[],
): Promise<number> {
  const probedDuration = await probeDurationMs(videoPath);
  const transcriptDuration = words.length > 0 ? words[words.length - 1]!.endMs : 0;
  return Math.max(probedDuration ?? 0, transcriptDuration, 1000);
}

function fmtSeconds(ms: number): string {
  const sec = ms / 1000;
  return `${sec.toFixed(ms % 1000 ? 1 : 0)}s`;
}

function sampleTimestamps(durationMs: number, intervalMs: number): number[] {
  const lastVisible = Math.max(0, Math.round(durationMs) - 250);
  const times: number[] = [0];
  const step = Math.max(500, Math.round(intervalMs));
  for (let t = step; t < lastVisible; t += step) times.push(t);
  if (lastVisible > 0 && Math.abs(lastVisible - times[times.length - 1]!) > 300) times.push(lastVisible);
  return Array.from(new Set(times)).sort((a, b) => a - b);
}

function sampleMomentsAtTimes(
  words: { startMs: number; endMs: number; text: string }[],
  duration: number,
  times: number[],
): SampledMoment[] {
  const moments: SampledMoment[] = [];
  for (let i = 0; i < times.length; i++) {
    const t = times[i]!;
    const nextT = i + 1 < times.length ? times[i + 1]! : duration;
    const windowWords = words.filter((w) => w.endMs > t && w.startMs < nextT);
    const raw = joinRawTranscriptWords(windowWords);
    const nearest = raw ? undefined : nearestWordAt(words, t);
    const originalText = raw || nearest?.text || "";
    moments.push({
      ts_ms: t,
      original_text: originalText,
      text: cleanupTranscriptText(originalText),
    });
  }
  return moments;
}

async function extractThumbnailsForMoments(
  file: SourceFile,
  moments: SampledMoment[],
  thumbsDir: string,
): Promise<Array<{ ts_ms: number; path: string }>> {
  const extracted: Array<{ ts_ms: number; path: string }> = [];
  for (const m of moments) {
    const thumbName = `${m.ts_ms}.jpg`;
    const thumbPath = path.join(thumbsDir, thumbName);
    if (!isUsableFile(thumbPath)) {
      try {
        await extractThumbnail(file.sourcePath, m.ts_ms, thumbPath);
      } catch {
        continue;
      }
    }
    extracted.push({ ts_ms: m.ts_ms, path: thumbPath });
  }
  return extracted;
}

function isUsableFile(filePath: string): boolean {
  try {
    return statSync(filePath).size > 0;
  } catch {
    return false;
  }
}

function thumbnailRefs(
  file: SourceFile,
  moments: SampledMoment[],
  extractedThumbs: Array<{ ts_ms: number; path: string }>,
): string[] {
  const extracted = new Set(extractedThumbs.map((thumb) => thumb.ts_ms));
  return moments
    .filter((m) => extracted.has(m.ts_ms))
    .map((m) => `${file.slug}/thumbs/${m.ts_ms}.jpg`);
}

function nearestWordAt(
  words: { startMs: number; endMs: number; text: string }[],
  ts: number,
): { startMs: number; endMs: number; text: string } | undefined {
  let best: { startMs: number; endMs: number; text: string } | undefined;
  for (const w of words) {
    if (w.startMs > ts + 1500) break;
    best = w;
  }
  return best;
}

async function extractThumbnail(videoPath: string, tsMs: number, outPath: string): Promise<void> {
  const ffmpeg = getFfmpegPath();
  const ts = (tsMs / 1000).toFixed(3);
  await runProc(ffmpeg, [
    "-y", "-ss", ts, "-i", videoPath,
    "-frames:v", "1",
    "-vf", `scale='min(${config.visualSampleImageMaxLongEdge},iw)':-2,format=yuvj420p`,
    "-c:v", "mjpeg",
    "-pix_fmt", "yuvj420p",
    "-q:v", "4",
    "-threads:v", "1",
    "-strict", "-2",
    "-f", "image2",
    outPath,
  ]);
}

async function probeDurationMs(filePath: string): Promise<number | undefined> {
  const ffprobe = getFfprobePath();
  try {
    const out = await runProcCapture(ffprobe, [
      "-v", "error", "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      filePath,
    ]);
    const sec = parseFloat(out.trim());
    if (!isFinite(sec)) return undefined;
    return Math.round(sec * 1000);
  } catch {
    return undefined;
  }
}

async function runProcCapture(cmd: string, args: string[]): Promise<string> {
  const { spawn } = await import("node:child_process");
  return new Promise<string>((resolve, reject) => {
    let out = "";
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"] });
    p.stdout.on("data", (d) => { out += d.toString(); });
    p.on("error", reject);
    p.on("exit", (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} exited ${code}`))));
  });
}

void readFile;
