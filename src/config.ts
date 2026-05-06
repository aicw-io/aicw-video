import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_FACE_EMOJI_SCALE } from "./constants.js";

/**
 * Project-wide runtime config. Tunable defaults live in `config.json` at
 * the repo root so they can be tweaked without touching source. Anything
 * missing from the file falls back to DEFAULT_CONFIG so a partial config
 * (or no config at all) still boots.
 */
export interface RenderDefaults {
  /** Caption visual and placement, e.g. bold-white-bottom. */
  caption_style: string;
  /** Caption motion: static | word-pop | word-highlight. */
  caption_animation: string;
  /** Reframe to target aspect: crop | letterbox-blur. */
  reframe: string;
}

export interface AiCliToolConfig {
  /** Stable id: claude-code | codex | ollama | custom. */
  name: string;
  /** Executable name or absolute path. Defaults from name when omitted. */
  command?: string;
  /** Optional fixed CLI args prepended by the provider. */
  args?: string[];
  /** Model for tools that need one, such as codex or ollama. */
  model?: string;
  /** Disabled entries stay documented but are not tried. */
  enabled?: boolean;
  /** Whether this CLI can receive image inputs from visual analysis. */
  supports_images?: boolean;
}

export interface AicwVideoConfig {
  /** When true, preserve verbose subprocess output useful for debugging. */
  debugMode: boolean;
  /** When true, ffmpeg/ffprobe commands keep detailed stderr output. */
  ffmpegDebug: boolean;
  /** Max time to wait for one standalone AI CLI request before falling back. */
  aiCliTimeoutMs: number;
  /** User-facing caption language for AI-proofread/translated captions.
   *  Raw Whisper text is still preserved separately as original_text. */
  caption_language: string;
  /** Multiplier applied to AI-provided face boxes for the alpha emoji face cover. */
  faceEmojiScale: number;
  /** Milliseconds between sampled frames for videos with usable audio/transcript. */
  visualSampleWithAudioIntervalMs: number;
  /** Milliseconds between sampled frames for videos without usable audio. */
  visualSampleWithoutAudioIntervalMs: number;
  /** Maximum long edge for JPEG frames sent to AI and shown as moment thumbnails. */
  visualSampleImageMaxLongEdge: number;
  /** Maximum images sent to one AI CLI request when describing sampled frames. */
  visualAiMaxFramesPerCall: number;
  /** Defaults a new clip inherits before the user opens its ⚙ settings.
   *  Per-clip overrides live in shorts/plan.json. */
  renderDefaults: RenderDefaults;
  /** Ordered standalone AI CLI fallback chain. MCP sampling still wins when an AI host is connected. */
  ai_cli_tools: AiCliToolConfig[];
}

export type PowertoolsConfig = AicwVideoConfig;

const DEFAULT_CONFIG: AicwVideoConfig = {
  debugMode: false,
  ffmpegDebug: false,
  aiCliTimeoutMs: 120_000,
  caption_language: "English",
  faceEmojiScale: DEFAULT_FACE_EMOJI_SCALE,
  visualSampleWithAudioIntervalMs: 2000,
  visualSampleWithoutAudioIntervalMs: 4000,
  visualSampleImageMaxLongEdge: 512,
  visualAiMaxFramesPerCall: 12,
  renderDefaults: {
    caption_style: "bold-white-bottom",
    caption_animation: "word-highlight",
    reframe: "letterbox-blur",
  },
  ai_cli_tools: [
    { name: "claude-code", command: "claude", supports_images: true },
    { name: "codex", command: "codex", supports_images: true },
    { name: "ollama", command: "ollama", model: "gemma4", supports_images: false },
  ],
};

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const text = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(text)) return true;
    if (["0", "false", "no", "off"].includes(text)) return false;
  }
  return fallback;
}

function normalizeCaptionLanguage(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  return text || DEFAULT_CONFIG.caption_language;
}

function normalizeNumber(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

function normalizeAiCliTools(value: unknown): AiCliToolConfig[] {
  if (!Array.isArray(value)) return DEFAULT_CONFIG.ai_cli_tools;
  const tools = value
    .map((raw): AiCliToolConfig | null => {
      if (typeof raw === "string") return { name: raw };
      if (!raw || typeof raw !== "object") return null;
      const obj = raw as Record<string, unknown>;
      const name = typeof obj.name === "string" ? obj.name.trim() : "";
      if (!name) return null;
      const args = Array.isArray(obj.args) ? obj.args.filter((a): a is string => typeof a === "string") : undefined;
      return {
        name,
        command: typeof obj.command === "string" && obj.command.trim() ? obj.command.trim() : undefined,
        args,
        model: typeof obj.model === "string" && obj.model.trim() ? obj.model.trim() : undefined,
        enabled: typeof obj.enabled === "boolean" ? obj.enabled : undefined,
        supports_images: typeof obj.supports_images === "boolean" ? obj.supports_images : undefined,
      };
    })
    .filter((t): t is AiCliToolConfig => Boolean(t));
  return tools.length > 0 ? tools : DEFAULT_CONFIG.ai_cli_tools;
}

function loadConfigSync(): AicwVideoConfig {
  // Resolve config.json relative to this module so it works identically
  // whether we're running from `src/` (via ts-node) or `dist/` (after
  // build). Both directories sit one level below the repo root.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, "..");
  loadDotEnvSync(path.join(repoRoot, ".env"));
  const configPath = path.join(repoRoot, "config.json");
  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<AicwVideoConfig> & { captionLanguage?: string };
    return {
      ...DEFAULT_CONFIG,
      ...parsed,
      debugMode: normalizeBoolean(
        envValue("AICW_VIDEO_DEBUG") ??
          envValue("DEBUG_MODE") ??
          parsed.debugMode ??
          (parsed as { DEBUG_MODE?: unknown }).DEBUG_MODE,
        DEFAULT_CONFIG.debugMode,
      ),
      ffmpegDebug: normalizeBoolean(
        envValue("AICW_VIDEO_FFMPEG_DEBUG") ??
          parsed.ffmpegDebug ??
          (parsed as { FFMPEG_DEBUG?: unknown }).FFMPEG_DEBUG,
        DEFAULT_CONFIG.ffmpegDebug,
      ),
      aiCliTimeoutMs: Math.round(normalizeNumber(
        envValue("AICW_VIDEO_AI_TIMEOUT_MS") ??
          parsed.aiCliTimeoutMs ??
          (parsed as { ai_cli_timeout_ms?: unknown }).ai_cli_timeout_ms,
        DEFAULT_CONFIG.aiCliTimeoutMs,
        10_000,
        30 * 60_000,
      )),
      caption_language: normalizeCaptionLanguage(parsed.caption_language ?? parsed.captionLanguage),
      faceEmojiScale: normalizeNumber(
        parsed.faceEmojiScale ?? (parsed as { face_emoji_scale?: unknown }).face_emoji_scale,
        DEFAULT_CONFIG.faceEmojiScale,
        0.5,
        3,
      ),
      visualSampleWithAudioIntervalMs: Math.round(normalizeNumber(
        parsed.visualSampleWithAudioIntervalMs ??
          (parsed as { visual_sample_with_audio_interval_ms?: unknown }).visual_sample_with_audio_interval_ms,
        DEFAULT_CONFIG.visualSampleWithAudioIntervalMs,
        500,
        60_000,
      )),
      visualSampleWithoutAudioIntervalMs: Math.round(normalizeNumber(
        parsed.visualSampleWithoutAudioIntervalMs ??
          (parsed as { visual_sample_without_audio_interval_ms?: unknown }).visual_sample_without_audio_interval_ms,
        DEFAULT_CONFIG.visualSampleWithoutAudioIntervalMs,
        500,
        60_000,
      )),
      visualSampleImageMaxLongEdge: normalizeNumber(
        parsed.visualSampleImageMaxLongEdge ??
          (parsed as { visual_sample_image_max_long_edge?: unknown }).visual_sample_image_max_long_edge,
        DEFAULT_CONFIG.visualSampleImageMaxLongEdge,
        256,
        1600,
      ),
      visualAiMaxFramesPerCall: Math.round(normalizeNumber(
        parsed.visualAiMaxFramesPerCall ?? (parsed as { visual_ai_max_frames_per_call?: unknown }).visual_ai_max_frames_per_call,
        DEFAULT_CONFIG.visualAiMaxFramesPerCall,
        1,
        40,
      )),
      renderDefaults: {
        ...DEFAULT_CONFIG.renderDefaults,
        ...(parsed.renderDefaults ?? {}),
      },
      ai_cli_tools: normalizeAiCliTools((parsed as { ai_cli_tools?: unknown }).ai_cli_tools),
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

function loadDotEnvSync(filePath: string): void {
  let raw = "";
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch {
    return;
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const key = match[1]!;
    if (process.env[key] != null) continue;
    process.env[key] = unquoteEnvValue(match[2] ?? "");
  }
}

function unquoteEnvValue(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function envValue(name: string): string | undefined {
  const value = process.env[name];
  return value == null || value === "" ? undefined : value;
}

export const config: AicwVideoConfig = loadConfigSync();
