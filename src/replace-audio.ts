import { mkdir, writeFile, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { resolveProject, sourceVideoPath } from "./projectFolder.js";
import { runProc } from "./run.js";
import { getOrTranscribeWords, type Word } from "./transcript-cache.js";
import { findMatchInRange, harvestAnchors, matchPhrase, type Anchor } from "./transcript-match.js";
import { refineAnchorOffsets, type XcorrSample } from "./audio-xcorr.js";

export type { Word, Anchor };

export interface ReplaceAudioResult {
  outPath: string;
  diagnosticsPath: string;
  offsetMs: number;
  matchedPhrase: string;
  matchedWordCount: number;
  matchConfidence: number;
}

// Replace a video's scratch audio with a separately-recorded external track.
// Alignment uses transcript-based matching: transcribe both, find the first
// phrase from the video's scratch audio inside the external recording, and
// use that timestamp as the offset. Robust across mics; produces a
// human-readable diagnostic JSON.
export async function replaceAudio(
  projectPath: string,
  externalAudioPath: string,
): Promise<ReplaceAudioResult> {
  if (!existsSync(externalAudioPath)) {
    throw new Error(`external audio not found: ${externalAudioPath}`);
  }
  const root = await resolveProject(projectPath);
  // v2 video subprojects keep the video as <root>/video.<ext>; v1 used
  // <root>/source/source.<ext>. Try v2 first, fall back to v1.
  let src: string;
  const v2Candidate = pickV2VideoFile(root);
  if (v2Candidate) {
    src = v2Candidate;
  } else {
    src = await sourceVideoPath(projectPath);
  }
  const outDir = path.join(root, "replace-audio");
  await mkdir(outDir, { recursive: true });

  const srcBase = path.basename(src, path.extname(src));
  const outPath = path.join(outDir, `${srcBase}-audio-replaced.mp4`);
  const diagnosticsPath = path.join(outDir, `${srcBase}-audio-replaced.json`);

  try {
    const videoWords = await getOrTranscribeWords(src);
    const externalWords = await getOrTranscribeWords(externalAudioPath);
    if (videoWords.length === 0) {
      throw new Error("video has no transcribable speech — can't align by phrase");
    }
    if (externalWords.length === 0) {
      throw new Error("external audio has no transcribable speech — can't align by phrase");
    }

    // Many-anchor alignment: walk both transcripts looking for every shared
    // phrase of ≥3 words. Each match contributes (length-1) per-word
    // boundary offsets — internal word boundaries are whisper's most
    // reliable timestamps. We then take the median across ALL samples to
    // resist whisper noise and outliers.
    const anchors: Anchor[] = harvestAnchors(videoWords, externalWords);
    if (anchors.length === 0 || anchors[0]!.length < 3) {
      const videoPreview = videoWords.slice(0, 12).map((w) => w.text).join(" ");
      const externalPreview = externalWords.slice(0, 30).map((w) => w.text).join(" ");
      throw new Error(
        `couldn't align this audio to this video — they don't appear to match.\n` +
          `Make sure the audio file is the recording for THIS video (not a different scene).\n\n` +
          `  what the video says first:    ${JSON.stringify(videoPreview)}\n` +
          `  what the external audio says: ${JSON.stringify(externalPreview)}\n\n` +
          `If you believe this is the right audio file, the offset between them may be too large to find a match — check that both recordings cover the same scene.`,
      );
    }

    const samples = collectOffsetSamples(anchors, videoWords, externalWords);
    const { median: rawMedian } = robustMedian(samples.map((s) => s.offsetMs));
    // Drop samples >100ms from the rough median, then take median of the
    // survivors — kills isolated outliers from whisper word-fragment noise.
    const clean = samples.filter((s) => Math.abs(s.offsetMs - rawMedian) <= 100);
    const finalSamples = clean.length >= 3 ? clean : samples;
    const { median: transcriptOffset, mad: transcriptMad } = robustMedian(
      finalSamples.map((s) => s.offsetMs),
    );

    // ─── Stage 2: refine with waveform cross-correlation ─────────────
    // Transcript-only alignment is precise to ~50-100ms (whisper word
    // timestamps quantise to model frame boundaries). Cross-correlating
    // the actual audio envelopes around each anchor pushes precision to
    // ~5-10ms, so single-offset alignment stops drifting end-to-end.
    process.stderr.write(`refining ${anchors.length} anchors with audio cross-correlation…\n`);
    const xcorrAnchorVideoTimes = anchors.map(
      (a) => videoWords[a.videoIdx + Math.floor(a.length / 2)]!.startMs,
    );
    const xcorrAnchorExternalTimes = anchors.map(
      (a) => externalWords[a.externalIdx + Math.floor(a.length / 2)]!.startMs,
    );
    let xcorrSamples: XcorrSample[] = [];
    try {
      xcorrSamples = await refineAnchorOffsets(
        xcorrAnchorVideoTimes,
        xcorrAnchorExternalTimes,
        src,
        externalAudioPath,
        transcriptOffset,
      );
    } catch (e) {
      process.stderr.write(
        `xcorr refinement failed (${e instanceof Error ? e.message : e}); falling back to transcript-only offset.\n`,
      );
    }
    // Keep only confident samples (correlation > 0.3).
    const confident = xcorrSamples.filter((s) => s.correlation > 0.3);
    const usableXcorr = confident.length >= 3 ? confident : xcorrSamples;
    const { median: refinedOffsetCandidate, mad: refinedMad } =
      usableXcorr.length > 0
        ? robustMedian(usableXcorr.map((s) => s.refinedOffsetMs))
        : { median: transcriptOffset, mad: transcriptMad };
    // Trust-but-verify: the transcript-anchored median is reliable
    // ground truth (≤ ~70 ms error). xcorr is great for sub-frame
    // refinement of an already-correct offset, but it CAN match the
    // wrong audio period when the recording has repeated phrases or
    // similar envelopes. If xcorr disagrees with transcript by more
    // than 150 ms, the transcript wins.
    const STATIC_TRUST_LIMIT_MS = 150;
    const xcorrDelta = Math.abs(refinedOffsetCandidate - transcriptOffset);
    const useXcorrStatic = xcorrDelta <= STATIC_TRUST_LIMIT_MS && usableXcorr.length >= 3;
    const refinedOffset = useXcorrStatic ? refinedOffsetCandidate : transcriptOffset;
    const offsetMs = Math.round(refinedOffset);
    if (!useXcorrStatic && xcorrDelta > STATIC_TRUST_LIMIT_MS) {
      process.stderr.write(
        `note: xcorr static offset (${Math.round(refinedOffsetCandidate)} ms) disagrees with transcript median (${Math.round(transcriptOffset)} ms) by ${Math.round(xcorrDelta)} ms — keeping transcript median, drift correction (if any) still applies.\n`,
      );
    }

    // Drift detection: be conservative. Only apply atempo when:
    //   1) we have ≥4 HIGH-correlation xcorr samples (correlation ≥ 0.5),
    //   2) those samples span ≥50% of the video duration,
    //   3) the linear fit's R² ≥ 0.4 (the slope actually explains the
    //      variance — otherwise it's just noise),
    //   4) |slope| ≥ 1 ms/sec.
    // If any check fails, atempo stays null. Better to keep audio at
    // native speed than to apply a phantom correction that desyncs an
    // already-aligned clip.
    const highConf = xcorrSamples.filter((s) => s.correlation >= 0.5);
    const videoDurationMs = Math.max(...xcorrSamples.map((s) => s.videoTimeMs), 1);
    const span =
      highConf.length > 0
        ? Math.max(...highConf.map((s) => s.videoTimeMs)) - Math.min(...highConf.map((s) => s.videoTimeMs))
        : 0;
    let drift_ms_per_sec: number | null = null;
    let drift_r_squared: number | null = null;
    if (highConf.length >= 4 && span >= videoDurationMs * 0.5) {
      const fit = linearFit(highConf.map((s) => s.videoTimeMs), highConf.map((s) => s.refinedOffsetMs));
      drift_ms_per_sec = fit.slope * 1000; // (ms / ms) → (ms / sec)
      drift_r_squared = fit.rSquared;
    } else {
      // Fall back to a non-fit slope estimate for diagnostics only.
      if (xcorrSamples.length >= 3) {
        const fit = linearFit(
          xcorrSamples.map((s) => s.videoTimeMs),
          xcorrSamples.map((s) => s.refinedOffsetMs),
        );
        drift_ms_per_sec = fit.slope * 1000;
        drift_r_squared = fit.rSquared;
      }
    }

    const ATEMPO_THRESHOLD_MS_PER_SEC = 1.0;
    const ATEMPO_R2_THRESHOLD = 0.4;
    let atempoFactor: number | null = null;
    if (
      drift_ms_per_sec !== null &&
      drift_r_squared !== null &&
      highConf.length >= 4 &&
      span >= videoDurationMs * 0.5 &&
      drift_r_squared >= ATEMPO_R2_THRESHOLD &&
      Math.abs(drift_ms_per_sec) >= ATEMPO_THRESHOLD_MS_PER_SEC
    ) {
      atempoFactor = 1 + drift_ms_per_sec / 1000;
      process.stderr.write(
        `note: detected ${drift_ms_per_sec.toFixed(2)} ms/sec drift (R²=${drift_r_squared.toFixed(2)}, ${highConf.length} high-conf samples) — applying atempo=${atempoFactor.toFixed(5)}.\n`,
      );
    } else if (drift_ms_per_sec !== null && Math.abs(drift_ms_per_sec) >= ATEMPO_THRESHOLD_MS_PER_SEC) {
      process.stderr.write(
        `note: ${drift_ms_per_sec.toFixed(2)} ms/sec slope detected but ${
          highConf.length < 4
            ? `only ${highConf.length} high-conf samples`
            : drift_r_squared !== null && drift_r_squared < ATEMPO_R2_THRESHOLD
              ? `linear fit too weak (R²=${drift_r_squared.toFixed(2)})`
              : "span too short"
        } — leaving audio rate unchanged.\n`,
      );
    }

    const usedAnchors = anchors.map((a, i) => ({
      phrase: matchPhrase(a, videoWords),
      videoTimeMs: videoWords[a.videoIdx]!.startMs,
      length: a.length,
      transcriptOffsetMs: anchorEnd(a, videoWords, externalWords).offsetMs,
      xcorrRefinedOffsetMs: xcorrSamples[i]?.refinedOffsetMs ?? null,
      xcorrCorrelation: xcorrSamples[i]?.correlation ?? null,
    }));
    const matchedPhrase = matchPhrase(anchors[0]!, videoWords);
    const matchedWordCount = anchors[0]!.length;

    await muxAlignedAudio(src, externalAudioPath, offsetMs, atempoFactor, outPath);

    const result: ReplaceAudioResult = {
      outPath,
      diagnosticsPath,
      offsetMs,
      matchedPhrase,
      matchedWordCount,
      matchConfidence: matchedWordCount / Math.min(12, videoWords.length),
    };
    await writeFile(
      diagnosticsPath,
      JSON.stringify(
        {
          ...result,
          transcriptOffsetMs: transcriptOffset,
          transcriptMad,
          xcorrSamplesUsed: usableXcorr.length,
          xcorrMad: refinedMad,
          drift_ms_per_sec,
          drift_r_squared,
          atempoFactor,
          anchors: usedAnchors,
          transcriptSamples: finalSamples,
          xcorrSamples,
          videoFirstWords: videoWords.slice(0, 12),
        },
        null,
        2,
      ),
    );
    return result;
  } catch (e) {
    throw e;
  }
}

// Swap the project's canonical source video for the audio-replaced version,
// backing up the original first.
export async function swapSourceToReplaced(projectPath: string): Promise<string> {
  const root = await resolveProject(projectPath);
  const src = await sourceVideoPath(projectPath);
  const srcBase = path.basename(src, path.extname(src));
  const candidate = path.join(root, "replace-audio", `${srcBase}-audio-replaced.mp4`);
  if (!existsSync(candidate)) {
    throw new Error(`no audio-replaced output in ${root}/replace-audio (run replace-audio first)`);
  }
  const { backupIfExists } = await import("./backup.js");
  await backupIfExists(src);
  const targetMp4 = path.join(path.dirname(src), "source.mp4");
  await copyFile(candidate, targetMp4);
  return targetMp4;
}

// ────────────────────────────── helpers ──────────────────────────────

// Per-word-boundary offset sample. Skipping word index 0 in each match
// (recording-onset start times in whisper are unreliable).
type OffsetSample = {
  phrase: string;
  videoTimeMs: number;
  externalTimeMs: number;
  offsetMs: number;
};
// v2 subproject layout: <root>/video.<ext>. Returns the absolute path
// or null. v1 layout is handled by sourceVideoPath() in projectFolder.ts.
function pickV2VideoFile(root: string): string | null {
  for (const ext of [".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi"]) {
    const p = path.join(root, `video${ext}`);
    if (existsSync(p)) return p;
  }
  return null;
}

function collectOffsetSamples(
  anchors: Anchor[],
  videoWords: Word[],
  externalWords: Word[],
): OffsetSample[] {
  const out: OffsetSample[] = [];
  for (const a of anchors) {
    for (let i = 1; i < a.length; i++) {
      const v = videoWords[a.videoIdx + i]!;
      const e = externalWords[a.externalIdx + i]!;
      out.push({
        phrase: v.text,
        videoTimeMs: v.startMs,
        externalTimeMs: e.startMs,
        offsetMs: e.startMs - v.startMs,
      });
    }
  }
  return out;
}

function robustMedian(values: number[]): { median: number; mad: number } {
  if (values.length === 0) return { median: 0, mad: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  const deviations = sorted.map((v) => Math.abs(v - median)).sort((a, b) => a - b);
  const mad = deviations[Math.floor(deviations.length / 2)]!;
  return { median, mad };
}

// Ordinary least-squares linear fit. Returns slope, intercept, and R²
// (coefficient of determination). R² near 1 means the line explains the
// variance; near 0 means the points are scattered around the mean and
// the slope is meaningless noise.
function linearFit(xs: number[], ys: number[]): { slope: number; intercept: number; rSquared: number } {
  const n = xs.length;
  if (n < 2) return { slope: 0, intercept: 0, rSquared: 0 };
  const xMean = xs.reduce((a, b) => a + b, 0) / n;
  const yMean = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let denX = 0;
  let totSS = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - xMean;
    const dy = ys[i]! - yMean;
    num += dx * dy;
    denX += dx * dx;
    totSS += dy * dy;
  }
  const slope = denX > 0 ? num / denX : 0;
  const intercept = yMean - slope * xMean;
  let resSS = 0;
  for (let i = 0; i < n; i++) {
    const predicted = slope * xs[i]! + intercept;
    resSS += (ys[i]! - predicted) ** 2;
  }
  const rSquared = totSS > 0 ? Math.max(0, 1 - resSS / totSS) : 0;
  return { slope, intercept, rSquared };
}

function anchorEnd(
  a: Anchor,
  videoWords: Word[],
  externalWords: Word[],
): { videoEndMs: number; externalEndMs: number; offsetMs: number } {
  const lastV = videoWords[a.videoIdx + a.length - 1]!.endMs;
  const lastE = externalWords[a.externalIdx + a.length - 1]!.endMs;
  return { videoEndMs: lastV, externalEndMs: lastE, offsetMs: lastE - lastV };
}

// Mux the original video stream with the (offset-trimmed or padded)
// external audio, output to mp4. -c:v copy means no video re-encode (fast).
async function muxAlignedAudio(
  videoSrc: string,
  externalAudio: string,
  offsetMs: number,
  atempoFactor: number | null,
  outPath: string,
): Promise<void> {
  const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
  // Build the audio filter chain:
  //   atrim/adelay → atempo (drift correction) → apad
  //   - offset > 0: external started after video, trim its front.
  //   - offset < 0: external started before video, pad silence in front.
  //   - atempo: stretch/compress to compensate for clock drift.
  //   - apad: pad tail with silence; -shortest keeps it to video length.
  const parts: string[] = [];
  if (offsetMs > 0) {
    parts.push(`atrim=start=${(offsetMs / 1000).toFixed(3)}`);
    parts.push("asetpts=PTS-STARTPTS");
  } else if (offsetMs < 0) {
    const padMs = -offsetMs;
    parts.push(`adelay=${padMs}|${padMs}`);
  }
  if (atempoFactor !== null && Math.abs(atempoFactor - 1) > 1e-5) {
    // atempo accepts factor in [0.5, 100]. For tiny corrections we're well
    // inside the range; no chaining needed.
    parts.push(`atempo=${atempoFactor.toFixed(6)}`);
  }
  parts.push("apad");
  const afilter = parts.join(",");
  await runProc(ffmpeg, [
    "-y",
    "-i", videoSrc,
    "-i", externalAudio,
    "-map", "0:v:0",
    "-map", "1:a:0",
    "-c:v", "copy",
    "-af", afilter,
    "-c:a", "aac", "-b:a", "192k",
    "-shortest",
    outPath,
  ]);
}
