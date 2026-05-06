import { mkdir, unlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { runProc } from "./run.js";

export type TtsVoice = {
  id: string;
  label: string;
  locale?: string;
};

export type TtsSynthesizeOptions = {
  voice?: string;
  outPath: string;
};

export type VoiceoverTrackEntry = {
  startMs: number;
  endMs?: number;
  text: string;
};

export type GenerateVoiceoverTrackOptions = {
  entries: VoiceoverTrackEntry[];
  durationMs: number;
  voice?: string;
  outPath: string;
  workDir?: string;
};

export interface TtsEngine {
  listVoices(): Promise<TtsVoice[]>;
  synthesizeToWav(text: string, opts: TtsSynthesizeOptions): Promise<void>;
}

const SAY_BIN = "/usr/bin/say";
export const DEFAULT_TTS_VOICE = "Samantha";

export const macosSayTtsEngine: TtsEngine = {
  async listVoices(): Promise<TtsVoice[]> {
    if (process.platform !== "darwin") return [];
    const out = await captureProcess(SAY_BIN, ["-v", "?"]);
    return out
      .split(/\r?\n/)
      .map(parseSayVoiceLine)
      .filter((v): v is TtsVoice => v != null);
  },

  async synthesizeToWav(text: string, opts: TtsSynthesizeOptions): Promise<void> {
    if (process.platform !== "darwin") {
      throw new Error("voice-over TTS currently requires macOS");
    }
    const clean = text.trim();
    if (!clean) throw new Error("voice-over is enabled, but this clip has no caption text to read");

    await mkdir(path.dirname(opts.outPath), { recursive: true });
    const textPath = `${opts.outPath}.txt`;
    const aiffPath = `${opts.outPath}.aiff`;
    await writeFile(textPath, clean, "utf-8");

    const sayArgs: string[] = [];
    const voice = (opts.voice && opts.voice.trim()) || DEFAULT_TTS_VOICE;
    sayArgs.push("-v", voice);
    sayArgs.push("-f", textPath, "-o", aiffPath);

    try {
      await runProc(SAY_BIN, sayArgs);
      await runProc(process.env.FFMPEG_PATH || "ffmpeg", [
        "-y",
        "-i", aiffPath,
        "-ac", "1",
        "-ar", "44100",
        "-c:a", "pcm_s16le",
        opts.outPath,
      ]);
    } finally {
      await unlink(textPath).catch(() => undefined);
      await unlink(aiffPath).catch(() => undefined);
    }
  },
};

export async function listTtsVoices(engine: TtsEngine = macosSayTtsEngine): Promise<TtsVoice[]> {
  return engine.listVoices();
}

export async function synthesizeTtsToWav(
  text: string,
  opts: TtsSynthesizeOptions,
  engine: TtsEngine = macosSayTtsEngine,
): Promise<void> {
  return engine.synthesizeToWav(text, opts);
}

export async function generateVoiceoverTrack(
  opts: GenerateVoiceoverTrackOptions,
  engine: TtsEngine = macosSayTtsEngine,
): Promise<{ outPath: string; segmentCount: number }> {
  const durationMs = Math.max(1, Math.round(opts.durationMs));
  const entries = opts.entries
    .map((e) => {
      const startMs = Math.max(0, Math.round(e.startMs));
      const rawEndMs = e.endMs == null ? undefined : Math.round(e.endMs);
      return {
        startMs,
        endMs: rawEndMs != null && Number.isFinite(rawEndMs) ? Math.max(startMs + 1, rawEndMs) : undefined,
        text: e.text.trim(),
      };
    })
    .filter((e) => e.text && e.startMs < durationMs)
    .sort((a, b) => a.startMs - b.startMs)
    .map((e, i, all) => {
      const fallbackEnd = i + 1 < all.length ? all[i + 1]!.startMs : durationMs;
      const endMs = Math.max(e.startMs + 1, Math.min(durationMs, e.endMs ?? fallbackEnd));
      return { ...e, endMs };
    })
    .filter((e) => e.endMs > e.startMs);
  if (entries.length === 0) {
    throw new Error("voice-over track has no caption text to read");
  }
  const workDir = opts.workDir ?? path.dirname(opts.outPath);
  await mkdir(workDir, { recursive: true });
  await mkdir(path.dirname(opts.outPath), { recursive: true });

  const base = safeBaseName(opts.outPath);
  const segments: Array<{ path: string; startMs: number; durationMs: number }> = [];
  for (let i = 0; i < entries.length; i++) {
    const segPath = path.join(workDir, `${base}.segment-${String(i + 1).padStart(3, "0")}.wav`);
    await engine.synthesizeToWav(entries[i]!.text, { voice: opts.voice, outPath: segPath });
    segments.push({
      path: segPath,
      startMs: entries[i]!.startMs,
      durationMs: entries[i]!.endMs - entries[i]!.startMs,
    });
  }

  await mixVoiceoverSegments(segments, durationMs, opts.outPath);
  return { outPath: opts.outPath, segmentCount: segments.length };
}

function parseSayVoiceLine(line: string): TtsVoice | null {
  const m = line.match(/^(.+?)\s+([a-z]{2}_[A-Z]{2})\s+#\s*(.*)$/);
  if (!m) return null;
  const id = m[1]!.trim();
  const locale = m[2]!.trim();
  const sample = m[3]!.trim();
  return {
    id,
    locale,
    label: sample ? `${id} (${locale})` : id,
  };
}

async function mixVoiceoverSegments(
  segments: Array<{ path: string; startMs: number; durationMs: number }>,
  durationMs: number,
  outPath: string,
): Promise<void> {
  const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
  const durationSec = (Math.max(1, durationMs) / 1000).toFixed(3);
  const args: string[] = [
    "-y",
    "-f", "lavfi",
    "-t", durationSec,
    "-i", "anullsrc=channel_layout=mono:sample_rate=44100",
  ];
  for (const seg of segments) args.push("-i", seg.path);
  const filters: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    const delay = Math.max(0, Math.round(segments[i]!.startMs));
    const segmentSec = (Math.max(1, Math.round(segments[i]!.durationMs)) / 1000).toFixed(3);
    filters.push(`[${i + 1}:a]atrim=duration=${segmentSec},asetpts=PTS-STARTPTS,adelay=${delay}:all=1[a${i}]`);
  }
  const inputs = `[0:a]${segments.map((_, i) => `[a${i}]`).join("")}`;
  filters.push(`${inputs}amix=inputs=${segments.length + 1}:duration=first:dropout_transition=0:normalize=0[aout]`);
  await runProc(ffmpeg, [
    ...args,
    "-filter_complex", filters.join(";"),
    "-map", "[aout]",
    "-t", durationSec,
    "-ac", "1",
    "-ar", "44100",
    "-c:a", "pcm_s16le",
    outPath,
  ]);
}

function safeBaseName(outPath: string): string {
  return path.basename(outPath).replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9._-]+/g, "-") || "voiceover";
}

function captureProcess(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = "";
    let err = "";
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    p.stdout.on("data", (d) => { out += d.toString(); });
    p.stderr.on("data", (d) => { err += d.toString(); });
    p.on("error", (e) => reject(new Error(`${cmd} not runnable: ${e.message}`)));
    p.on("exit", (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`${cmd} exited ${code}${err ? `: ${err.trim()}` : ""}`));
    });
  });
}
