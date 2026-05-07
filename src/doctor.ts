import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { c, ok, bad, warn, dim, heading } from "./colors.js";
import { aiCliAvailable, configuredAiCliToolLabels, firstAvailableAiCliToolLabel, preflightAiCliTools } from "./llm/index.js";
import { getFfmpegPath, getFfprobePath, resolveFfmpegPath } from "./ffmpeg.js";

type CheckResult = { name: string; pathFound?: string; version?: string; ok: boolean; install?: string };

export async function runDoctor(): Promise<{ allOk: boolean }> {
  console.log(`\n${heading("aicw-video doctor")} — checking your environment\n`);

  console.log(heading("Required tools"));
  const required: CheckResult[] = await Promise.all([
    checkTool("node", ["--version"], /v([\d.]+)/),
    checkBinary("ffmpeg", getFfmpegPath(), ["-version"], /ffmpeg version (\S+)/, "brew install ffmpeg-full"),
    checkBinary("ffprobe", getFfprobePath(), ["-version"], /ffprobe version (\S+)/, "brew install ffmpeg-full"),
    checkTool("whisper-cli", ["--help"], /usage:\s*([^\s]+)|whisper\.cpp/i, "brew install whisper-cpp"),
    checkTool("curl", ["--version"], /curl (\S+)/),
  ]);
  for (const r of required) printCheck(r);
  let renderCaptionsOk = false;
  try {
    const renderFfmpeg = await resolveFfmpegPath({ requiredFilters: ["subtitles"] });
    renderCaptionsOk = true;
    console.log(ok(`ffmpeg subtitles ${dim(`libass filter · ${renderFfmpeg}`)}`));
  } catch (e) {
    console.log(bad(`ffmpeg subtitles libass filter unavailable`));
    console.log(`              ${dim(e instanceof Error ? e.message : String(e))}`);
  }

  console.log(`\n${heading("Voice-over (Alpha, opt-in)")}`);
  if (process.platform === "darwin") {
    const say = await checkTool("say", ["-v", "?"], /\S/);
    printCheck(say);
    console.log(`   ${dim("voice-over is per-clip in the Plan UI and uses macOS text-to-speech")}`);
  } else {
    console.log(warn(`macOS text-to-speech is not available on this platform`));
  }

  console.log(`\n${heading("Optional capabilities")}`);
  const enc = await captureProcess(getFfmpegPath(), ["-hide_banner", "-encoders"]);
  if (enc.includes("h264_videotoolbox")) {
    console.log(ok(`h264_videotoolbox encoder ${dim("(Apple Silicon hardware encoding — fast)")}`));
  } else if (process.platform === "darwin") {
    console.log(warn(`h264_videotoolbox not in this ffmpeg build — falling back to libx264 (slower)`));
  } else {
    console.log(dim(`-  h264_videotoolbox (macOS only)`));
  }
  if (enc.includes("libx264")) console.log(ok(`libx264 encoder`));
  else console.log(bad(`libx264 not in your ffmpeg build`));
  if (enc.includes("subtitle") || enc.toLowerCase().includes("ass")) {
    /* libass capability is harder to introspect; just note */
  }

  console.log(`\n${heading("Whisper model")}`);
  const modelPath = process.env.AICW_VIDEO_WHISPER_MODEL || path.join(os.homedir(), ".cache", "aicw-video", "ggml-base.en.bin");
  if (existsSync(modelPath)) {
    const s = await stat(modelPath);
    console.log(ok(`${modelPath} ${dim((s.size / 1024 / 1024).toFixed(0) + " MB")}`));
  } else {
    console.log(warn(`${modelPath} not yet downloaded (first transcribe call will fetch it, ~140 MB)`));
  }

  console.log(`\n${heading("AI driver")}`);
  const configuredAiTools = configuredAiCliToolLabels();
  if (aiCliAvailable()) {
    console.log(ok(`standalone AI CLI executable available: ${firstAvailableAiCliToolLabel()} ${dim(`configured: ${configuredAiTools.join(" → ")}`)}`));
    console.log(dim(`   running JSON preflight against configured AI CLIs...`));
    const aiPreflight = await preflightAiCliTools({ timeoutMs: 30_000 });
    const ready = aiPreflight.filter((r) => r.ok);
    for (const r of aiPreflight) {
      const label = `${r.label}${r.supportsImages ? " (images)" : ""}`;
      if (r.ok) {
        console.log(ok(`${label} preflight ok`));
      } else if (r.executableOk) {
        console.log(warn(`${label} preflight failed: ${r.error || "unknown error"}`));
      } else {
        console.log(warn(`${label} unavailable: ${r.error || "not executable"}`));
      }
    }
    if (ready.length > 0) {
      console.log(ok(`AI fallback chain ready: ${ready.map((r) => r.label).join(" → ")}`));
    } else {
      console.log(warn(`no configured AI CLI passed runtime preflight — fix auth/session/model setup or run inside an MCP AI host`));
    }
  } else {
    console.log(warn(`no configured AI CLI tool is available — edit config.json ai_cli_tools, install Claude Code/Codex/Ollama, or run \`aicw-video mcp\` and let your AI host drive.`));
  }

  const allOk = required.every((r) => r.ok) && renderCaptionsOk;
  console.log("");
  if (allOk) console.log(ok(`all required tools available — you're ready to go`));
  else console.log(bad(`one or more required tools missing — install the listed packages and re-run ${dim("aicw-video doctor")}`));
  console.log("");
  return { allOk };
}

// Silent variant of runDoctor: probes the required tools, returns the list of
// missing ones, prints nothing. For flows that want to gate on tool presence
// without dumping the full doctor report.
export async function silentPreflight(): Promise<{ allOk: boolean; missing: string[] }> {
  const required = await Promise.all([
    checkTool("node", ["--version"], /v([\d.]+)/),
    checkBinary("ffmpeg", getFfmpegPath(), ["-version"], /ffmpeg version (\S+)/, "brew install ffmpeg-full"),
    checkBinary("ffprobe", getFfprobePath(), ["-version"], /ffprobe version (\S+)/, "brew install ffmpeg-full"),
    checkTool("whisper-cli", ["--help"], /usage:\s*([^\s]+)|whisper\.cpp/i, "brew install whisper-cpp"),
    checkTool("curl", ["--version"], /curl (\S+)/),
  ]);
  const missing = required.filter((r) => !r.ok).map((r) => r.name);
  try {
    await resolveFfmpegPath({ requiredFilters: ["subtitles"] });
  } catch {
    missing.push("ffmpeg subtitles filter");
  }
  return { allOk: missing.length === 0, missing };
}

async function checkTool(name: string, args: string[], versionRe?: RegExp, install?: string): Promise<CheckResult> {
  return checkBinary(name, name, args, versionRe, install);
}

async function checkBinary(name: string, command: string, args: string[], versionRe?: RegExp, install?: string): Promise<CheckResult> {
  const where = path.isAbsolute(command) ? (existsSync(command) ? command : "") : await captureProcess("which", [command]);
  const found = where.trim();
  if (!found) return { name, ok: false, install };
  let version: string | undefined;
  try {
    const out = await captureProcess(command, args);
    if (versionRe) {
      const m = out.match(versionRe);
      if (m && m[1]) version = m[1];
      else if (versionRe.test(out)) version = "(present)";
    }
  } catch { /* ignore — tool exists but version unparseable */ }
  return { name, pathFound: found, version, ok: true, install };
}

function printCheck(r: CheckResult): void {
  if (r.ok) {
    const v = r.version ? r.version : "(version unknown)";
    console.log(ok(`${r.name.padEnd(12)} ${dim(`${v} · ${r.pathFound ?? ""}`)}`));
  } else {
    console.log(bad(`${r.name.padEnd(12)} not found on PATH`));
    if (r.install) console.log(`              ${dim("install: " + r.install)}`);
  }
}

async function captureProcess(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    try {
      const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
      p.stdout.on("data", (d) => { out += d.toString(); });
      p.stderr.on("data", (d) => { err += d.toString(); });
      p.on("error", () => resolve(""));
      p.on("exit", () => resolve(out + err));
    } catch {
      resolve("");
    }
  });
}
