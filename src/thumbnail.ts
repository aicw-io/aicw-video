import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { resolveProject, sourceVideoPath } from "./projectFolder.js";
import { runProc } from "./run.js";
import { PlanSchema, targetDims, type Clip, type Plan } from "./shorts.js";

export async function renderThumbnail(projectPath: string, clipId: string): Promise<string> {
  const { root, plan } = await loadPlan(projectPath);
  const idx = plan.clips.findIndex((c) => c.id === clipId);
  if (idx < 0) throw new Error(`no clip with id '${clipId}' in plan`);
  return renderThumbnailAt(root, plan.clips[idx]!, idx + 1);
}

export async function renderAllThumbnails(projectPath: string): Promise<string[]> {
  const { root, plan } = await loadPlan(projectPath);
  const out: string[] = [];
  for (let i = 0; i < plan.clips.length; i++) {
    out.push(await renderThumbnailAt(root, plan.clips[i]!, i + 1));
  }
  return out;
}

async function loadPlan(projectPath: string): Promise<{ root: string; plan: Plan }> {
  const root = await resolveProject(projectPath);
  const file = path.join(root, "shorts", "plan.json");
  if (!existsSync(file)) throw new Error(`no shorts/plan.json in ${root}`);
  const plan = PlanSchema.parse(JSON.parse(await readFile(file, "utf8")));
  return { root, plan };
}

async function renderThumbnailAt(root: string, clip: Clip, num: number): Promise<string> {
  const src = await sourceVideoPath(root);
  const dir = path.join(root, "shorts");
  await mkdir(dir, { recursive: true });
  const baseName = `${String(num).padStart(2, "0")}-${slug(clip.title)}-thumb`;
  const outPath = path.join(dir, `${baseName}.jpg`);
  const assPath = path.join(dir, `${baseName}.ass`);

  const dims = targetDims(clip.aspect_ratio);
  await writeFile(assPath, buildThumbnailAss(clip.title, dims));

  // Pick midpoint frame; fast input-side seek + single-frame output.
  const midSec = (((clip.start_ms + clip.end_ms) / 2) / 1000).toFixed(3);
  const filterComplex = buildThumbnailFilter(clip, dims, assPath);

  const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
  await runProc(ffmpeg, [
    "-y",
    "-ss", midSec, "-i", src,
    "-filter_complex", filterComplex,
    "-map", "[v]",
    "-frames:v", "1",
    "-c:v", "mjpeg",
    "-pix_fmt", "yuvj420p",
    "-q:v", "2",
    "-threads:v", "1",
    "-strict", "-2",
    "-f", "image2",
    outPath,
  ]);
  return outPath;
}

function buildThumbnailFilter(clip: Clip, dims: { w: number; h: number }, assPath: string): string {
  const sub = `subtitles=${escapeFilterPath(assPath)}`;
  if (clip.reframe === "letterbox-blur") {
    return (
      `[0:v]split[bg][fg];` +
      `[bg]scale=${dims.w}:${dims.h}:force_original_aspect_ratio=increase,crop=${dims.w}:${dims.h},boxblur=20:5[bgb];` +
      `[fg]scale=${dims.w}:${dims.h}:force_original_aspect_ratio=decrease[fgs];` +
      `[bgb][fgs]overlay=(W-w)/2:(H-h)/2,${sub}[v]`
    );
  }
  const x = clip.crop_x_norm ?? 0.5;
  const ratios: Record<string, [number, number]> = {
    "9:16": [9, 16],
    "1:1": [1, 1],
    "4:5": [4, 5],
    "16:9": [16, 9],
  };
  const [w, h] = ratios[clip.aspect_ratio] ?? ratios["9:16"]!;
  const cw = `min(iw,ih*${w}/${h})`;
  const ch = `min(ih,iw*${h}/${w})`;
  const cx = `max(0,min(iw-${cw},iw*${x}-${cw}/2))`;
  const cy = `(ih-${ch})/2`;
  return `[0:v]crop='${cw}':'${ch}':'${cx}':'${cy}',scale=${dims.w}:${dims.h},${sub}[v]`;
}

function buildThumbnailAss(title: string, dims: { w: number; h: number }): string {
  // Yellow huge bold text, thick black outline, alignment 5 = middle-center.
  const fontsize = dims.h >= 1920 ? 130 : dims.h >= 1350 ? 110 : 90;
  const style = `Arial,${fontsize},&H0000FFFF,&H000000FF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,12,4,5,80,80,0,1`;
  const safe = title.replace(/[{}]/g, "").replace(/\n/g, "\\N");
  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${dims.w}
PlayResY: ${dims.h}

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${style}

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:10.00,Default,,0,0,0,,${safe}
`;
}

function escapeFilterPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

function slug(s: string): string {
  const out = s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50);
  return out || "clip";
}
