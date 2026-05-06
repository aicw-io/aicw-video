import { mkdir, stat, copyFile, readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

export type ProjectStatus = {
  hasSource: boolean;
  hasTranscript: boolean;
  hasAnalysis: boolean;
  hasPlan: boolean;
  clipCount: number;
  renderCount: number;
};

export type ProjectSummary = {
  slug: string;
  path: string;
  title: string;
  modifiedAt: number;
  status: ProjectStatus;
  archived: boolean;
};

// Resolve any input to a project root directory.
export async function resolveProject(input: string): Promise<string> {
  const s = await stat(input);
  if (s.isDirectory()) return path.resolve(input);
  throw new Error(`not a project folder: ${input}`);
}

export async function initProject(root: string): Promise<string> {
  const r = path.resolve(root);
  await mkdir(path.join(r, "source"), { recursive: true });
  return r;
}

export async function importVideo(source: string, projectPath: string): Promise<string> {
  if (/^https?:\/\//i.test(source)) {
    throw new Error("URL imports are not supported in this version. Choose a local video file.");
  }
  const root = await initProject(projectPath);
  const ext = path.extname(source) || ".mp4";
  const dst = path.join(root, "source", `source${ext}`);
  await copyFile(source, dst);
  return dst;
}

// Derive a folder-safe name from a local source path.
export function deriveProjectName(source: string): string {
  const base = path.basename(source, path.extname(source));
  return slug(base);
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50) || "video";
}

// Default project root for auto-naming: ~/aicw-video/projects/<slug>.
export function defaultProjectRoot(name: string): string {
  const home = process.env.HOME || "/tmp";
  return path.join(home, "aicw-video", "projects", name);
}

// The directory the hub scans for projects: ~/aicw-video/projects/.
export function projectsRoot(): string {
  const home = process.env.HOME || "/tmp";
  return path.join(home, "aicw-video", "projects");
}

// Scan the projects root and summarise each subdir. Skips dirs whose names
// start with a dot. Returns list sorted by most-recently-modified first.
export async function scanProjects(): Promise<ProjectSummary[]> {
  const root = projectsRoot();
  if (!existsSync(root)) return [];
  const entries = await readdir(root, { withFileTypes: true });
  const out: ProjectSummary[] = [];
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    // Accept both real directories and symlinks that resolve to directories.
    let isDir = e.isDirectory();
    if (!isDir && e.isSymbolicLink()) {
      try { isDir = (await stat(path.join(root, e.name))).isDirectory(); }
      catch { isDir = false; }
    }
    if (!isDir) continue;
    const p = path.join(root, e.name);
    // v2-only: only surface projects with .aicw-meta.json (version: 2).
    // v1 single-video projects are no longer supported in the UI.
    const metaPath = path.join(p, ".aicw-meta.json");
    if (!existsSync(metaPath)) continue;
    out.push(await summariseProject(p, e.name, e.name.startsWith("_")));
  }
  out.sort((a, b) => b.modifiedAt - a.modifiedAt);
  return out;
}

async function summariseProject(projectPath: string, slug: string, archived: boolean): Promise<ProjectSummary> {
  const sourceDir = path.join(projectPath, "source");
  const v2SourceDir = path.join(projectPath, "_sources");
  let hasSource = false;
  if (existsSync(sourceDir)) {
    const files = await readdir(sourceDir).catch(() => [] as string[]);
    hasSource = files.some((x) => /^source\.(mp4|webm|mkv|mov|m4v)$/i.test(x));
  }
  if (!hasSource && existsSync(v2SourceDir)) {
    const files = await readdir(v2SourceDir).catch(() => [] as string[]);
    hasSource = files.some((x) => /\.(mp4|webm|mkv|mov|m4v|m4a|mp3|wav|aac|flac)$/i.test(x));
  }
  const planPath = path.join(projectPath, "shorts", "plan.json");
  const hasPlan = existsSync(planPath);
  const status: ProjectStatus = {
    hasSource,
    hasTranscript: existsSync(path.join(projectPath, "transcript.json")),
    hasAnalysis: existsSync(path.join(projectPath, "analysis", "moments.json")),
    hasPlan,
    clipCount: hasPlan ? await readClipCount(planPath) : 0,
    renderCount: await countRenders(projectPath),
  };
  const title = await readProjectTitle(projectPath, slug);
  const modifiedAt = await mostRecentMtime(projectPath);
  return { slug, path: projectPath, title, modifiedAt, status, archived };
}

async function readClipCount(planPath: string): Promise<number> {
  try {
    const raw = JSON.parse(await readFile(planPath, "utf-8")) as { clips?: unknown[] };
    return Array.isArray(raw.clips) ? raw.clips.length : 0;
  } catch {
    return 0;
  }
}

async function countRenders(projectPath: string): Promise<number> {
  const shortsDir = path.join(projectPath, "shorts");
  if (!existsSync(shortsDir)) return 0;
  const entries = await readdir(shortsDir, { withFileTypes: true }).catch(() => [] as Array<{ name: string; isDirectory(): boolean }>);
  return entries.filter((e) => e.isDirectory() && e.name.startsWith("render-")).length;
}

async function readProjectTitle(projectPath: string, fallback: string): Promise<string> {
  const v2MetaPath = path.join(projectPath, ".aicw-meta.json");
  if (existsSync(v2MetaPath)) {
    try {
      const meta = JSON.parse(await readFile(v2MetaPath, "utf-8")) as { title?: string };
      if (meta.title) return meta.title;
    } catch {
      // ignore malformed meta — fall through
    }
  }
  return fallback;
}

async function mostRecentMtime(projectPath: string): Promise<number> {
  // Look at the project root + a few key children to pick the newest mtime.
  const candidates = [
    projectPath,
    path.join(projectPath, "shorts", "plan.json"),
    path.join(projectPath, "shorts"),
    path.join(projectPath, "analysis", "moments.json"),
    path.join(projectPath, "transcript.json"),
  ];
  let best = 0;
  for (const c of candidates) {
    try {
      const s = await stat(c);
      if (s.mtimeMs > best) best = s.mtimeMs;
    } catch { /* missing path is fine */ }
  }
  return best;
}

export async function sourceVideoPath(projectPath: string): Promise<string> {
  const root = await resolveProject(projectPath);
  // v2 video subprojects keep the working video as <root>/video.<ext>.
  // Try that first so suggest/analyze/plan-builder/shorts work
  // unchanged on per-video subprojects.
  for (const ext of [".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi"]) {
    const p = path.join(root, `video${ext}`);
    if (existsSync(p)) return p;
  }
  const sourceDir = path.join(root, "source");
  const files = await readdir(sourceDir);
  const f = files.find((x) => /^source\.(mp4|webm|mkv|mov|m4v)$/i.test(x));
  if (!f) throw new Error(`no source video in ${sourceDir}`);
  return path.join(sourceDir, f);
}
