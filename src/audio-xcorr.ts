import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runProc } from "./run.js";
import { getFfmpegPath } from "./ffmpeg.js";

// Cross-correlation refinement of transcript-based offsets.
//
// Given a rough offset from word-boundary matching (~70 ms precision), we
// cross-correlate the *actual audio envelopes* of short slices around
// each anchor to push precision to ~5-10 ms. The output samples can then
// be median-filtered for a static offset, or linear-fit to detect drift.
//
// All math is time-domain on a 100 Hz envelope (10 ms/sample). For a
// 1.5-second slice that's 150 samples; correlating over ±300 ms = 30
// lags = 4500 ops per anchor — trivial in JS, no FFT needed.

const ENVELOPE_HZ = 100; // 10 ms per envelope sample
const SLICE_SECONDS = 1.5;
const SEARCH_MS = 300; // ± search window around the rough offset

export type XcorrSample = {
  videoTimeMs: number;
  refinedOffsetMs: number;
  correlation: number; // 0..1 — how confident this anchor is
};

export async function refineAnchorOffsets(
  anchorVideoTimes: number[], // ms in the video timeline
  anchorExternalTimes: number[], // ms in the external timeline (under rough offset)
  videoSrc: string,
  externalSrc: string,
  roughOffsetMs: number,
): Promise<XcorrSample[]> {
  if (anchorVideoTimes.length !== anchorExternalTimes.length) {
    throw new Error("anchor arrays must have equal length");
  }
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "aicw-xcorr-"));
  const samples: XcorrSample[] = [];
  try {
    for (let i = 0; i < anchorVideoTimes.length; i++) {
      const vCenter = anchorVideoTimes[i]! / 1000;
      const eCenter = anchorExternalTimes[i]! / 1000;
      // Extract a slice symmetrically around each anchor center. Skip
      // anchors too close to the recording boundary to fit a clean slice.
      const vStart = vCenter - SLICE_SECONDS / 2;
      const eStart = eCenter - SLICE_SECONDS / 2;
      if (vStart < 0 || eStart < 0) continue;
      const vWavPath = path.join(tmpDir, `v-${i}.wav`);
      const eWavPath = path.join(tmpDir, `e-${i}.wav`);
      await extractMonoWavSlice(videoSrc, vStart, SLICE_SECONDS, vWavPath);
      await extractMonoWavSlice(externalSrc, eStart, SLICE_SECONDS, eWavPath);
      const vEnv = await wavToEnvelope(vWavPath);
      const eEnv = await wavToEnvelope(eWavPath);
      if (vEnv.length === 0 || eEnv.length === 0) continue;
      const { lagSamples, correlation } = xcorrPeak(
        vEnv,
        eEnv,
        Math.floor((SEARCH_MS / 1000) * ENVELOPE_HZ),
      );
      const lagMs = (lagSamples * 1000) / ENVELOPE_HZ;
      // Total refined offset = (rough offset that we used to align
      // extraction) + (additional lag the xcorr discovered).
      samples.push({
        videoTimeMs: anchorVideoTimes[i]!,
        refinedOffsetMs: roughOffsetMs + lagMs,
        correlation,
      });
    }
    return samples;
  } finally {
    try { await rm(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

// Extract a [start, start+duration] slice from `input` to a 16 kHz mono
// 16-bit PCM WAV. Fast: -ss before -i seeks, -t bounds duration.
async function extractMonoWavSlice(
  input: string,
  startSec: number,
  durationSec: number,
  outPath: string,
): Promise<void> {
  const ffmpeg = getFfmpegPath();
  await runProc(ffmpeg, [
    "-y",
    "-ss", startSec.toFixed(3),
    "-t", durationSec.toFixed(3),
    "-i", input,
    "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
    outPath,
  ]);
}

// Read a 16 kHz mono 16-bit PCM WAV, compute |sample| envelope downsampled
// to 100 Hz (one sample per 160 source samples). Returns a Float32Array
// of envelope magnitudes (un-normalised).
async function wavToEnvelope(wavPath: string): Promise<Float32Array> {
  const buf = await readFile(wavPath);
  // WAV header is typically 44 bytes — but if there's an extra chunk
  // (LIST, etc.) ffmpeg may write more. Find the 'data' chunk header.
  const dataIdx = findDataChunk(buf);
  if (dataIdx < 0) return new Float32Array(0);
  const dataStart = dataIdx + 8; // 'data' (4) + size (4)
  const samples = (buf.length - dataStart) / 2; // 16-bit
  if (samples <= 0) return new Float32Array(0);
  const envWindow = Math.floor(16000 / ENVELOPE_HZ); // 160
  const envLen = Math.floor(samples / envWindow);
  const env = new Float32Array(envLen);
  for (let e = 0; e < envLen; e++) {
    let sum = 0;
    const base = dataStart + e * envWindow * 2;
    for (let s = 0; s < envWindow; s++) {
      const v = buf.readInt16LE(base + s * 2);
      sum += Math.abs(v);
    }
    env[e] = sum / envWindow;
  }
  return env;
}

function findDataChunk(buf: Buffer): number {
  // RIFF...WAVE then chunks. Walk the chunks until we hit "data".
  let i = 12;
  while (i + 8 <= buf.length) {
    const id = buf.toString("ascii", i, i + 4);
    const size = buf.readUInt32LE(i + 4);
    if (id === "data") return i;
    i += 8 + size;
  }
  return -1;
}

// Time-domain cross-correlation between two envelope signals. Returns the
// lag (in samples) and a normalised correlation coefficient in [0, 1].
//
// Positive lag means the external envelope is delayed compared to the
// video envelope under the current rough offset — i.e. the rough offset
// trimmed too little; we should trim more.
function xcorrPeak(
  video: Float32Array,
  external: Float32Array,
  searchSamples: number,
): { lagSamples: number; correlation: number } {
  const n = Math.min(video.length, external.length);
  if (n === 0) return { lagSamples: 0, correlation: 0 };
  // Pre-compute means for normalised correlation.
  const vMean = mean(video, 0, n);
  const eMean = mean(external, 0, n);
  let bestLag = 0;
  let bestCorr = -Infinity;
  let bestNorm = 0;
  // For each candidate lag tau in [-searchSamples, +searchSamples], compute
  // sum_i (video[i] - vMean) * (external[i + tau] - eMean) over the valid
  // overlap region.
  for (let tau = -searchSamples; tau <= searchSamples; tau++) {
    let num = 0;
    let denomV = 0;
    let denomE = 0;
    const start = Math.max(0, -tau);
    const end = Math.min(n, n - tau);
    if (end - start < 8) continue;
    for (let i = start; i < end; i++) {
      const a = video[i]! - vMean;
      const b = external[i + tau]! - eMean;
      num += a * b;
      denomV += a * a;
      denomE += b * b;
    }
    const denom = Math.sqrt(denomV * denomE);
    const corr = denom > 0 ? num / denom : 0;
    if (corr > bestCorr) {
      bestCorr = corr;
      bestLag = tau;
      bestNorm = corr;
    }
  }
  return { lagSamples: bestLag, correlation: Math.max(0, bestNorm) };
}

function mean(arr: Float32Array, start: number, end: number): number {
  let s = 0;
  for (let i = start; i < end; i++) s += arr[i]!;
  return s / (end - start || 1);
}
