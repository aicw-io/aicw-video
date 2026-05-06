import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolveProject } from "./projectFolder.js";
import { extractAudio } from "./audio.js";
import { runProc } from "./run.js";

const DEFAULT_MODEL_URL =
  "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin";

function modelPath(): string {
  return (
    process.env.AICW_VIDEO_WHISPER_MODEL ||
    path.join(os.homedir(), ".cache", "aicw-video", "ggml-base.en.bin")
  );
}

async function ensureModel(): Promise<string> {
  const m = modelPath();
  if (existsSync(m)) return m;
  if (process.env.AICW_VIDEO_WHISPER_MODEL) {
    throw new Error(`AICW_VIDEO_WHISPER_MODEL points to ${m} but it does not exist`);
  }
  await mkdir(path.dirname(m), { recursive: true });
  process.stderr.write(`downloading whisper model to ${m} (one-time, ~140MB)...\n`);
  await runProc("curl", ["-L", "--fail", "-o", m, DEFAULT_MODEL_URL]);
  return m;
}

export async function transcribe(
  projectPath: string,
): Promise<{ json: string; srt: string; words: string }> {
  const root = await resolveProject(projectPath);
  const audio = path.join(root, "audio.wav");
  if (!existsSync(audio)) await extractAudio(projectPath);
  const model = await ensureModel();
  const whisper = process.env.WHISPER_PATH || "whisper-cli";

  // Pass 1: sentence-level segmentation → transcript.json + transcript.srt
  const outBase = path.join(root, "transcript");
  await runProc(whisper, ["-m", model, "-f", audio, "-oj", "-osrt", "-of", outBase]);

  // Pass 2: -ml 1 forces one whisper segment per word, giving word-level timing.
  // Used by the karaoke caption style and any future word-aligned animations.
  const wordsBase = path.join(root, "transcript.words");
  await runProc(whisper, ["-m", model, "-f", audio, "-oj", "-of", wordsBase, "-ml", "1"]);
  // Reformat whisper.cpp's verbose JSON into a clean [{startMs,endMs,text}] array.
  const wordsPath = `${wordsBase}.json`;
  const raw = JSON.parse(await readFile(wordsPath, "utf8"));
  const words = (raw.transcription ?? [])
    .map((s: { offsets?: { from?: number; to?: number }; text?: string }) => ({
      startMs: s.offsets?.from ?? 0,
      endMs: s.offsets?.to ?? 0,
      text: (s.text ?? "").trim(),
    }))
    .filter((w: { text: string }) => w.text);
  await writeFile(wordsPath, JSON.stringify(words, null, 2));

  return { json: `${outBase}.json`, srt: `${outBase}.srt`, words: wordsPath };
}
