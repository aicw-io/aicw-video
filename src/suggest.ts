import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { resolveProject, sourceVideoPath } from "./projectFolder.js";
import { getFfmpegPath, getFfprobePath } from "./ffmpeg.js";

export type Suggestion = {
  id: string;
  start_ms: number;
  end_ms: number;
  title: string;
  reason: string;
  score: number;
};

export async function suggestClips(
  projectPath: string,
  opts: { count?: number; targetDurationSec?: number } = {},
): Promise<{ suggestions: Suggestion[]; outPath: string }> {
  const root = await resolveProject(projectPath);
  const count = opts.count ?? 5;
  const requestedWindowSecs = opts.targetDurationSec ?? 30;

  const src = await sourceVideoPath(root);
  const totalSeconds = Math.max(1, Math.floor((await probeDurationMs(src)) / 1000));
  const windowSecs = suggestionWindowSeconds(totalSeconds, requestedWindowSecs, count);

  // Speech density per 1-second bucket (from sentence-level transcript.json).
  const speechBuckets: number[] = new Array(totalSeconds).fill(0);
  const transcriptPath = path.join(root, "transcript.json");
  if (existsSync(transcriptPath)) {
    const t = JSON.parse(await readFile(transcriptPath, "utf8"));
    for (const seg of (t.transcription as Array<{ offsets?: { from?: number; to?: number }; text?: string }> | undefined) ?? []) {
      const start = seg.offsets?.from ?? 0;
      const end = seg.offsets?.to ?? start;
      const wc = (seg.text ?? "").trim().split(/\s+/).filter(Boolean).length;
      const sb = Math.floor(start / 1000);
      const eb = Math.min(totalSeconds - 1, Math.floor(end / 1000));
      const span = Math.max(1, eb - sb + 1);
      const wpb = wc / span;
      for (let b = sb; b <= eb; b++) speechBuckets[b]! += wpb;
    }
  }

  // Scene-cut count per 1-second bucket (from ffmpeg select=gt(scene,0.4) showinfo).
  const sceneBuckets: number[] = new Array(totalSeconds).fill(0);
  for (const sec of await detectScenes(src)) {
    const b = Math.floor(sec);
    if (b < totalSeconds) sceneBuckets[b]! += 1;
  }

  // Score every 1-second-step sliding window.
  type Cand = Suggestion & { _speech: number; _scene: number };
  const cands: Cand[] = [];
  for (let s = 0; s + windowSecs <= totalSeconds; s++) {
    const sp = sumRange(speechBuckets, s, s + windowSecs);
    const sc = sumRange(sceneBuckets, s, s + windowSecs);
    cands.push({
      id: `c${s}`,
      start_ms: s * 1000,
      end_ms: (s + windowSecs) * 1000,
      title: `Suggested clip @ ${formatTime(s)}`,
      reason: "",
      score: 0,
      _speech: sp,
      _scene: sc,
    });
  }
  if (cands.length === 0) throw new Error("no candidate windows produced");

  const maxSp = Math.max(1, ...cands.map((c) => c._speech));
  const maxSc = Math.max(1, ...cands.map((c) => c._scene));
  for (const c of cands) {
    c.score = 0.6 * (c._speech / maxSp) + 0.4 * (c._scene / maxSc);
    c.reason = `${c._speech.toFixed(0)} words / ${windowSecs}s, ${c._scene} scene cut${c._scene === 1 ? "" : "s"}`;
  }

  // Greedy pick top-N non-overlapping.
  cands.sort((a, b) => b.score - a.score);
  const picked: Suggestion[] = [];
  for (const c of cands) {
    if (picked.length >= count) break;
    if (picked.some((p) => overlaps(p, c))) continue;
    picked.push({ id: c.id, start_ms: c.start_ms, end_ms: c.end_ms, title: c.title, reason: c.reason, score: c.score });
  }
  picked.sort((a, b) => a.start_ms - b.start_ms);
  picked.forEach((p, i) => { p.id = `clip_${String(i + 1).padStart(2, "0")}`; });

  const dir = path.join(root, "shorts");
  await mkdir(dir, { recursive: true });
  const outPath = path.join(dir, "suggestions.json");
  await writeFile(outPath, JSON.stringify({ clips: picked }, null, 2));
  return { suggestions: picked, outPath };
}

function suggestionWindowSeconds(totalSeconds: number, requestedWindowSecs: number, count: number): number {
  const requested = Math.max(1, Math.floor(requestedWindowSecs));
  const targetCount = Math.max(1, Math.floor(count));
  const maxWindow = Math.min(totalSeconds, requested);

  // A source shorter than the requested window is still useful. Use shorter
  // windows so the plan UI can show multiple reviewable clip ideas instead of
  // blocking the whole video.
  if (totalSeconds <= requested && targetCount > 1) {
    const minUsefulWindow = Math.min(5, totalSeconds);
    const denseWindow = Math.floor(totalSeconds / targetCount);
    if (denseWindow >= minUsefulWindow) return denseWindow;
    return minUsefulWindow;
  }

  return maxWindow;
}

function sumRange(a: number[], from: number, to: number): number {
  let s = 0;
  for (let i = from; i < to; i++) s += a[i] ?? 0;
  return s;
}

function overlaps(a: Suggestion, b: { start_ms: number; end_ms: number }): boolean {
  return !(a.end_ms <= b.start_ms || b.end_ms <= a.start_ms);
}

function formatTime(s: number): string {
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

async function probeDurationMs(videoPath: string): Promise<number> {
  const ffprobe = getFfprobePath();
  return new Promise((resolve, reject) => {
    let out = "";
    const p = spawn(
      ffprobe,
      ["-v", "error", "-show_entries", "format=duration", "-of", "default=nokey=1:noprint_wrappers=1", videoPath],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    p.stdout.on("data", (d) => { out += d.toString(); });
    p.on("error", reject);
    p.on("exit", (code) => {
      if (code !== 0) reject(new Error(`ffprobe exited ${code}`));
      else resolve(Math.round(parseFloat(out.trim()) * 1000));
    });
  });
}

async function detectScenes(videoPath: string): Promise<number[]> {
  const ffmpeg = getFfmpegPath();
  return new Promise((resolve, reject) => {
    let err = "";
    const p = spawn(
      ffmpeg,
      ["-i", videoPath, "-filter:v", "select='gt(scene,0.4)',showinfo", "-f", "null", "-"],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    p.stderr.on("data", (d) => { err += d.toString(); });
    p.on("error", reject);
    p.on("exit", () => {
      const re = /pts_time:(\d+\.\d+)/g;
      const times: number[] = [];
      let m: RegExpExecArray | null;
      while ((m = re.exec(err)) !== null) times.push(parseFloat(m[1]!));
      resolve(times);
    });
  });
}
