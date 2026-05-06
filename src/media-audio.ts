import { spawn } from "node:child_process";

export type AudioUsability = {
  hasAudioStream: boolean;
  hasUsableAudio: boolean;
  maxVolumeDb?: number;
  reason?: "no_audio_stream" | "silent_audio" | "unknown";
};

export async function probeAudioUsability(
  filePath: string,
  opts: { sampleSeconds?: number } = {},
): Promise<AudioUsability> {
  const hasAudioStream = await streamHasAudio(filePath);
  if (!hasAudioStream) {
    return { hasAudioStream: false, hasUsableAudio: false, reason: "no_audio_stream" };
  }

  const maxVolumeDb = await detectMaxVolumeDb(filePath, opts.sampleSeconds ?? 30);
  if (maxVolumeDb == null) {
    // Unknown should not block normal transcription. Let Whisper/ffmpeg try.
    return { hasAudioStream: true, hasUsableAudio: true, reason: "unknown" };
  }
  if (maxVolumeDb <= -60) {
    return { hasAudioStream: true, hasUsableAudio: false, maxVolumeDb, reason: "silent_audio" };
  }
  return { hasAudioStream: true, hasUsableAudio: true, maxVolumeDb };
}

async function streamHasAudio(filePath: string): Promise<boolean> {
  const ffprobe = process.env.FFPROBE_PATH || "ffprobe";
  const out = await runCapture(ffprobe, [
    "-v", "error",
    "-select_streams", "a:0",
    "-show_entries", "stream=index",
    "-of", "csv=p=0",
    filePath,
  ]);
  return out.code === 0 && out.stdout.trim().length > 0;
}

async function detectMaxVolumeDb(filePath: string, sampleSeconds: number): Promise<number | undefined> {
  const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
  const out = await runCapture(ffmpeg, [
    "-hide_banner",
    "-nostats",
    "-t", String(Math.max(1, sampleSeconds)),
    "-i", filePath,
    "-vn",
    "-af", "volumedetect",
    "-f", "null",
    "-",
  ]);
  const m = out.stderr.match(/max_volume:\s*(-?inf|-?\d+(?:\.\d+)?)\s*dB/i);
  if (!m) return undefined;
  if (m[1] === "-inf") return -Infinity;
  const n = parseFloat(m[1]!);
  return Number.isFinite(n) ? n : undefined;
}

function runCapture(
  cmd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => { stdout += d.toString(); });
    p.stderr.on("data", (d) => { stderr += d.toString(); });
    p.on("error", (e) => resolve({ stdout, stderr: e.message, code: 1 }));
    p.on("exit", (code) => resolve({ stdout, stderr, code: code ?? 0 }));
  });
}
