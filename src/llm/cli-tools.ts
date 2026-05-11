import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { config, type AiCliToolConfig } from "../config.js";
import { ClaudeCliProvider } from "./claude-cli.js";
import type { ImageInput, LLMProvider, SampleArgs } from "./types.js";

type RuntimeTool = {
  name: string;
  label: string;
  command: string;
  args: string[];
  model?: string;
  supportsImages: boolean;
};

type ProviderCandidate = {
  provider: LLMProvider;
  label: string;
  supportsImages: boolean;
};

export type AiCliPreflightResult = {
  label: string;
  command: string;
  supportsImages: boolean;
  executableOk: boolean;
  ok: boolean;
  error?: string;
};

export function getCliProvider(opts: { requiresImages?: boolean } = {}): LLMProvider {
  const candidates = availableCandidates(opts.requiresImages ? { requiresImages: true } : {});
  if (candidates.length === 0) {
    throw new Error(
      "No configured AI CLI tools are available. Edit config.json ai_cli_tools or run inside an MCP AI host.",
    );
  }
  return new FallbackCliProvider(candidates);
}

export function aiCliAvailable(opts: { requiresImages?: boolean } = {}): boolean {
  return availableCandidates(opts).length > 0;
}

export function firstAvailableAiCliToolLabel(opts: { requiresImages?: boolean } = {}): string {
  return availableCandidates(opts)[0]?.label ?? "";
}

export function configuredAiCliToolLabels(): string[] {
  return runtimeTools().map((t) => `${t.label}${t.supportsImages ? " (images)" : ""}`);
}

export async function preflightAiCliTools(opts: {
  requiresImages?: boolean;
  timeoutMs?: number;
} = {}): Promise<AiCliPreflightResult[]> {
  const tools = runtimeTools().filter((tool) => !opts.requiresImages || tool.supportsImages);
  const timeoutMs = opts.timeoutMs ?? Math.min(config.aiCliTimeoutMs, 30_000);
  const results: AiCliPreflightResult[] = [];
  for (const tool of tools) {
    const base = {
      label: tool.label,
      command: tool.command,
      supportsImages: tool.supportsImages,
    };
    if (!isToolAvailable(tool)) {
      results.push({
        ...base,
        executableOk: false,
        ok: false,
        error: `${tool.command} is not executable or --version failed`,
      });
      continue;
    }
    try {
      const provider = providerForTool(tool);
      const { parsed } = await provider.sampleJson<{ ok?: boolean }>({
        prompt: 'Return exactly this JSON object: {"ok":true}',
        systemPrompt: "You are running an AI CLI preflight. Return JSON only.",
        maxTokens: 80,
        timeoutMs,
      });
      if (parsed?.ok !== true) {
        throw new Error("preflight response did not contain ok=true");
      }
      results.push({ ...base, executableOk: true, ok: true });
    } catch (e) {
      results.push({
        ...base,
        executableOk: true,
        ok: false,
        error: compactError(e),
      });
    }
  }
  return results;
}

function availableCandidates(opts: { requiresImages?: boolean } = {}): ProviderCandidate[] {
  return runtimeTools()
    .filter((tool) => !opts.requiresImages || tool.supportsImages)
    .filter(isToolAvailable)
    .map((tool) => ({
      provider: providerForTool(tool),
      label: tool.label,
      supportsImages: tool.supportsImages,
    }));
}

function runtimeTools(): RuntimeTool[] {
  return config.ai_cli_tools
    .filter((tool) => tool.enabled !== false)
    .map(normalizeRuntimeTool)
    .filter((tool): tool is RuntimeTool => Boolean(tool));
}

function normalizeRuntimeTool(tool: AiCliToolConfig): RuntimeTool | null {
  const name = tool.name.trim();
  if (!name) return null;
  const normalizedName = name.toLowerCase();
  const command =
    tool.command ||
    (normalizedName === "claude-code" || normalizedName === "claude"
      ? process.env.AICW_VIDEO_CLAUDE_PATH || "claude"
      : normalizedName === "codex"
        ? "codex"
        : normalizedName === "ollama"
          ? "ollama"
          : name);
  return {
    name: normalizedName,
    label: labelForTool(normalizedName, tool.model),
    command,
    args: tool.args ?? [],
    model: tool.model,
    supportsImages:
      tool.supports_images ??
      (normalizedName === "claude-code" || normalizedName === "claude" || normalizedName === "codex"),
  };
}

const availabilityCache = new Map<string, boolean>();
function isToolAvailable(tool: RuntimeTool): boolean {
  const key = `${tool.command}\0${tool.args.join("\0")}`;
  const cached = availabilityCache.get(key);
  if (cached != null) return cached;
  if (tool.command.includes("/") && !existsSync(tool.command)) {
    availabilityCache.set(key, false);
    return false;
  }
  const res = spawnSync(tool.command, ["--version"], { stdio: "ignore", env: process.env });
  const ok = !res.error && res.status === 0;
  availabilityCache.set(key, ok);
  return ok;
}

function labelForTool(name: string, model?: string): string {
  const modelSuffix = model ? ` (${model})` : "";
  switch (name) {
    case "claude":
    case "claude-code":
      return "Claude Code CLI";
    case "codex":
      return `Codex CLI${modelSuffix}`;
    case "ollama":
      return `Ollama CLI${modelSuffix}`;
    default:
      return `${name} CLI${modelSuffix}`;
  }
}

function providerForTool(tool: RuntimeTool): LLMProvider {
  switch (tool.name) {
    case "claude":
    case "claude-code":
      return new ClaudeCliProvider({ command: tool.command, args: tool.args, name: tool.label });
    case "codex":
      return new CodexCliProvider(tool);
    case "ollama":
      return new OllamaCliProvider(tool);
    default:
      return new GenericCliProvider(tool);
  }
}

class FallbackCliProvider implements LLMProvider {
  readonly name = "ai-cli-fallback";

  constructor(private readonly candidates: ProviderCandidate[]) {}

  async sampleJson<T>(args: SampleArgs): Promise<{ raw: string; parsed: T }> {
    const needsImages = (args.images?.length ?? 0) > 0;
    const errors: string[] = [];
    for (const candidate of this.candidates) {
      if (needsImages && !candidate.supportsImages) continue;
      try {
        return await candidate.provider.sampleJson<T>(args);
      } catch (e) {
        errors.push(`${candidate.label}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    throw new Error(`All configured AI CLI tools failed.\n${errors.join("\n")}`);
  }
}

class CodexCliProvider implements LLMProvider {
  readonly name: string;

  constructor(private readonly tool: RuntimeTool) {
    this.name = tool.label;
  }

  async sampleJson<T>(args: SampleArgs): Promise<{ raw: string; parsed: T }> {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "aicw-codex-"));
    try {
      const imagePaths = await writeImages(tmpDir, args.images ?? []);
      const outPath = path.join(tmpDir, "last-message.txt");
      const cliArgs = [
        "exec",
        ...this.tool.args,
        "--skip-git-repo-check",
        "--ephemeral",
        "--sandbox",
        "read-only",
        "--color",
        "never",
        "-C",
        tmpDir,
        "-o",
        outPath,
      ];
      if (this.tool.model) cliArgs.push("-m", this.tool.model);
      for (const p of imagePaths) cliArgs.push("-i", p);
      cliArgs.push("-");

      const prompt = buildJsonPrompt(args, imagePaths);
      const { stdout, stderr, code } = await runCli(this.tool.command, cliArgs, prompt, args.timeoutMs);
      if (code !== 0) {
        throw new Error(`codex exec exited ${code}${stderr.trim() ? `: ${stderr.trim()}` : ""}`);
      }
      const raw = (await readFile(outPath, "utf8").catch(() => stdout)).trim();
      if (!raw) throw new Error(`codex exec returned no final message${stderr.trim() ? `: ${stderr.trim()}` : ""}`);
      return { raw, parsed: extractJson<T>(raw, this.name) };
    } finally {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

class OllamaCliProvider implements LLMProvider {
  readonly name: string;

  constructor(private readonly tool: RuntimeTool) {
    this.name = tool.label;
  }

  async sampleJson<T>(args: SampleArgs): Promise<{ raw: string; parsed: T }> {
    if ((args.images?.length ?? 0) > 0) {
      throw new Error("ollama CLI provider is configured as text-only; set another image-capable tool first");
    }
    const model = this.tool.model || "gemma4";
    const prompt = buildJsonPrompt(args, []);
    const { stdout, stderr, code } = await runCli(this.tool.command, ["run", model, ...this.tool.args], prompt, args.timeoutMs);
    if (code !== 0) throw new Error(ollamaFailureMessage(model, code, stderr));
    return { raw: stdout, parsed: extractJson<T>(stdout, this.name) };
  }
}

function ollamaFailureMessage(model: string, code: number, stderr: string): string {
  const detail = stderr.trim();
  const setup = `Install/start Ollama, then run: ollama pull ${model}`;
  if (/connection refused|could not connect|no such host|server/i.test(detail)) {
    return `ollama run ${model} exited ${code}: Ollama is not reachable. Run "ollama serve" or open the Ollama app. ${setup}`;
  }
  if (/not found|pull model manifest|model .* does not exist|file does not exist/i.test(detail)) {
    return `ollama run ${model} exited ${code}: model is not installed. ${setup}`;
  }
  return `ollama run ${model} exited ${code}${detail ? `: ${detail}` : ""}. ${setup}`;
}

class GenericCliProvider implements LLMProvider {
  readonly name: string;

  constructor(private readonly tool: RuntimeTool) {
    this.name = tool.label;
  }

  async sampleJson<T>(args: SampleArgs): Promise<{ raw: string; parsed: T }> {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "aicw-ai-"));
    try {
      const imagePaths = await writeImages(tmpDir, args.images ?? []);
      const prompt = buildJsonPrompt(args, imagePaths);
      const { stdout, stderr, code } = await runCli(this.tool.command, this.tool.args, prompt, args.timeoutMs);
      if (code !== 0) throw new Error(`${this.tool.command} exited ${code}${stderr.trim() ? `: ${stderr.trim()}` : ""}`);
      return { raw: stdout, parsed: extractJson<T>(stdout, this.name) };
    } finally {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

async function writeImages(tmpDir: string, images: ImageInput[]): Promise<string[]> {
  const paths: string[] = [];
  for (let i = 0; i < images.length; i++) {
    const img = images[i]!;
    const p = path.join(tmpDir, `frame-${String(i + 1).padStart(2, "0")}.${mimeToExt(img.mimeType)}`);
    await writeFile(p, Buffer.from(img.data, "base64"));
    paths.push(p);
  }
  return paths;
}

function buildJsonPrompt(args: SampleArgs, imagePaths: string[]): string {
  const parts = [];
  if (args.systemPrompt) parts.push(`System instruction:\n${args.systemPrompt}`);
  parts.push(args.prompt);
  if (imagePaths.length > 0) {
    parts.push(`Reference images, in order:\n${imagePaths.map((p) => `- ${p}`).join("\n")}`);
  }
  parts.push("Return JSON only. Do not include markdown fences or explanatory prose.");
  return parts.join("\n\n");
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

function runCli(
  command: string,
  args: string[],
  stdin: string,
  timeoutMs = config.aiCliTimeoutMs,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], env: process.env });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    const timeout = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error(`${command} timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    proc.on("error", (e) => {
      clearTimeout(timeout);
      reject(new Error(`failed to spawn '${command}': ${e.message}`));
    });
    proc.on("exit", (code) => {
      clearTimeout(timeout);
      resolve({ stdout, stderr, code: code ?? 0 });
    });
    proc.stdin.write(stdin);
    proc.stdin.end();
  });
}

function extractJson<T>(text: string, providerName: string): T {
  const stripped = text
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
  try {
    return JSON.parse(stripped) as T;
  } catch {
    const m = stripped.match(/\{[\s\S]*\}/);
    if (!m) throw new Error(`${providerName} response was not JSON:\n${text.slice(0, 400)}`);
    return JSON.parse(m[0]) as T;
  }
}

function compactError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 600);
}
