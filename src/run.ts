import { spawn } from "node:child_process";
import path from "node:path";
import { config } from "./config.js";

// Shell out to a binary; stdout suppressed (so MCP framing on stdout stays clean),
// stderr inherited. ffmpeg is quiet by default so production logs stay readable;
// set ffmpegDebug=true in config.json, or AICW_VIDEO_FFMPEG_DEBUG=1 in .env,
// to see full ffmpeg output.
export function runProc(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, argsForProcess(cmd, args), { stdio: ["ignore", "ignore", "inherit"] });
    p.on("error", (e) => reject(new Error(`${cmd} not runnable: ${e.message}`)));
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
  });
}

function argsForProcess(cmd: string, args: string[]): string[] {
  if (!isFfmpeg(cmd) || debugModeEnabled()) return args;

  const out: string[] = [];
  if (!args.includes("-hide_banner")) out.push("-hide_banner");
  if (!args.includes("-loglevel") && !args.includes("-v")) out.push("-loglevel", "error");
  if (!args.includes("-stats") && !args.includes("-nostats")) out.push("-nostats");
  return [...out, ...args];
}

function isFfmpeg(cmd: string): boolean {
  return path.basename(cmd).toLowerCase().startsWith("ffmpeg");
}

function debugModeEnabled(): boolean {
  return config.debugMode ||
    config.ffmpegDebug ||
    truthyEnv(process.env.DEBUG_MODE) ||
    truthyEnv(process.env.AICW_VIDEO_DEBUG) ||
    truthyEnv(process.env.AICW_VIDEO_FFMPEG_DEBUG);
}

function truthyEnv(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}
