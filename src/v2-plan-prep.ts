import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { SourceDescription } from "./project-v2.js";
import { joinTranscriptWords } from "./transcript-text.js";

// Bridge a v2 video subproject (which stores transcript words inside
// video.json) into the v1 layout that suggest.ts and plan-builder.ts
// expect. Idempotent — only writes transcript.json when missing.
export async function prepareV2VideoForPlanning(
  videoSubprojectRoot: string,
  opts: { force?: boolean } = {},
): Promise<void> {
  const videoJsonPath = path.join(videoSubprojectRoot, "video.json");
  const transcriptPath = path.join(videoSubprojectRoot, "transcript.json");
  if (existsSync(transcriptPath) && !opts.force) return;
  if (!existsSync(videoJsonPath)) return;
  const desc = JSON.parse(await readFile(videoJsonPath, "utf-8")) as SourceDescription;
  const words = desc.transcript?.words ?? [];
  if (words.length === 0) return;
  const transcription = wordsToSegments(words);
  await writeFile(
    transcriptPath,
    JSON.stringify({ transcription }, null, 2),
  );
}

// Group words into sentence-ish segments. Splits on terminal punctuation
// or a word-gap > 600ms — mirrors what whisper's segment output usually
// looks like, close enough for caption bucketing.
function wordsToSegments(
  words: { startMs: number; endMs: number; text: string }[],
): Array<{ offsets: { from: number; to: number }; text: string }> {
  const out: Array<{ offsets: { from: number; to: number }; text: string }> = [];
  let buf: typeof words = [];
  const flush = (): void => {
    if (buf.length === 0) return;
    const text = joinTranscriptWords(buf);
    out.push({
      offsets: { from: buf[0]!.startMs, to: buf[buf.length - 1]!.endMs },
      text,
    });
    buf = [];
  };
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    buf.push(w);
    const next = words[i + 1];
    const ends = /[.!?]$/.test(w.text.trim());
    const gap = next ? next.startMs - w.endMs : 0;
    if (ends || gap > 600) flush();
  }
  flush();
  return out;
}
