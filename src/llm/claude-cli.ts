import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { config } from "../config.js";
import type { LLMProvider, SampleArgs } from "./types.js";

// Provider that drives Claude Code's `claude --print` non-interactive mode.
// Used in standalone CLI mode: `aicw-video describe`, `aicw-video plan-clips`,
// or `aicw-video go` when no MCP host is connected. Auth comes from the user's
// existing Claude Code subscription — no API key needed.
//
// Image handling: each ImageInput is written to a temp PNG/WEBP/JPG, the
// absolute path is included in the prompt, and we enable the `Read` tool so
// Claude reads them off disk. This matches the Claude Code SDK's
// recommended pattern and avoids huge base64 blobs in the prompt text.
export class ClaudeCliProvider implements LLMProvider {
  readonly name: string;
  private readonly command: string;
  private readonly extraArgs: string[];

  constructor(opts: { command?: string; name?: string; args?: string[] } = {}) {
    this.command = opts.command || process.env.AICW_VIDEO_CLAUDE_PATH || "claude";
    this.name = opts.name || "claude-code";
    this.extraArgs = opts.args ?? [];
  }

  async sampleJson<T>(args: SampleArgs): Promise<{ raw: string; parsed: T }> {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "aicw-claude-"));
    try {
      const imagePaths: string[] = [];
      for (let i = 0; i < (args.images?.length ?? 0); i++) {
        const img = args.images![i]!;
        const ext = mimeToExt(img.mimeType);
        const p = path.join(tmpDir, `keyframe-${String(i + 1).padStart(2, "0")}.${ext}`);
        await writeFile(p, Buffer.from(img.data, "base64"));
        imagePaths.push(p);
      }

      const prompt = buildPrompt(args.prompt, imagePaths);
      const cliArgs = [
        ...this.extraArgs,
        "--print",
        "--output-format=json",
        "--allowed-tools=Read",
        // Note: not using --bare. --bare requires ANTHROPIC_API_KEY because
        // it never reads the keychain or OAuth tokens — that breaks reuse
        // of the user's existing Claude Code login. Without --bare, claude
        // picks up whatever auth method the user already configured.
      ];
      if (args.systemPrompt) {
        cliArgs.push("--append-system-prompt", args.systemPrompt);
      }

      const { stdout, stderr, code } = await runClaude(this.command, cliArgs, prompt, args.timeoutMs);
      if (code !== 0) {
        throw new Error(
          `claude --print exited ${code}\n` +
            (stderr.trim() ? `stderr: ${stderr.trim()}\n` : "") +
            (stdout.trim() ? `stdout: ${stdout.slice(0, 2000)}` : ""),
        );
      }

      // claude -p --output-format=json wraps the result in:
      //   {"type":"result","subtype":"success","is_error":false,"result":"<assistant text>", ...}
      let envelope: { is_error?: boolean; result?: string };
      try {
        envelope = JSON.parse(stdout) as typeof envelope;
      } catch (e) {
        throw new Error(
          `claude --print did not return JSON envelope: ${e instanceof Error ? e.message : String(e)}\n` +
            stdout.slice(0, 2000),
        );
      }
      if (envelope.is_error || !envelope.result) {
        throw new Error(
          `claude --print returned error envelope: ${stdout.slice(0, 2000)}`,
        );
      }
      const raw = envelope.result;
      const parsed = extractJson<T>(raw);
      return { raw, parsed };
    } finally {
      try { await rm(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }
}

function mimeToExt(mime: string): string {
  switch (mime.toLowerCase()) {
    case "image/png": return "png";
    case "image/jpeg":
    case "image/jpg": return "jpg";
    case "image/webp": return "webp";
    case "image/gif": return "gif";
    default: return "bin";
  }
}

function buildPrompt(userPrompt: string, imagePaths: string[]): string {
  if (imagePaths.length === 0) return userPrompt;
  const refs = imagePaths.map((p) => `- ${p}`).join("\n");
  return [
    userPrompt,
    "",
    "Reference images (read each one with the Read tool):",
    refs,
    "",
    "Reply with JSON only. No prose, no markdown fences.",
  ].join("\n");
}

function extractJson<T>(text: string): T {
  // Strip ```json fences if the model wrapped output anyway.
  const stripped = text
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
  try {
    return JSON.parse(stripped) as T;
  } catch {
    // Fallback: first balanced {...} block.
    const m = stripped.match(/\{[\s\S]*\}/);
    if (!m) {
      throw new Error(
        `claude response was not JSON:\n${text.slice(0, 400)}`,
      );
    }
    return JSON.parse(m[0]) as T;
  }
}

function runClaude(
  command: string,
  args: string[],
  promptOnStdin: string,
  timeoutMs = config.aiCliTimeoutMs,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    // The prompt is passed as a positional arg by claude -p, but for very
    // long prompts (with many image paths) it's safer to write it on stdin.
    // Empty positional → claude reads from stdin in --print mode.
    const proc = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    const timeout = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error(`claude --print timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    proc.on("error", (e) => {
      clearTimeout(timeout);
      reject(new Error(`failed to spawn '${command}': ${e.message}. Is Claude Code installed?`));
    });
    proc.on("exit", (code) => {
      clearTimeout(timeout);
      resolve({ stdout, stderr, code: code ?? 0 });
    });
    proc.stdin.write(promptOnStdin);
    proc.stdin.end();
  });
}
