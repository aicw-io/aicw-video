import { execFile } from "node:child_process";

export interface VideoInfo {
  durationMs: number;
  width: number;
  height: number;
}

function getFfprobePath(): string {
  return process.env.FFPROBE_PATH || "ffprobe";
}

function getFfmpegPath(): string {
  return process.env.FFMPEG_PATH || "ffmpeg";
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
