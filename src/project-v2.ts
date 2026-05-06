import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync, statSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { projectsRoot } from "./projectFolder.js";
import { cleanupTranscriptText, firstWordsFromTranscript } from "./transcript-text.js";

// Two-level project model (v2): a project is a folder containing many
// video subprojects + a `_sources/` directory holding original files
// unchanged. v1 projects (single source video at `source/source.<ext>`)
// keep working alongside — distinguished by the presence of
// `.aicw-meta.json` with `version: 2`.

export const PROJECT_META_FILE = ".aicw-meta.json";
export const SOURCES_DIRNAME = "_sources";

const VIDEO_EXTS = new Set([".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi"]);
const AUDIO_EXTS = new Set([".m4a", ".mp3", ".wav", ".aac", ".flac", ".ogg", ".opus", ".aiff", ".aif"]);

export type FileKind = "video" | "audio";

export type ProjectMeta = {
  version: 2;
  title: string;
  autoMatchAudio: boolean;
  aiSceneAnalysis?: boolean;
  visualContext?: string;
  createdAt: string;
  updatedAt?: string;
};

export type NormalizedVisualRegion = {
  x: number;
  y: number;
  width: number;
  height: number;
  confidence?: number;
  label?: string;
  text?: string;
  type?: string;
  severity?: "low" | "medium" | "high";
  aspect_ratio?: string;
  reason?: string;
};

export type VisualMomentMetadata = {
  main_focus?: NormalizedVisualRegion | null;
  faces?: NormalizedVisualRegion[];
  text_regions?: NormalizedVisualRegion[];
  crop_regions?: NormalizedVisualRegion[];
  privacy_risks?: NormalizedVisualRegion[];
  safe_caption_zones?: NormalizedVisualRegion[];
};

// What we store in <name>.<ext>.json next to a source file. Audio files
// only fill the transcript-related fields; videos add summary + moments
// + thumbnails when they've been described.
export type SourceDescription = {
  kind: FileKind;
  filename: string;
  durationMs?: number;
  title?: string;
  titleEditedAt?: string;
  transcript?: {
    fullText: string;
    originalText?: string;
    words: { startMs: number; endMs: number; text: string }[];
  };
  visualContext?: string;
  summary?: string;
  moments?: {
    ts_ms: number;
    thumbnail?: string;
    text?: string;
    original_text?: string;
    is_key_moment?: boolean;
    visual_metadata?: VisualMomentMetadata;
  }[];
  thumbnails?: string[];
  describedAt?: string;
};

export type SourceFile = {
  kind: FileKind;
  originalName: string;
  sourcePath: string;
  slug: string;
  description?: SourceDescription;
};

export type VideoSubproject = {
  slug: string;
  root: string;
  sourceFile: SourceFile;
  matchedAudio?: SourceFile;
  hasReplacedAudio: boolean;
  hasPlan: boolean;
  hasClips: boolean;
  clipCount: number;
  // Filename of the working copy under <root>/, e.g. "video.mp4" or
  // "video.mov". The UI uses this to build inline-preview URLs.
  videoFileName: string;
  // Whether describe-all has populated this video's transcript +
  // thumbnails. Mirrors `sourceFile.description` being set.
  isDescribed: boolean;
  // Number of clips currently in shorts/plan.json. The UI shows this
  // alongside renderedCount on each video tile.
  suggestedClipsCount: number;
  // Number of .mp4 files across all shorts/render-*/ directories. 0 if
  // the user hasn't rendered anything yet.
  renderedCount: number;
  // Tutorial folders generated under <root>/tutorials/.
  tutorialCount: number;
  latestTutorialName?: string;
};

export type ProjectRenderedClip = {
  videoSlug: string;
  videoTitle: string;
  sourceName: string;
  dir: string;
  file: string;
  relativePath: string;
  stamp: string;
  clipId?: string;
  outputTitle?: string;
  formatLabel?: string;
  formatName?: string;
  aspectRatio?: string;
  w?: number;
  h?: number;
  renderedAt?: string;
  createdMs?: number;
};

export type ProjectV2 = {
  slug: string;
  root: string;
  meta: ProjectMeta;
  sourceVideos: SourceFile[];
  sourceAudios: SourceFile[];
  videos: VideoSubproject[];
  orphanAudios: SourceFile[];
  renderedClips: ProjectRenderedClip[];
};

export function isV2Project(projectPath: string): boolean {
  const metaPath = path.join(projectPath, PROJECT_META_FILE);
  if (!existsSync(metaPath)) return false;
  try {
    const meta = JSON.parse(readFileSync(metaPath, "utf-8")) as Partial<ProjectMeta>;
    return meta.version === 2;
  } catch {
    return false;
  }
}

// Filename → folder-safe slug. `IMG_6983.MOV` → `IMG_6983_MOV`,
// `Achajour 2.m4a` → `Achajour_2_m4a`. Case is preserved.
export function slugForFilename(filename: string): string {
  return filename.replace(/[\s.]+/g, "_");
}

export function classifyFile(filename: string): FileKind | null {
  const ext = path.extname(filename).toLowerCase();
  if (VIDEO_EXTS.has(ext)) return "video";
  if (AUDIO_EXTS.has(ext)) return "audio";
  return null;
}

// Sanitise a project name into a folder-safe slug. Used at create time.
export function projectNameToSlug(name: string): string {
  const trimmed = name.trim().toLowerCase();
  const out = trimmed.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return out.slice(0, 50) || "project";
}

export async function initProjectV2(
  slug: string,
  meta: { title: string; autoMatchAudio: boolean; aiSceneAnalysis?: boolean },
): Promise<string> {
  const root = path.join(projectsRoot(), slug);
  await mkdir(path.join(root, SOURCES_DIRNAME), { recursive: true });
  const metaObj: ProjectMeta = {
    version: 2,
    title: meta.title,
    autoMatchAudio: meta.autoMatchAudio,
    aiSceneAnalysis: meta.aiSceneAnalysis === true,
    createdAt: new Date().toISOString(),
  };
  await writeFile(path.join(root, PROJECT_META_FILE), JSON.stringify(metaObj, null, 2));
  return root;
}

// Pick a unique slug if the candidate already exists.
export function uniqueSlugIn(parent: string, candidate: string): string {
  let slug = candidate;
  let i = 2;
  while (existsSync(path.join(parent, slug))) {
    slug = `${candidate}-${i++}`;
  }
  return slug;
}

// Resolve where a source file should land. Returns absolute path.
export async function sourceFileTarget(projectRoot: string, originalName: string): Promise<string> {
  const safe = originalName.replace(/[\/\\]/g, "_");
  const dst = path.join(projectRoot, SOURCES_DIRNAME, safe);
  await mkdir(path.dirname(dst), { recursive: true });
  return dst;
}

export function sourceDescriptionPath(sourcePath: string): string {
  return `${sourcePath}.json`;
}

export function sourceThumbsDir(sourceFile: SourceFile): string {
  return path.join(path.dirname(sourceFile.sourcePath), sourceFile.slug, "thumbs");
}

export async function loadProjectV2(projectRoot: string): Promise<ProjectV2 | null> {
  const metaPath = path.join(projectRoot, PROJECT_META_FILE);
  if (!existsSync(metaPath)) return null;
  let meta: ProjectMeta;
  try {
    meta = JSON.parse(await readFile(metaPath, "utf-8")) as ProjectMeta;
  } catch {
    return null;
  }
  if (meta.version !== 2) return null;

  const sourcesDir = path.join(projectRoot, SOURCES_DIRNAME);
  const sourceVideos: SourceFile[] = [];
  const sourceAudios: SourceFile[] = [];
  if (existsSync(sourcesDir)) {
    const entries = await readdir(sourcesDir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isFile()) continue;
      if (e.name.startsWith(".")) continue;
      if (e.name.endsWith(".json")) continue;
      const kind = classifyFile(e.name);
      if (!kind) continue;
      const sourcePath = path.join(sourcesDir, e.name);
      const slug = slugForFilename(e.name);
      const sidecar = `${sourcePath}.json`;
      let description: SourceDescription | undefined;
      if (existsSync(sidecar)) {
        try {
          description = normalizeDescriptionForDisplay(
            JSON.parse(await readFile(sidecar, "utf-8")) as SourceDescription,
          );
        }
        catch { /* ignore corrupt */ }
      }
      const file: SourceFile = { kind, originalName: e.name, sourcePath, slug, description };
      if (kind === "video") sourceVideos.push(file);
      else sourceAudios.push(file);
    }
  }
  sourceVideos.sort((a, b) => a.originalName.localeCompare(b.originalName));
  sourceAudios.sort((a, b) => a.originalName.localeCompare(b.originalName));

  // Materialised video subprojects (PR 2 populates these).
  const videos: VideoSubproject[] = [];
  const renderedClips: ProjectRenderedClip[] = [];
  if (existsSync(projectRoot)) {
    const entries = await readdir(projectRoot, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name === SOURCES_DIRNAME) continue;
      if (e.name.startsWith(".") || e.name.startsWith("_")) continue;
      const subRoot = path.join(projectRoot, e.name);
      const videoPath = pickVideoFile(subRoot, "video");
      if (!videoPath) continue;
      const matchedSource = sourceVideos.find((sv) => sv.slug === e.name);
      if (!matchedSource) continue;
      const videoTitle = matchedSource.description?.title || matchedSource.originalName;
      const videoRenders = listRenderedClips(subRoot, e.name, videoTitle, matchedSource.originalName);
      const tutorials = listTutorialFolders(subRoot);
      renderedClips.push(...videoRenders);
      // Read the match marker (written by auto-match.ts after a
      // successful replace-audio). Populates matchedAudio so the UI can
      // show "audio matched: <name>" and so we can filter orphans.
      let matchedAudio: SourceFile | undefined;
      const matchMetaPath = path.join(subRoot, ".match-meta.json");
      if (existsSync(matchMetaPath)) {
        try {
          const mm = JSON.parse(await readFile(matchMetaPath, "utf-8")) as { audioOriginalName?: string };
          if (mm.audioOriginalName) {
            matchedAudio = sourceAudios.find((a) => a.originalName === mm.audioOriginalName);
          }
        } catch { /* malformed marker — leave matchedAudio undefined */ }
      }
      const planPath = path.join(subRoot, "shorts", "plan.json");
      const suggestionsPath = path.join(subRoot, "shorts", "suggestions.json");
      const hasPlanFile = existsSync(planPath);
      let suggestedClipsCount = 0;
      if (hasPlanFile) {
        try {
          const plan = JSON.parse(await readFile(planPath, "utf-8")) as { clips?: unknown[] };
          if (Array.isArray(plan.clips)) suggestedClipsCount = plan.clips.length;
        } catch { /* malformed — leave 0 */ }
      } else if (existsSync(suggestionsPath)) {
        try {
          const suggestions = JSON.parse(await readFile(suggestionsPath, "utf-8")) as { clips?: unknown[] };
          if (Array.isArray(suggestions.clips)) suggestedClipsCount = suggestions.clips.length;
        } catch { /* malformed — leave 0 */ }
      }
      videos.push({
        slug: e.name,
        root: subRoot,
        sourceFile: matchedSource,
        matchedAudio,
        hasReplacedAudio: existsSync(path.join(subRoot, "_backup")),
        hasPlan: hasPlanFile,
        hasClips: existsSync(path.join(subRoot, "clips")),
        clipCount: countClips(path.join(subRoot, "clips")),
        videoFileName: path.basename(videoPath),
        isDescribed: !!matchedSource.description,
        suggestedClipsCount,
        renderedCount: videoRenders.length,
        tutorialCount: tutorials.count,
        latestTutorialName: tutorials.latestName,
      });
    }
  }
  renderedClips.sort((a, b) => {
    const bm = b.createdMs ?? Date.parse(b.renderedAt || "");
    const am = a.createdMs ?? Date.parse(a.renderedAt || "");
    if (Number.isFinite(bm) && Number.isFinite(am)) return bm - am;
    return (b.renderedAt || b.stamp).localeCompare(a.renderedAt || a.stamp);
  });

  // Orphans = source audios that aren't pinned by any video subproject's
  // match marker. They're the "no good match found" leftovers.
  const matched = new Set(videos.filter((v) => v.matchedAudio).map((v) => v.matchedAudio!.sourcePath));
  const orphanAudios = sourceAudios.filter((a) => !matched.has(a.sourcePath));

  return {
    slug: path.basename(projectRoot),
    root: projectRoot,
    meta,
    sourceVideos,
    sourceAudios,
    videos,
    orphanAudios,
    renderedClips,
  };
}

function normalizeDescriptionForDisplay(desc: SourceDescription): SourceDescription {
  const out: SourceDescription = { ...desc };
  const fullText = out.transcript?.fullText ? cleanupTranscriptText(out.transcript.fullText) : "";
  if (out.transcript) {
    out.transcript = {
      ...out.transcript,
      originalText: out.transcript.originalText ?? out.transcript.fullText,
      fullText,
    };
  }
  if (out.titleEditedAt && out.title) out.title = cleanupTranscriptText(out.title);
  else if (fullText) out.title = firstWordsFromTranscript(fullText, 5);
  else if (out.title) out.title = cleanupTranscriptText(out.title);
  if (out.moments) {
    out.moments = out.moments.map((m) => ({
      ...m,
      original_text: m.original_text ?? m.text,
      text: cleanupTranscriptText(m.text ?? m.original_text ?? ""),
    }));
  }
  return out;
}

function pickVideoFile(dir: string, baseName: string): string | null {
  for (const ext of [".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi"]) {
    const p = path.join(dir, `${baseName}${ext}`);
    if (existsSync(p)) return p;
  }
  return null;
}

function listRenderedClips(
  videoRoot: string,
  videoSlug: string,
  videoTitle: string,
  sourceName: string,
): ProjectRenderedClip[] {
  const shortsDir = path.join(videoRoot, "shorts");
  if (!existsSync(shortsDir)) return [];
  const out: ProjectRenderedClip[] = [];
  try {
    const dirs = readdirSync(shortsDir, { withFileTypes: true });
    for (const d of dirs) {
      if (!d.isDirectory() || !d.name.startsWith("render-")) continue;
      const renderDir = path.join(shortsDir, d.name);
      let files: string[] = [];
      try { files = readdirSync(renderDir).filter((n: string) => n.toLowerCase().endsWith(".mp4")); }
      catch { continue; }
      const stamp = d.name.replace(/^render-/, "");
      for (const file of files) {
        const renderedPath = path.join(renderDir, file);
        const sidecar = path.join(renderDir, file.replace(/\.mp4$/i, ".json"));
        let meta: Partial<ProjectRenderedClip> & {
          clip_id?: string;
          output_title?: string;
          format_label?: string;
          format_name?: string;
          aspect_ratio?: string;
          rendered_at?: string;
        } = {};
        if (existsSync(sidecar)) {
          try { meta = JSON.parse(readFileSync(sidecar, "utf-8")); }
          catch { meta = {}; }
        }
        const metaMs = meta.rendered_at ? Date.parse(meta.rendered_at) : NaN;
        const createdMs = Number.isFinite(metaMs) ? metaMs : statSync(renderedPath).mtimeMs;
        out.push({
          videoSlug,
          videoTitle,
          sourceName,
          dir: d.name,
          file,
          relativePath: path.posix.join(videoSlug, "shorts", d.name, file),
          stamp,
          clipId: meta.clip_id,
          outputTitle: meta.output_title,
          formatLabel: meta.format_label,
          formatName: meta.format_name,
          aspectRatio: meta.aspect_ratio,
          w: meta.w,
          h: meta.h,
          renderedAt: Number.isFinite(createdMs) ? new Date(createdMs).toISOString() : meta.rendered_at,
          createdMs: Number.isFinite(createdMs) ? Math.round(createdMs) : undefined,
        });
      }
    }
  } catch {
    return out;
  }
  return out;
}

function listTutorialFolders(videoRoot: string): { count: number; latestName?: string } {
  const tutorialsDir = path.join(videoRoot, "tutorials");
  if (!existsSync(tutorialsDir)) return { count: 0 };
  try {
    const dirs = readdirSync(tutorialsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("."))
      .map((d) => {
        const fullPath = path.join(tutorialsDir, d.name);
        return { name: d.name, mtimeMs: statSync(fullPath).mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    return { count: dirs.length, latestName: dirs[0]?.name };
  } catch {
    return { count: 0 };
  }
}

function countClips(clipsDir: string): number {
  if (!existsSync(clipsDir)) return 0;
  try {
    const s = statSync(clipsDir);
    if (!s.isDirectory()) return 0;
    return readdirSync(clipsDir).filter((n: string) => n.endsWith(".mp4")).length;
  } catch {
    return 0;
  }
}
