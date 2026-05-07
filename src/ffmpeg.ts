import { execFile } from "node:child_process";
import { existsSync } from "node:fs";

export interface VideoInfo {
  durationMs: number;
  width: number;
  height: number;
}

const HOMEBREW_FFMPEG_FULL_BINS = [
  "/opt/homebrew/opt/ffmpeg-full/bin",
  "/usr/local/opt/ffmpeg-full/bin",
];

export function getFfprobePath(): string {
  const override = process.env.FFPROBE_PATH?.trim();
  if (override) return override;
  return firstExistingTool("ffprobe") ?? "ffprobe";
}

export function getFfmpegPath(): string {
  const override = process.env.FFMPEG_PATH?.trim();
  if (override) return override;
  return firstExistingTool("ffmpeg") ?? "ffmpeg";
}

export async function resolveFfmpegPath(
  opts: { requiredFilters?: string[] } = {},
): Promise<string> {
  const requiredFilters = [...new Set((opts.requiredFilters ?? []).map((f) => f.trim()).filter(Boolean))];
  if (requiredFilters.length === 0) return getFfmpegPath();

  const candidates = ffmpegCandidatePaths();
  const failures: string[] = [];
  for (const candidate of candidates) {
    const missing: string[] = [];
    for (const filter of requiredFilters) {
      if (!(await ffmpegSupportsFilter(candidate, filter))) missing.push(filter);
    }
    if (missing.length === 0) return candidate;
    failures.push(`${candidate} missing ${missing.join(", ")}`);
  }

  const filters = requiredFilters.join(", ");
  const hint = process.platform === "darwin"
    ? "Install Homebrew ffmpeg-full, or set FFMPEG_PATH to an ffmpeg build compiled with libass/subtitles support."
    : "Install an ffmpeg build compiled with libass/subtitles support, or set FFMPEG_PATH to that binary.";
  const checked = failures.length > 0 ? ` Checked: ${failures.join("; ")}.` : "";
  throw new Error(`No usable ffmpeg found for caption rendering; required filter(s): ${filters}. ${hint}${checked}`);
}

const filterSupportCache = new Map<string, Promise<boolean>>();

export function ffmpegSupportsFilter(ffmpegPath: string, filter: string): Promise<boolean> {
  const key = `${ffmpegPath}\0${filter}`;
  let cached = filterSupportCache.get(key);
  if (!cached) {
    cached = probeFfmpegFilter(ffmpegPath, filter);
    filterSupportCache.set(key, cached);
  }
  return cached;
}

function firstExistingTool(name: "ffmpeg" | "ffprobe"): string | undefined {
  for (const binDir of HOMEBREW_FFMPEG_FULL_BINS) {
    const candidate = `${binDir}/${name}`;
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function ffmpegCandidatePaths(): string[] {
  const override = process.env.FFMPEG_PATH?.trim();
  if (override) return [override];
  const candidates = [
    ...HOMEBREW_FFMPEG_FULL_BINS.map((binDir) => `${binDir}/ffmpeg`),
    "ffmpeg",
    "/opt/homebrew/bin/ffmpeg",
    "/usr/local/bin/ffmpeg",
  ];
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    if (candidate.startsWith("/") && !existsSync(candidate)) return false;
    if (seen.has(candidate)) return false;
    seen.add(candidate);
    return true;
  });
}

async function probeFfmpegFilter(ffmpegPath: string, filter: string): Promise<boolean> {
  try {
    const { stdout, stderr } = await runText(ffmpegPath, ["-hide_banner", "-h", `filter=${filter}`], 5_000);
    const output = `${stdout}\n${stderr}`;
    return !/(Unknown filter|No such filter|Filter not found)/i.test(output) &&
      new RegExp(`\\b${escapeRegExp(filter)}\\b`, "i").test(output);
  } catch {
    return false;
  }
}

function run(
  cmd: string,
  args: string[],
  timeoutMs: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const proc = execFile(
      cmd,
      args,
      { encoding: "buffer", maxBuffer: 50 * 1024 * 1024, timeout: timeoutMs },
      (error, stdout) => {
        if (error) {
          reject(new Error(`${cmd} failed: ${(error as Error).message}`));
          return;
        }
        resolve(stdout);
      },
    );
    proc.stdin?.end();
  });
}

function runText(
  cmd: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = execFile(
      cmd,
      args,
      { encoding: "utf8", maxBuffer: 1024 * 1024, timeout: timeoutMs },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`${cmd} failed: ${(error as Error).message}`));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
    proc.stdin?.end();
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function getVideoInfo(videoPath: string): Promise<VideoInfo> {
  const args = [
    "-v",
    "quiet",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    "-select_streams",
    "v:0",
    videoPath,
  ];
  const stdout = await run(getFfprobePath(), args, 10_000);
  const data = JSON.parse(stdout.toString("utf-8"));

  const stream = data.streams?.[0];
  const format = data.format;

  if (!stream) {
    throw new Error("No video stream found");
  }

  let width = stream.width as number;
  let height = stream.height as number;
  const rotation = readRotation(stream);
  if (Math.abs(rotation) % 180 === 90) {
    [width, height] = [height, width];
  }

  let durationMs: number;
  if (stream.duration) {
    durationMs = Math.round(parseFloat(stream.duration) * 1000);
  } else if (format?.duration) {
    durationMs = Math.round(parseFloat(format.duration) * 1000);
  } else {
    throw new Error("Could not determine video duration");
  }

  return { durationMs, width, height };
}

function readRotation(stream: unknown): number {
  if (!stream || typeof stream !== "object") return 0;
  const s = stream as {
    tags?: { rotate?: unknown };
    side_data_list?: Array<{ rotation?: unknown }>;
  };
  const tagRotate = Number(s.tags?.rotate);
  if (Number.isFinite(tagRotate)) return tagRotate;
  for (const sideData of s.side_data_list ?? []) {
    const rotation = Number(sideData.rotation);
    if (Number.isFinite(rotation)) return rotation;
  }
  return 0;
}

export async function convertImage(
  inputPath: string,
  outputPath: string,
): Promise<void> {
  const args = ["-y", "-i", inputPath, "-frames:v", "1", outputPath];
  await run(getFfmpegPath(), args, 15_000);
}

export async function extractFrame(
  videoPath: string,
  timestampSec: number,
  format: "png" | "webp" = "png",
): Promise<Buffer> {
  const codec = format === "webp" ? "libwebp" : "png";
  const args = [
    "-i",
    videoPath,
    "-ss",
    String(timestampSec),
    "-frames:v",
    "1",
    "-f",
    "image2pipe",
    "-vcodec",
    codec,
    ...(format === "webp" ? ["-lossless", "1"] : []),
    "-",
  ];
  return run(getFfmpegPath(), args, 30_000);
}

export interface ExtractFrameToFileOpts {
  /** Cap the long edge of the output (preserves aspect). Omit for native resolution. */
  maxLongEdge?: number;
  /** webp/jpeg quality (1-100). */
  quality?: number;
}

/**
 * Extract a single frame and write it to disk. Codec is inferred from the
 * output extension (.png, .webp, .jpg). Uses input-side seek (`-ss` before
 * `-i`) for fast extraction.
 */
export async function extractFrameToFile(
  videoPath: string,
  timestampSec: number,
  outPath: string,
  opts: ExtractFrameToFileOpts = {},
): Promise<void> {
  const filters: string[] = [];
  if (opts.maxLongEdge && opts.maxLongEdge > 0) {
    const m = opts.maxLongEdge;
    filters.push(
      `scale='if(gt(iw,ih),min(${m},iw),-2)':'if(gt(iw,ih),-2,min(${m},ih))'`,
    );
  }
  const isJpeg = /\.(jpe?g)$/i.test(outPath);
  if (isJpeg) filters.push("format=yuvj420p");
  const args = [
    "-y",
    "-ss",
    String(timestampSec),
    "-i",
    videoPath,
    "-frames:v",
    "1",
    ...(filters.length ? ["-vf", filters.join(",")] : []),
    ...(isJpeg
      ? [
          "-c:v", "mjpeg",
          "-pix_fmt", "yuvj420p",
          "-q:v", String(opts.quality ? Math.max(2, Math.round((100 - opts.quality) / 8)) : 4),
          "-threads:v", "1",
          "-strict", "-2",
          "-f", "image2",
        ]
      : opts.quality ? ["-quality", String(opts.quality)] : []),
    outPath,
  ];
  await run(getFfmpegPath(), args, 30_000);
}
