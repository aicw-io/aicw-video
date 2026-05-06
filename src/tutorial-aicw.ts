import { mkdir, readFile, writeFile, copyFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveProject, sourceVideoPath } from "./projectFolder.js";
import { analyzeVideo, type Analysis } from "./analyze.js";

type TutorialFormat = "html" | "md" | "both";

type VideoMoment = {
  ts_ms: number;
  text?: string;
  original_text?: string;
  thumbnail?: string;
};

type VideoDescription = {
  title?: string;
  summary?: string;
  moments?: VideoMoment[];
};

type TutorialMoment = {
  ts_ms: number;
  text: string;
  framePath?: string;
  source?: string;
};

type TutorialStep = {
  step: number;
  timestamp_ms: number;
  timestamp: string;
  clip_timestamp_ms?: number;
  clip_timestamp?: string;
  title: string;
  text: string;
  source_text: string;
  image: string;
  source_frame?: string;
};

export type ClipTutorialPoint = {
  index?: number;
  ts_ms: number;
  caption?: string;
  original_text?: string;
};

type RenderTutorialArgs = {
  title: string;
  lede?: string;
  moments: TutorialMoment[];
  format?: TutorialFormat;
  clip?: {
    id: string;
    startMs: number;
    endMs: number;
  };
};

export async function buildTutorial(
  projectPath: string,
  opts: { title?: string; steps?: number; format?: TutorialFormat } = {},
): Promise<{ outputDir: string; files: string[]; tutorialName: string; stepCount: number }> {
  const root = await resolveProject(projectPath);
  await sourceVideoPath(projectPath); // ensure source exists

  const source = await loadTutorialSource(root, projectPath);
  const moments = source.moments;
  if (moments.length === 0) {
    throw new Error("No moments are available for this video yet. Analyze or describe the video first.");
  }

  const stepCount = opts.steps ?? Math.min(8, Math.max(4, moments.length));
  const picked = pickRepresentativeMoments(moments, stepCount);
  const title = opts.title?.trim() || source.title || "Tutorial";

  return renderTutorial(root, {
    title,
    lede: source.lede,
    moments: picked,
    format: opts.format,
  });
}

export async function buildClipTutorial(
  projectPath: string,
  opts: {
    clipId: string;
    title?: string;
    startMs: number;
    endMs: number;
    points?: ClipTutorialPoint[];
    steps?: number;
    format?: TutorialFormat;
  },
): Promise<{ outputDir: string; files: string[]; tutorialName: string; stepCount: number }> {
  const root = await resolveProject(projectPath);
  await sourceVideoPath(projectPath);

  const startMs = Math.max(0, Math.round(opts.startMs));
  const endMs = Math.max(startMs + 1, Math.round(opts.endMs));
  const source = await loadTutorialSource(root, projectPath);
  let moments = await momentsForClip(root, source.moments, {
    startMs,
    endMs,
    points: opts.points ?? [],
  });

  if (moments.length === 0) {
    throw new Error("No captioned moments with thumbnails are available inside this clip range.");
  }

  if (opts.steps && moments.length > opts.steps) {
    moments = pickRepresentativeMoments(moments, opts.steps);
  }

  const title = opts.title?.trim() || "Tutorial";
  const lede = `Clip range: ${msToTimecode(startMs)}-${msToTimecode(endMs)}`;
  return renderTutorial(root, {
    title,
    lede,
    moments,
    format: opts.format,
    clip: { id: opts.clipId, startMs, endMs },
  });
}

async function renderTutorial(
  root: string,
  args: RenderTutorialArgs,
): Promise<{ outputDir: string; files: string[]; tutorialName: string; stepCount: number }> {
  const moments = args.moments;
  if (moments.length === 0) {
    throw new Error("No moments are available for this tutorial.");
  }

  const here = path.dirname(fileURLToPath(import.meta.url));
  const templateDir = path.join(here, "templates", "tutorial");
  const indexHtml = await readFile(path.join(templateDir, "index.html"), "utf8");
  const stepHtml = await readFile(path.join(templateDir, "step.html"), "utf8");
  const indexMd = await readFile(path.join(templateDir, "index.md"), "utf8");
  const stepMd = await readFile(path.join(templateDir, "step.md"), "utf8");

  const title = args.title;
  const tutorialName = `${slug(title)}-${stamp()}`;
  const outDir = path.join(root, "tutorials", tutorialName);
  const assetsDir = path.join(outDir, "assets", tutorialName);
  await mkdir(assetsDir, { recursive: true });

  const stepsHtml: string[] = [];
  const stepsMd: string[] = [];
  const keyMoments: TutorialStep[] = [];

  for (let i = 0; i < moments.length; i++) {
    const moment = moments[i]!;
    const stepNumber = i + 1;
    const description = sanitizeMomentText(moment.text);
    const { headline, body } = splitStepText(description, stepNumber, moment.ts_ms);
    const image = await copyStepImage(moment.framePath, assetsDir, tutorialName, stepNumber);

    const fields = {
      STEP_NUMBER: String(stepNumber),
      STEP_DESCRIPTION: escapeHtml(headline),
      STEP_TEXT: escapeHtml(body),
      STEP_IMAGE: image.relPath,
      STEP_ALT: stripFormatting(headline),
    };

    stepsHtml.push(applyTemplate(stepHtml, fields));
    stepsMd.push(applyTemplate(stepMd, fields));
    keyMoments.push({
      step: stepNumber,
      timestamp_ms: moment.ts_ms,
      timestamp: msToTimecode(moment.ts_ms),
      ...(args.clip ? {
        clip_timestamp_ms: Math.max(0, moment.ts_ms - args.clip.startMs),
        clip_timestamp: msToTimecode(Math.max(0, moment.ts_ms - args.clip.startMs)),
      } : {}),
      title: headline,
      text: body,
      source_text: description,
      image: image.relPath,
      ...(image.sourcePath ? { source_frame: image.sourcePath } : {}),
    });
  }

  const ledeHtml = args.lede ? `<p>${escapeHtml(args.lede)}</p>` : "";
  const ledeMd = args.lede ? `${args.lede}\n` : "";
  const renderedHtml = applyTemplate(indexHtml, {
    TITLE: escapeHtml(title),
    LEDE: ledeHtml,
    STEPS: stepsHtml.join("\n"),
  });
  const renderedMd = applyTemplate(indexMd, {
    TITLE: title,
    LEDE: ledeMd,
    STEPS: stepsMd.join("\n"),
  });

  const files: string[] = [];
  const fmt = args.format ?? "both";
  if (fmt !== "md") {
    const p = path.join(outDir, "index.html");
    await writeFile(p, renderedHtml);
    files.push(p);
  }
  if (fmt !== "html") {
    const p = path.join(outDir, "index.md");
    await writeFile(p, renderedMd);
    files.push(p);
  }
  const momentsPath = path.join(outDir, "key-moments.json");
  await writeFile(momentsPath, JSON.stringify({
    title,
    generated_at: new Date().toISOString(),
    ...(args.clip ? {
      clip: {
        id: args.clip.id,
        start_ms: args.clip.startMs,
        end_ms: args.clip.endMs,
        start: msToTimecode(args.clip.startMs),
        end: msToTimecode(args.clip.endMs),
      },
    } : {}),
    moments: keyMoments,
  }, null, 2));
  files.push(momentsPath);

  return { outputDir: outDir, files, tutorialName, stepCount: moments.length };
}

async function loadTutorialSource(
  root: string,
  projectPath: string,
): Promise<{ title?: string; lede?: string; moments: TutorialMoment[] }> {
  const videoJsonPath = path.join(root, "video.json");
  if (existsSync(videoJsonPath)) {
    const parsed = JSON.parse(await readFile(videoJsonPath, "utf8")) as VideoDescription;
    const moments = (parsed.moments ?? [])
      .filter((m) => Number.isFinite(m.ts_ms))
      .map((m) => ({
        ts_ms: m.ts_ms,
        text: sanitizeMomentText(m.text || m.original_text || ""),
        framePath: resolveVideoMomentFrame(root, m),
      }))
      .filter((m) => m.framePath);
    if (moments.length > 0) {
      return {
        title: parsed.title,
        lede: firstSentence(parsed.summary || ""),
        moments,
      };
    }
  }

  const analysisPath = path.join(root, "analysis", "moments.json");
  let analysis: Analysis;
  if (existsSync(analysisPath)) {
    analysis = JSON.parse(await readFile(analysisPath, "utf8")) as Analysis;
  } else {
    analysis = (await analyzeVideo(projectPath)).analysis;
  }

  return {
    moments: analysis.moments.map((m) => ({
      ts_ms: m.ts_ms,
      text: sanitizeMomentText(m.transcript_text ?? ""),
      framePath: path.join(root, m.frame),
      source: m.source,
    })),
  };
}

async function momentsForClip(
  root: string,
  sourceMoments: TutorialMoment[],
  opts: { startMs: number; endMs: number; points: ClipTutorialPoint[] },
): Promise<TutorialMoment[]> {
  const byTs = new Map(sourceMoments.map((m) => [m.ts_ms, m]));
  const pointMoments: TutorialMoment[] = [];

  for (const point of opts.points) {
    const ts = Math.round(point.ts_ms);
    if (!Number.isFinite(ts) || ts < opts.startMs || ts >= opts.endMs) continue;
    const source = byTs.get(ts);
    const framePath = source?.framePath ?? await resolvePointFrame(root, point);
    if (!framePath) continue;
    const text = sanitizeMomentText(point.caption || point.original_text || source?.text || "");
    if (!text) continue;
    pointMoments.push({
      ts_ms: ts,
      text,
      framePath,
      source: source?.source,
    });
  }

  if (pointMoments.length > 0) {
    return pointMoments.sort((a, b) => a.ts_ms - b.ts_ms);
  }

  return sourceMoments
    .filter((m) => m.ts_ms >= opts.startMs && m.ts_ms < opts.endMs && m.framePath && sanitizeMomentText(m.text))
    .sort((a, b) => a.ts_ms - b.ts_ms);
}

async function resolvePointFrame(root: string, point: ClipTutorialPoint): Promise<string | undefined> {
  const keyframesDir = path.join(root, "analysis", "keyframes");
  if (!existsSync(keyframesDir)) return undefined;
  let names: string[];
  try {
    names = await readdir(keyframesDir);
  } catch {
    return undefined;
  }

  const exts = /\.(webp|jpe?g|png)$/i;
  const tsSuffix = `-${Math.round(point.ts_ms)}ms`;
  const byTs = names.find((name) => exts.test(name) && path.basename(name, path.extname(name)).endsWith(tsSuffix));
  if (byTs) return path.join(keyframesDir, byTs);

  if (Number.isFinite(point.index)) {
    const idxPrefix = `frame-${String(point.index).padStart(3, "0")}-`;
    const byIndex = names.find((name) => exts.test(name) && name.startsWith(idxPrefix));
    if (byIndex) return path.join(keyframesDir, byIndex);
  }

  return undefined;
}

function resolveVideoMomentFrame(root: string, moment: VideoMoment): string | undefined {
  const projectRoot = path.dirname(root);
  const videoSlug = path.basename(root);
  const thumbsDir = path.join(projectRoot, "_sources", videoSlug, "thumbs");
  const candidates: string[] = [];

  if (moment.thumbnail) {
    if (path.isAbsolute(moment.thumbnail)) candidates.push(moment.thumbnail);
    candidates.push(path.join(root, moment.thumbnail));
    candidates.push(path.join(projectRoot, "_sources", moment.thumbnail));
    candidates.push(path.join(thumbsDir, path.basename(moment.thumbnail)));
  }

  for (const ext of [".jpg", ".jpeg", ".webp", ".png"]) {
    candidates.push(path.join(thumbsDir, `${moment.ts_ms}${ext}`));
  }

  return candidates.find((candidate) => existsSync(candidate));
}

async function copyStepImage(
  sourcePath: string | undefined,
  assetsDir: string,
  tutorialName: string,
  stepNumber: number,
): Promise<{ relPath: string; sourcePath?: string }> {
  const ext = sourcePath ? normalizeImageExt(path.extname(sourcePath)) : ".webp";
  const destName = `step-${String(stepNumber).padStart(2, "0")}${ext}`;
  const relPath = `assets/${tutorialName}/${destName}`;

  if (sourcePath && existsSync(sourcePath)) {
    await copyFile(sourcePath, path.join(assetsDir, destName));
    return { relPath, sourcePath };
  }

  return { relPath };
}

function normalizeImageExt(ext: string): string {
  const lower = ext.toLowerCase();
  return [".jpg", ".jpeg", ".webp", ".png"].includes(lower) ? lower : ".webp";
}

function pickRepresentativeMoments<T extends { ts_ms: number; source?: string }>(moments: T[], n: number): T[] {
  if (moments.length <= n) return moments;
  const lastTs = moments[moments.length - 1]!.ts_ms;
  const buckets: T[][] = Array.from({ length: n }, () => []);
  for (const m of moments) {
    const idx = Math.min(n - 1, Math.floor((m.ts_ms / Math.max(1, lastTs)) * n));
    buckets[idx]!.push(m);
  }

  const picked: T[] = [];
  for (const bucket of buckets) {
    if (bucket.length === 0) continue;
    picked.push(bucket.find((m) => m.source === "scene") ?? bucket[0]!);
  }

  for (const m of moments) {
    if (picked.length >= n) break;
    if (!picked.includes(m)) picked.push(m);
  }

  return picked.slice(0, n).sort((a, b) => a.ts_ms - b.ts_ms);
}

function splitStepText(text: string, fallbackIdx: number, tsMs: number): { headline: string; body: string } {
  if (!text || isSilenceText(text)) {
    return { headline: `at ${msToTimecode(tsMs)}`, body: "" };
  }

  const sentence = firstSentence(text);
  if (sentence.length >= 6 && sentence.length <= 90) {
    return { headline: sentence, body: trimLeadingSentence(text.slice(sentence.length)) };
  }

  if (sentence.length > 90) {
    const headline = sentence.slice(0, 87).trim() + "...";
    return { headline, body: text };
  }

  return { headline: `Step ${fallbackIdx}`, body: text };
}

function firstSentence(text: string): string {
  const cleaned = sanitizeMomentText(text);
  const match = cleaned.match(/^(.+?[.!?])(\s|$)/);
  if (match) return match[1]!.trim();
  return cleaned;
}

function trimLeadingSentence(text: string): string {
  return text.replace(/^[\s.!?,:;-]+/, "").trim();
}

function sanitizeMomentText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function isSilenceText(text: string): boolean {
  const cleaned = text.trim();
  if (/^\[(music|singing|silence|noise|applause|laughter|inaudible)\]?$/i.test(cleaned)) return true;
  return /^(you|thank you\.?|bye\.?|thanks\.?)$/i.test(cleaned);
}

function applyTemplate(tpl: string, fields: Record<string, string>): string {
  let out = tpl;
  for (const [k, v] of Object.entries(fields)) {
    out = out.split(`{{${k}}}`).join(v);
  }
  return out;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function stripFormatting(s: string): string {
  return s.replace(/\*\*?|__|`|<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "tutorial";
}

function msToTimecode(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
