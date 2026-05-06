import { readdir } from "node:fs/promises";
import path from "node:path";
import { classifyFile, getOrTranscribeWords, type Word } from "./transcript-cache.js";
import { harvestAnchors } from "./transcript-match.js";

export type MatchScore = {
  audioPath: string;
  audioName: string;
  totalMatchedWords: number;
  anchorCount: number;
  longestAnchor: number;
};

export type VideoMatchResult = {
  videoPath: string;
  videoName: string;
  videoCachePath: string;
  best: MatchScore | null;
  allScores: MatchScore[];
};

export type MatchAudioReport = {
  folder: string;
  videos: VideoMatchResult[];
  unpairedAudios: string[];
};

// Scan a folder for video and audio files, transcribe each (cached on disk
// next to the source file as <basename>.video-to-text.json /
// <basename>.audio-to-text.json), and pair every video with its
// best-matching audio by counting shared phrases.
export async function matchAudioFiles(folderPath: string): Promise<MatchAudioReport> {
  const abs = path.resolve(folderPath);
  const entries = await readdir(abs, { withFileTypes: true });
  const videoPaths: string[] = [];
  const audioPaths: string[] = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (e.name.startsWith(".")) continue;
    const full = path.join(abs, e.name);
    const kind = classifyFile(full);
    if (kind === "video") videoPaths.push(full);
    else if (kind === "audio") audioPaths.push(full);
  }

  // Transcribe (or load cached) every file once. Done sequentially because
  // each whisper invocation already saturates one CPU; running in parallel
  // mostly causes contention.
  const videoTranscripts = new Map<string, Word[]>();
  for (const v of videoPaths) {
    process.stderr.write(`  transcribing video ${path.basename(v)}…\n`);
    videoTranscripts.set(v, await getOrTranscribeWords(v));
  }
  const audioTranscripts = new Map<string, Word[]>();
  for (const a of audioPaths) {
    process.stderr.write(`  transcribing audio ${path.basename(a)}…\n`);
    audioTranscripts.set(a, await getOrTranscribeWords(a));
  }

  // Score each (video, audio) pair by harvesting anchors and summing
  // matched word counts. Audio with the highest score wins for each video.
  const usedAudios = new Set<string>();
  const videoResults: VideoMatchResult[] = [];
  for (const v of videoPaths) {
    const vWords = videoTranscripts.get(v) ?? [];
    const scores: MatchScore[] = [];
    for (const a of audioPaths) {
      const aWords = audioTranscripts.get(a) ?? [];
      const anchors = harvestAnchors(vWords, aWords);
      const totalMatchedWords = anchors.reduce((sum, x) => sum + x.length, 0);
      const longestAnchor = anchors.reduce((m, x) => Math.max(m, x.length), 0);
      scores.push({
        audioPath: a,
        audioName: path.basename(a),
        totalMatchedWords,
        anchorCount: anchors.length,
        longestAnchor,
      });
    }
    scores.sort((x, y) => y.totalMatchedWords - x.totalMatchedWords);
    // Threshold: best score must beat the runner-up clearly AND have at
    // least 6 total matched words. This avoids confidently mis-pairing
    // when the videos contain different scenes that share filler words.
    const top = scores[0];
    const runnerUp = scores[1];
    const passesAbsolute = top && top.totalMatchedWords >= 6;
    const passesRelative = !runnerUp || top!.totalMatchedWords >= runnerUp.totalMatchedWords + 3;
    const best = passesAbsolute && passesRelative ? top : null;
    if (best) usedAudios.add(best.audioPath);
    videoResults.push({
      videoPath: v,
      videoName: path.basename(v),
      videoCachePath: v.replace(/\.[^.]+$/, "") + ".video-to-text.json",
      best,
      allScores: scores,
    });
  }

  const unpairedAudios = audioPaths
    .filter((a) => !usedAudios.has(a))
    .map((a) => path.basename(a));
  return { folder: abs, videos: videoResults, unpairedAudios };
}
