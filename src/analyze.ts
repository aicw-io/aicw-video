import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { resolveProject, sourceVideoPath } from "./projectFolder.js";
import { extractAudio } from "./audio.js";
import { transcribe } from "./transcribe.js";
import { runProc } from "./run.js";
import { cleanupTranscriptText } from "./transcript-text.js";

export type Moment = {
  index: number;
  ts_ms: number;
  frame: string;
  original_text?: string;
  transcript_text?: string;
  source: "scene" | "interval";
};

export type Analysis = {
  version: 1;
  created_at: string;
  source_duration_ms: number;
  source_video: string;
  has_audio: boolean;
  moments: Moment[];
};

export async function analyzeVideo(
  projectPath: string,
  opts: { force?: boolean; intervalSec?: number; transcribe?: boolean } = {},
): Promise<{ analysis: Analysis; cached: boolean }> {
  const root = await resolveProject(projectPath);
  const src = await sourceVideoPath(projectPath);

  const analysisDir = path.join(root, "analysis");
  const keyframesDir = path.join(analysisDir, "keyframes");
  await mkdir(keyframesDir, { recursive: true });
  const outPath = path.join(analysisDir, "moments.json");

  if (existsSync(outPath) && !opts.force) {
    return { analysis: JSON.parse(await readFile(outPath, "utf8")), cached: true };
  }

  const duration = await probeDurationMs(src);
  const hasAudio = await streamHas(src, "a");

  // Run transcribe up front when audio is present and no transcript exists.
  if (hasAudio && opts.transcribe !== false) {
    const transcriptPath = path.join(root, "transcript.json");
    if (!existsSync(transcriptPath)) {
      try { await extractAudioIfMissing(root, projectPath); await transcribe(projectPath); } catch { /* keep going without transcript */ }
    }
  }

  // Detect scene changes (works even without audio)
  const sceneSeconds = await detectScenes(src);
  const sceneTs = sceneSeconds.map((s) => Math.round(s * 1000));

  // Add interval-based timestamps so silent / scene-poor videos still get coverage
  const interval = (opts.intervalSec ?? 8) * 1000;
  const intervalTs: number[] = [];
  for (let t = 0; t < duration; t += interval) intervalTs.push(t);

  // Merge and dedupe within 1s window
  const merged: Array<{ ts: number; source: "scene" | "interval" }> = [
    ...sceneTs.map((ts) => ({ ts, source: "scene" as const })),
    ...intervalTs.map((ts) => ({ ts, source: "interval" as const })),
  ].sort((a, b) => a.ts - b.ts);
  const filtered: typeof merged = [];
  for (const m of merged) {
    const last = filtered[filtered.length - 1];
    if (last && m.ts - last.ts < 1000) continue;
    if (m.ts < 0 || m.ts > duration) continue;
    filtered.push(m);
  }

  // Extract one keyframe per timestamp
  const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
  const moments: Moment[] = [];
  for (let i = 0; i < filtered.length; i++) {
    const m = filtered[i]!;
    const frameRel = `analysis/keyframes/frame-${String(i + 1).padStart(3, "0")}-${m.ts}ms.webp`;
    const framePath = path.join(root, frameRel);
    await runProc(ffmpeg, [
      "-y", "-ss", (m.ts / 1000).toFixed(3), "-i", src,
      "-frames:v", "1", "-vf", "scale='min(1280,iw)':-1",
      "-q:v", "75", framePath,
    ]);
    moments.push({ index: i + 1, ts_ms: m.ts, frame: frameRel, source: m.source });
  }

  // Pair with transcript text
  const transcriptPath = path.join(root, "transcript.json");
  if (existsSync(transcriptPath)) {
    try {
      const t = JSON.parse(await readFile(transcriptPath, "utf8"));
      for (const m of moments) {
        for (const s of t.transcription ?? []) {
          const a = s.offsets?.from ?? 0;
          const b = s.offsets?.to ?? a;
          if (m.ts_ms >= a && m.ts_ms < b) {
            const txt = (s.text ?? "").trim();
            if (txt) {
              m.original_text = txt;
              m.transcript_text = cleanupTranscriptText(txt);
            }
            break;
          }
        }
      }
    } catch { /* malformed transcript — skip pairing */ }
  }

  const analysis: Analysis = {
    version: 1,
    created_at: new Date().toISOString(),
    source_duration_ms: duration,
    source_video: path.relative(root, src),
    has_audio: hasAudio,
    moments,
  };

  await writeFile(outPath, JSON.stringify(analysis, null, 2));
  return { analysis, cached: false };
}

async function extractAudioIfMissing(root: string, projectPath: string): Promise<void> {
  if (!existsSync(path.join(root, "audio.wav"))) await extractAudio(projectPath);
}

// Pick N moments with even temporal coverage; prefer scene-cut sources within
// each bucket. Used by sampling tools to reduce a long moments list to a
// representative subset.
export function pickEvenMoments(moments: Moment[], n: number): Moment[] {
  if (moments.length <= n) return [...moments];
  const last = moments[moments.length - 1]!.ts_ms;
  const buckets: Moment[][] = Array.from({ length: n }, () => []);
  for (const m of moments) {
    const idx = Math.min(n - 1, Math.floor((m.ts_ms / Math.max(1, last)) * n));
    buckets[idx]!.push(m);
  }
  const picked: Moment[] = [];
  for (const b of buckets) {
    if (b.length === 0) continue;
    const scene = b.find((m) => m.source === "scene");
    picked.push(scene ?? b[0]!);
  }
  return picked.sort((a, b) => a.ts_ms - b.ts_ms);
}

async function probeDurationMs(videoPath: string): Promise<number> {
  const ffprobe = process.env.FFPROBE_PATH || "ffprobe";
  return new Promise((resolve, reject) => {
    let out = "";
    const p = spawn(ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "default=nokey=1:noprint_wrappers=1", videoPath], { stdio: ["ignore", "pipe", "ignore"] });
    p.stdout.on("data", (d) => { out += d.toString(); });
    p.on("error", reject);
    p.on("exit", (code) => {
      if (code !== 0) reject(new Error(`ffprobe exited ${code}`));
      else resolve(Math.round(parseFloat(out.trim()) * 1000));
    });
  });
}

async function streamHas(videoPath: string, streamSpec: "a" | "v"): Promise<boolean> {
  const ffprobe = process.env.FFPROBE_PATH || "ffprobe";
  return new Promise((resolve) => {
    let out = "";
    const p = spawn(ffprobe, ["-v", "error", "-select_streams", streamSpec, "-show_entries", "stream=index", "-of", "csv=p=0", videoPath], { stdio: ["ignore", "pipe", "ignore"] });
    p.stdout.on("data", (d) => { out += d.toString(); });
    p.on("error", () => resolve(false));
    p.on("exit", () => resolve(out.trim().length > 0));
  });
}

async function detectScenes(videoPath: string): Promise<number[]> {
  const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
  return new Promise((resolve) => {
    let err = "";
    const p = spawn(ffmpeg, ["-i", videoPath, "-filter:v", "select='gt(scene,0.4)',showinfo", "-f", "null", "-"], { stdio: ["ignore", "ignore", "pipe"] });
    p.stderr.on("data", (d) => { err += d.toString(); });
    p.on("error", () => resolve([]));
    p.on("exit", () => {
      const re = /pts_time:(\d+\.\d+)/g;
      const times: number[] = [];
      let m: RegExpExecArray | null;
      while ((m = re.exec(err)) !== null) times.push(parseFloat(m[1]!));
      resolve(times);
    });
  });
}
