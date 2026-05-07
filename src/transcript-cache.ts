import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { runProc } from "./run.js";
import { probeAudioUsability } from "./media-audio.js";
import { getFfmpegPath } from "./ffmpeg.js";

export type Word = { startMs: number; endMs: number; text: string };

const VIDEO_EXTS = new Set([".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi"]);
const AUDIO_EXTS = new Set([".m4a", ".mp3", ".wav", ".aac", ".flac", ".ogg", ".opus", ".aiff", ".aif"]);

export type FileKind = "audio" | "video";

export function classifyFile(filePath: string): FileKind | null {
  const ext = path.extname(filePath).toLowerCase();
  if (VIDEO_EXTS.has(ext)) return "video";
  if (AUDIO_EXTS.has(ext)) return "audio";
  return null;
}

// Where the cached transcript goes. Sits next to the source file:
//   IMG_6980.MOV       → IMG_6980.video-to-text.json
//   "Achajour 2.m4a"   → "Achajour 2.audio-to-text.json"
export function transcriptCachePath(filePath: string, kind?: FileKind): string {
  const k = kind ?? classifyFile(filePath);
  if (!k) throw new Error(`unrecognised media file: ${filePath}`);
  const base = filePath.replace(/\.[^.]+$/, "");
  return `${base}.${k}-to-text.json`;
}

// Load a cached transcript from <basename>.<kind>-to-text.json if it exists,
// otherwise transcribe via whisper, write the cache, and return the words.
// Both audio files and video files (their scratch audio) are supported —
// the WAV extraction is the same ffmpeg -vn pipeline.
export async function getOrTranscribeWords(
  filePath: string,
  opts: { skipAudioProbe?: boolean } = {},
): Promise<Word[]> {
  const kind = classifyFile(filePath);
  if (!kind) throw new Error(`unrecognised media file: ${filePath}`);
  const cachePath = transcriptCachePath(filePath, kind);
  if (existsSync(cachePath)) {
    try {
      const cached = JSON.parse(await readFile(cachePath, "utf-8")) as { words?: Word[] };
      if (Array.isArray(cached.words)) return cached.words;
    } catch { /* fall through and re-transcribe */ }
  }

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "aicw-transcribe-"));
  try {
    if (kind === "video" && !opts.skipAudioProbe) {
      const audio = await probeAudioUsability(filePath);
      if (!audio.hasUsableAudio) {
        await writeFile(
          cachePath,
          JSON.stringify(
            {
              source: path.basename(filePath),
              kind,
              words: [],
              audio,
              generatedAt: new Date().toISOString(),
            },
            null,
            2,
          ),
        );
        return [];
      }
    }
    const wav = path.join(tmpDir, "input.wav");
    await toMonoWav(filePath, wav);
    const words = await whisperWords(wav, tmpDir);
    await writeFile(
      cachePath,
      JSON.stringify(
        {
          source: path.basename(filePath),
          kind,
          words,
          generatedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
    return words;
  } finally {
    try { await runProc("rm", ["-rf", tmpDir]); } catch { /* best-effort */ }
  }
}

async function toMonoWav(input: string, out: string): Promise<void> {
  const ffmpeg = getFfmpegPath();
  await runProc(ffmpeg, [
    "-y", "-i", input,
    "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
    out,
  ]);
}

async function whisperWords(wavPath: string, tmpDir: string): Promise<Word[]> {
  const model =
    process.env.AICW_VIDEO_WHISPER_MODEL ||
    path.join(os.homedir(), ".cache", "aicw-video", "ggml-base.en.bin");
  if (!existsSync(model)) {
    throw new Error(
      `whisper model not found at ${model}. Run \`aicw-video transcribe\` once on any project to download it (~140MB), or set AICW_VIDEO_WHISPER_MODEL.`,
    );
  }
  const whisper = process.env.WHISPER_PATH || "whisper-cli";
  const outBase = path.join(tmpDir, "words");
  await runProc(whisper, ["-m", model, "-f", wavPath, "-oj", "-of", outBase, "-ml", "1"]);
  const raw = JSON.parse(await readFile(`${outBase}.json`, "utf8")) as {
    transcription?: Array<{ offsets?: { from?: number; to?: number }; text?: string }>;
  };
  return (raw.transcription ?? [])
    .map((s) => ({
      startMs: s.offsets?.from ?? 0,
      endMs: s.offsets?.to ?? 0,
      text: (s.text ?? "").trim(),
    }))
    .filter((w) => w.text.length > 0);
}

void mkdir; // suppress unused-import warning if helpers are tree-shaken
