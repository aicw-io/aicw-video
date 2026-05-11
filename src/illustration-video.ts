import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ILLUSTRATION_VIDEO_MODES = ["none", "side_by_side", "animation_only"] as const;
export type IllustrationVideoMode = (typeof ILLUSTRATION_VIDEO_MODES)[number];

const DEFAULT_W = 1080;
const DEFAULT_H = 1920;
const DEFAULT_FPS = 30;
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export type IllustrationRenderResult = {
  cache: "hit" | "miss";
  cacheKey: string;
  generatedAt: string;
  htmlPath: string;
  videoPath: string;
  videoRelPath: string;
  prompt: string;
  durationMs: number;
  width: number;
  height: number;
};

export function normalizeIllustrationMode(value: unknown): IllustrationVideoMode {
  if (value === "demo_only") return "animation_only";
  return value === "side_by_side" || value === "animation_only" ? value : "none";
}

export function defaultIllustrationPrompt(args: {
  caption?: string;
  originalText?: string;
  clipTitle?: string;
  timestampMs?: number;
}): string {
  const subject = firstSentence(args.caption || args.originalText || args.clipTitle || "this moment");
  const context = args.originalText && args.originalText.trim() && args.originalText.trim() !== subject
    ? ` Spoken context: ${firstSentence(args.originalText)}`
    : "";
  const timestamp = Number.isFinite(args.timestampMs) ? ` Source time: ${((args.timestampMs ?? 0) / 1000).toFixed(1)}s.` : "";
  return [
    `Goal: Create one self-contained animated explanatory graphic for this selected video span.`,
    `Clip: ${args.clipTitle || "Untitled clip"}.`,
    `Selected span to illustrate: "${subject}".`,
    context,
    timestamp,
    `Visual type: list.`,
    `Visual items: Main idea; Supporting point.`,
    `Visual brief: Translate the idea into a concise list graphic, not a transcript card.`,
    `Rules: use only graph or list; use graph for growth, usage, metrics, speed, progress, counts, or numbers; use list for priorities, key points, reasons, contrasts, or steps. Do not paste the spoken sentence as a headline. Use portrait-safe composition, simple symbolic shapes, strong contrast, no tiny text, and no full-sentence duplicate captions.`,
  ].join(" ").replace(/\s+/g, " ").trim();
}

export async function renderIllustrationVideo(root: string, args: {
  prompt: string;
  durationMs: number;
  force?: boolean;
  width?: number;
  height?: number;
  pointIndex?: number;
}): Promise<IllustrationRenderResult> {
  const prompt = normalizePrompt(args.prompt);
  const durationMs = Math.max(1000, Math.min(120000, Math.round(Number(args.durationMs || 0))));
  const width = evenDimension(args.width ?? DEFAULT_W);
  const height = evenDimension(args.height ?? DEFAULT_H);
  const key = cacheKey({ v: 6, prompt, durationMs, width, height, fps: DEFAULT_FPS });
  const dir = path.join(root, "cache", "illustrations", key);
  const htmlPath = path.join(dir, "index.html");
  const videoPath = path.join(dir, "video.mp4");
  const manifestPath = path.join(dir, "manifest.json");
  const videoRelPath = path.relative(root, videoPath);
  await mkdir(dir, { recursive: true });

  let generatedAt = new Date().toISOString();
  if (!args.force && existsSync(videoPath)) {
    generatedAt = await readGeneratedAt(manifestPath, generatedAt);
    return { cache: "hit", cacheKey: key, generatedAt, htmlPath, videoPath, videoRelPath, prompt, durationMs, width, height };
  }

  await writeFile(htmlPath, buildIllustrationHtml({ prompt, durationMs, width, height }), "utf8");
  await writeFile(path.join(dir, "prompt.txt"), prompt + "\n", "utf8");
  await writeLocalGsap(dir);
  await renderWithHyperframes(dir, videoPath);
  await writeFile(
    manifestPath,
    JSON.stringify({
      cache_key: key,
      prompt,
      duration_ms: durationMs,
      width,
      height,
      fps: DEFAULT_FPS,
      generated_at: generatedAt,
      point_index: args.pointIndex,
      renderer: "hyperframes-cli",
    }, null, 2),
    "utf8",
  );
  return { cache: "miss", cacheKey: key, generatedAt, htmlPath, videoPath, videoRelPath, prompt, durationMs, width, height };
}

async function readGeneratedAt(manifestPath: string, fallback: string): Promise<string> {
  try {
    const raw = JSON.parse(await readFile(manifestPath, "utf8")) as { generated_at?: string };
    return raw.generated_at || fallback;
  } catch {
    return fallback;
  }
}

async function writeLocalGsap(dir: string): Promise<void> {
  const source = path.join(PACKAGE_ROOT, "node_modules", "gsap", "dist", "gsap.min.js");
  if (!existsSync(source)) throw new Error("gsap package is not installed; run npm install in the aicw-video package");
  await copyFile(source, path.join(dir, "gsap.min.js"));
}

async function renderWithHyperframes(projectDir: string, outputPath: string): Promise<void> {
  const bin = process.env.AICW_VIDEO_HYPERFRAMES_BIN || localHyperframesBin() || "npx";
  const env = {
    ...process.env,
    HYPERFRAMES_NO_UPDATE_CHECK: process.env.HYPERFRAMES_NO_UPDATE_CHECK || "1",
    HYPERFRAMES_NO_TELEMETRY: process.env.HYPERFRAMES_NO_TELEMETRY || "1",
    npm_config_loglevel: process.env.npm_config_loglevel || "error",
  };
  await runTool(bin, hyperframesArgs(bin, ["lint"]), projectDir, env, "hyperframes lint");
  await runTool(
    bin,
    hyperframesArgs(bin, ["render", "--output", outputPath, "--fps", String(DEFAULT_FPS), "--quality", "standard", "--workers", "1"]),
    projectDir,
    env,
    "hyperframes render",
  );
}

function hyperframesArgs(bin: string, args: string[]): string[] {
  return path.basename(bin).startsWith("npx") ? ["--yes", "hyperframes", ...args] : args;
}

function localHyperframesBin(): string | undefined {
  const binName = process.platform === "win32" ? "hyperframes.cmd" : "hyperframes";
  const candidate = path.join(PACKAGE_ROOT, "node_modules", ".bin", binName);
  return existsSync(candidate) ? candidate : undefined;
}

function runTool(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout = (stdout + chunk).slice(-12000);
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-12000);
    });
    child.on("error", (error) => {
      reject(new Error(`${label} not runnable: ${error.message}\nGenerated project: ${cwd}`));
    });
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${label} exited ${code}${toolFailureText(stdout, stderr, cwd)}`));
    });
  });
}

function toolFailureText(stdout: string, stderr: string, projectDir: string): string {
  const lines = [...stdout.split(/\r?\n/), ...stderr.split(/\r?\n/)]
    .map((line) => line.trim())
    .filter((line) => line && !/^npm warn deprecated /i.test(line));
  const detail = lines.length > 0
    ? `:\n${lines.slice(-24).join("\n")}`
    : " with no diagnostics from Hyperframes";
  return `${detail}\nGenerated project: ${projectDir}`;
}

function normalizePrompt(value: string): string {
  const prompt = String(value || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!prompt) throw new Error("illustration prompt is required");
  return prompt.slice(0, 6000);
}

function cacheKey(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
}

function evenDimension(value: number): number {
  const n = Math.max(320, Math.min(4096, Math.round(Number(value) || 0)));
  return n % 2 === 0 ? n : n + 1;
}

function firstSentence(text: string): string {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) return "";
  const match = clean.match(/^(.{1,180}?[.!?])\s/);
  return (match ? match[1] : clean.slice(0, 180)).trim();
}

function buildIllustrationHtml(args: { prompt: string; durationMs: number; width: number; height: number }): string {
  const durationSec = Math.max(1, args.durationMs / 1000);
  const palette = paletteFor(args.prompt);
  const spec = visualSpecForPrompt(args.prompt);
  const items = spec.items;
  const kind = spec.kind;
  const title = spec.title;
  const label = kind === "graph" ? "metric signal" : kind === "list" ? "key points" : kind === "flow" ? "workflow" : "visual idea";
  const graphic = illustrationGraphicHtml(kind, items, palette);
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:${palette.bg};font-family:Inter,Arial,sans-serif}
[data-composition-id]{position:relative;overflow:hidden;background:${palette.bg};color:${palette.ink}}
.scene{position:absolute;inset:0;overflow:hidden;background:
  radial-gradient(circle at 20% 18%,${palette.accentSoft},transparent 28%),
  radial-gradient(circle at 82% 76%,${palette.altSoft},transparent 30%),
  linear-gradient(150deg,${palette.bg},${palette.bg2})}
.grain{position:absolute;inset:-20%;opacity:.18;background-image:linear-gradient(90deg,rgba(255,255,255,.16) 1px,transparent 1px),linear-gradient(0deg,rgba(0,0,0,.08) 1px,transparent 1px);background-size:44px 44px;transform:rotate(-7deg)}
.ring{position:absolute;width:62%;aspect-ratio:1;border:12px solid ${palette.accent};border-radius:50%;left:19%;top:18%;opacity:.2}
.card{position:absolute;left:8%;right:8%;top:21%;min-height:48%;border-radius:34px;background:rgba(255,255,255,.92);box-shadow:0 42px 120px rgba(0,0,0,.22);display:flex;flex-direction:column;justify-content:center;padding:7%;box-sizing:border-box}
.card:before{content:"";position:absolute;inset:18px;border:2px solid ${palette.accent};border-radius:24px;opacity:.22}
.label{font-size:34px;line-height:1.1;font-weight:800;text-transform:uppercase;letter-spacing:.08em;color:${palette.accent};margin-bottom:28px}
.title{position:relative;z-index:1;font-size:58px;line-height:1.05;font-weight:900;color:${palette.ink};letter-spacing:0;max-width:92%}
.graphic{position:relative;z-index:1;margin-top:42px}
.graph{height:330px}
.metric{position:absolute;right:10px;top:0;background:${palette.ink};color:#fff;border-radius:22px;padding:18px 24px;font-size:36px;font-weight:900;box-shadow:0 18px 44px rgba(0,0,0,.18)}
.graph svg{position:absolute;left:0;right:0;bottom:0;width:100%;height:285px;overflow:visible}
.graph-axis{stroke:${palette.ink};stroke-width:8;stroke-linecap:round;opacity:.16}
.graph-line{fill:none;stroke:${palette.accent};stroke-width:18;stroke-linecap:round;stroke-linejoin:round}
.graph-dot{fill:${palette.alt};stroke:#fff;stroke-width:8}
.list{display:grid;gap:14px}
.list-row{display:grid;grid-template-columns:58px 1fr;align-items:center;gap:14px;background:rgba(255,255,255,.78);border:2px solid rgba(0,0,0,.08);border-radius:22px;padding:16px 18px;box-shadow:0 16px 38px rgba(0,0,0,.08)}
.list-num{width:58px;height:58px;border-radius:18px;background:${palette.accent};color:#fff;display:flex;align-items:center;justify-content:center;font-size:30px;font-weight:900}
.list-text{font-size:34px;line-height:1.05;font-weight:900;color:${palette.ink}}
.flow{display:grid;grid-template-columns:1fr auto 1fr auto 1fr;align-items:center;gap:12px;margin-top:50px}
.flow-node{min-height:116px;border-radius:28px;background:rgba(255,255,255,.8);border:3px solid ${palette.accent};display:flex;align-items:center;justify-content:center;text-align:center;padding:18px;font-size:29px;line-height:1.05;font-weight:900;color:${palette.ink};box-shadow:0 18px 44px rgba(0,0,0,.1)}
.flow-arrow{width:44px;height:10px;border-radius:999px;background:${palette.alt};position:relative;transform-origin:left center}
.flow-arrow:after{content:"";position:absolute;right:-8px;top:-8px;border-left:18px solid ${palette.alt};border-top:13px solid transparent;border-bottom:13px solid transparent}
.chips{display:flex;gap:16px;flex-wrap:wrap;justify-content:center}
.chip{background:${palette.ink};color:#fff;border-radius:999px;padding:14px 22px;font-size:28px;font-weight:800;box-shadow:0 18px 44px rgba(0,0,0,.18)}
.shape{position:absolute;border-radius:28px;background:${palette.alt};box-shadow:0 24px 80px rgba(0,0,0,.18);opacity:.85}
.shape.a{width:26%;height:9%;left:10%;top:17%;transform:rotate(-12deg)}
.shape.b{width:22%;height:22%;right:9%;top:10%;border-radius:42%;background:${palette.accent};transform:rotate(4deg)}
.shape.c{width:30%;height:7%;right:13%;bottom:23%;transform:rotate(10deg);background:${palette.accent}}
</style>
</head>
<body>
<div id="root" data-composition-id="root" data-start="0" data-width="${args.width}" data-height="${args.height}">
  <div id="scene" class="clip scene" data-start="0" data-duration="${durationSec.toFixed(3)}" data-track-index="0">
    <div class="grain"></div>
    <div class="ring"></div>
    <div class="shape a"></div>
    <div class="shape b"></div>
    <div class="shape c"></div>
    <section class="card">
      <div class="label">${escapeHtml(label)}</div>
      <div class="title">${escapeHtml(title)}</div>
      ${graphic}
    </section>
  </div>
</div>
<script src="./gsap.min.js"></script>
<script>
const tl = gsap.timeline({ paused: true });
tl.fromTo(".card", { y: 72, opacity: 0 }, { y: 0, opacity: 1, duration: 0.55, ease: "power3.out" }, 0);
tl.fromTo(".title", { y: 24, opacity: 0 }, { y: 0, opacity: 1, duration: 0.45, ease: "power3.out" }, 0.14);
tl.fromTo(".metric", { y: 22, opacity: 0, scale: 0.9 }, { y: 0, opacity: 1, scale: 1, duration: 0.38, ease: "back.out(1.8)" }, 0.35);
document.querySelectorAll(".graph-line").forEach((line) => {
  const len = line.getTotalLength ? line.getTotalLength() : 900;
  line.style.strokeDasharray = String(len);
  line.style.strokeDashoffset = String(len);
  tl.to(line, { strokeDashoffset: 0, duration: ${Math.max(0.8, durationSec * 0.42).toFixed(3)}, ease: "power2.out" }, 0.45);
});
tl.fromTo(".graph-dot", { scale: 0, transformOrigin: "center center" }, { scale: 1, duration: 0.24, stagger: 0.12, ease: "back.out(2)" }, 0.75);
tl.fromTo(".list-row", { x: -42, opacity: 0 }, { x: 0, opacity: 1, duration: 0.34, stagger: 0.16, ease: "power3.out" }, 0.38);
tl.fromTo(".flow-node", { y: 28, opacity: 0 }, { y: 0, opacity: 1, duration: 0.34, stagger: 0.14, ease: "power3.out" }, 0.38);
tl.fromTo(".flow-arrow", { scaleX: 0, opacity: 0 }, { scaleX: 1, opacity: 1, duration: 0.26, stagger: 0.16, ease: "power2.out" }, 0.66);
tl.fromTo(".chips .chip", { y: 28, opacity: 0 }, { y: 0, opacity: 1, duration: 0.35, stagger: 0.06, ease: "power2.out" }, 0.34);
tl.fromTo(".grain", { x: 0 }, { x: 44, duration: ${durationSec.toFixed(3)}, ease: "none" }, 0);
tl.fromTo(".ring", { scale: 0.94, opacity: 0.14 }, { scale: 1.05, opacity: 0.28, duration: ${Math.max(0.5, durationSec * 0.7).toFixed(3)}, ease: "sine.inOut" }, 0);
tl.fromTo(".shape.a", { y: 0, rotate: -12 }, { y: -28, rotate: -7, duration: ${Math.max(0.5, durationSec * 0.75).toFixed(3)}, ease: "sine.inOut" }, 0);
tl.fromTo(".shape.b", { y: 0, rotate: 4 }, { y: 30, rotate: -8, duration: ${Math.max(0.5, durationSec * 0.8).toFixed(3)}, ease: "sine.inOut" }, 0);
tl.fromTo(".shape.c", { y: 20, rotate: 10 }, { y: -8, rotate: 3, duration: ${Math.max(0.5, durationSec * 0.85).toFixed(3)}, ease: "sine.inOut" }, 0);
tl.to(".card", { scale: 1.025, duration: ${Math.max(0.5, durationSec * 0.8).toFixed(3)}, ease: "sine.inOut" }, 0.4);
tl.set({}, {}, ${durationSec.toFixed(3)});
window.__timelines = window.__timelines || {};
window.__timelines.root = tl;
</script>
</body>
</html>`;
}

type IllustrationVisualKind = "graph" | "list" | "flow" | "concept";
type IllustrationVisualSpec = { kind: IllustrationVisualKind; items: string[]; title: string };

export function visualSpecForPrompt(prompt: string): IllustrationVisualSpec {
  const kind = visualKindFor(prompt);
  const items = visualItems(prompt, kind);
  return { kind, items, title: visualTitleFor(kind, items) };
}

function illustrationGraphicHtml(
  kind: IllustrationVisualKind,
  items: string[],
  palette: { bg: string; bg2: string; ink: string; accent: string; accentSoft: string; alt: string; altSoft: string },
): string {
  const safeItems = items.length ? items : ["signal", "moment", "idea"];
  if (kind === "graph") {
    const metric = graphMetricLabel(safeItems);
    return `<div class="graphic graph">
        <div class="metric">${escapeHtml(metric)}</div>
        <svg viewBox="0 0 640 300" role="img" aria-label="rising graph">
          <path class="graph-axis" d="M44 252H596M54 42V252"></path>
          <polyline class="graph-line" points="58,238 160,210 274,164 394,102 560,48"></polyline>
          <circle class="graph-dot" cx="160" cy="210" r="15"></circle>
          <circle class="graph-dot" cx="274" cy="164" r="15"></circle>
          <circle class="graph-dot" cx="394" cy="102" r="15"></circle>
          <circle class="graph-dot" cx="560" cy="48" r="18"></circle>
        </svg>
      </div>`;
  }
  if (kind === "list") {
    return `<div class="graphic list">${safeItems.slice(0, 4).map((item, index) =>
      `<div class="list-row"><span class="list-num">${index + 1}</span><span class="list-text">${escapeHtml(titleCase(item))}</span></div>`,
    ).join("")}</div>`;
  }
  if (kind === "flow") {
    const flowItems = safeItems.slice(0, 3);
    while (flowItems.length < 3) flowItems.push(["input", "process", "result"][flowItems.length]!);
    return `<div class="graphic flow">
        <div class="flow-node">${escapeHtml(titleCase(flowItems[0]!))}</div>
        <div class="flow-arrow"></div>
        <div class="flow-node">${escapeHtml(titleCase(flowItems[1]!))}</div>
        <div class="flow-arrow"></div>
        <div class="flow-node">${escapeHtml(titleCase(flowItems[2]!))}</div>
      </div>`;
  }
  return `<div class="graphic chips">${safeItems.slice(0, 5).map((chip) => `<span class="chip">${escapeHtml(titleCase(chip))}</span>`).join("")}</div>`;
}

function visualKindFor(prompt: string): IllustrationVisualKind {
  const explicit = explicitVisualType(prompt);
  if (explicit) return explicit;
  const text = (momentTextFromPrompt(prompt) || prompt).toLowerCase();
  if (/\b(grow|growth|growing|increase|increased|increasing|rise|rising|up|usage|metric|metrics|speed|fast|faster|progress|trend|rate|revenue|conversion|conversions|traffic|adoption)\b/.test(text)) {
    return "graph";
  }
  if (/\b(priority|priorities|key point|points|feature|features|reason|reasons|step|steps|list|pillars|benefits|criteria|tasks)\b/.test(text)) {
    return "list";
  }
  return "list";
}

function visualItems(prompt: string, kind: IllustrationVisualKind): string[] {
  const contextual = contextSpecificVisualItems(prompt);
  if (contextual.length) return contextual;
  const explicit = explicitVisualItems(prompt);
  if (explicit.length) return explicit;
  const text = momentTextFromPrompt(prompt) || prompt;
  const words = keywords(text);
  if (words.length >= 2) return words.slice(0, kind === "graph" ? 3 : 4);
  return words.slice(0, kind === "graph" ? 3 : 4);
}

function explicitVisualType(prompt: string): IllustrationVisualKind | undefined {
  const match = String(prompt || "").match(/visual\s+type\s*:\s*(graph|list)\b/i);
  if (!match) return undefined;
  return match[1]!.toLowerCase() as IllustrationVisualKind;
}

function explicitVisualItems(prompt: string): string[] {
  const text = String(prompt || "").replace(/\r\n?/g, "\n");
  const match = text.match(/visual\s+items\s*:\s*([\s\S]*?)(?:\n\s*(?:visual\s+brief|rules|style|selected\s+span|full\s+clip|moments?\s+to\s+cover)\s*:|$)/i);
  if (!match) return [];
  const block = match[1] || "";
  const quoted = Array.from(block.matchAll(/"([^"]{2,42})"/g)).map((m) => sanitizeVisualLabel(m[1] || "")).filter(Boolean);
  const candidates = quoted.length
    ? quoted
    : block
      .split(/\n|,|;/)
      .map((line) => sanitizeVisualLabel(line))
      .filter(Boolean);
  return uniqueLabels(candidates).slice(0, 4);
}

function momentTextFromPrompt(prompt: string): string {
  const text = String(prompt || "").replace(/\r\n?/g, "\n");
  const match = text.match(/(?:selected\s+span\s+to\s+illustrate|moments?\s+to\s+cover):\s*([\s\S]*?)(?:\n\s*(?:visual\s+(?:type|items|brief|plan|direction)|rules|style|renderer\s+guidance)\s*:|$)/i);
  if (match) {
    const extracted = match[1]!
      .split(/\n+/)
      .map((line) => line.replace(/^\s*-\s*#?\d*(?:\s+at\s+[0-9:.]+)?\s*:?\s*/i, "").trim())
      .filter(Boolean)
      .join(" ");
    if (extracted) return extracted;
  }
  const quoted = text.match(/"([^"]{4,220})"/);
  return quoted ? quoted[1]!.trim() : "";
}

function graphMetricLabel(items: string[]): string {
  const source = items.find((item) => /usage|metric|speed|growth|conversion|traffic|adoption|progress/i.test(item)) || items[0] || "trend";
  return `${titleCase(source)} up`;
}

function visualTitleFor(kind: IllustrationVisualKind, items: string[]): string {
  if (kind === "graph") return "Trend";
  if (kind === "list") return "Key points";
  if (kind === "flow") return "Process flow";
  return items.slice(0, 2).map(titleCase).join(" + ") || "Visual idea";
}

function titleCase(value: string): string {
  return String(value || "")
    .replace(/[-_]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 4)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function contextSpecificVisualItems(prompt: string): string[] {
  const text = String(prompt || "").replace(/\s+/g, " ");
  if (/\bvibe\s+coding\b/i.test(text)) {
    const vibeFirst = /\bvibe\b[^.!?]{0,140}\bfirst\b/i.test(text) || /\bfirst\b[^.!?]{0,140}\bvibe\b/i.test(text) || /\bvibe\b[^.!?]{0,140}\bfirst\s+place\b/i.test(text);
    const codingSecond = /\bcoding\b[^.!?]{0,140}\bsecond\b/i.test(text) || /\bsecond\b[^.!?]{0,140}\bcoding\b/i.test(text);
    if (vibeFirst && codingSecond) return ["Vibe first", "Coding second"];
    return ["Vibe", "Coding"];
  }
  return [];
}

function sanitizeVisualLabel(value: string): string {
  let label = String(value || "")
    .replace(/^\s*[-*•]\s*/, "")
    .replace(/^\s*\d+[.)]\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
  label = label.replace(/^["'“”‘’]+|["'“”‘’]+$/g, "").trim();
  label = label.replace(/^(?:visual\s+items?|items?|label|card|point)\s*:\s*/i, "").trim();
  if (!label || /^(?:n\/a|none|null|undefined)$/i.test(label)) return "";
  if (/^(?:build|create|use|show|make|extract|do not|keep|prefer|future|graph|list|style|rules?)\b/i.test(label)) return "";
  if (/\b(?:caption|transcript|selected span|full clip|visual type|visual brief|renderer guidance)\b/i.test(label)) return "";
  label = label.replace(/[.!?]+$/g, "").trim();
  const words = label.split(/\s+/).filter(Boolean);
  if (words.length > 5) return "";
  return words.slice(0, 4).join(" ");
}

function uniqueLabels(values: string[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    const clean = sanitizeVisualLabel(value);
    if (!clean) continue;
    if (out.some((existing) => existing.toLowerCase() === clean.toLowerCase())) continue;
    out.push(clean);
  }
  return out;
}

function promptTitle(prompt: string): string {
  const moment = momentTextFromPrompt(prompt);
  const clean = (moment || prompt)
    .replace(/^create\s+(a|an)\s+/i, "")
    .replace(/^animated\s+/i, "")
    .replace(/^explainer\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();
  const quoted = clean.match(/"([^"]{4,120})"/);
  const base = quoted ? quoted[1] : clean;
  return base.split(/\s+/).slice(0, 9).join(" ") || "Illustrated moment";
}

function keywords(prompt: string): string[] {
  const stop = new Set(["about", "animated", "based", "cards", "clean", "clear", "clip", "composition", "context", "cover", "create", "duplicate", "duration", "explainer", "full", "graphics", "headline", "idea", "large", "literal", "looking", "modern", "moment", "moments", "needed", "paste", "portrait", "safe", "sentence", "sentences", "seconds", "short", "simple", "source", "span", "spoken", "strong", "style", "text", "that", "this", "time", "tiny", "transcript", "using", "video", "visual", "with"]);
  const words = prompt
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 4 && !stop.has(word));
  const out: string[] = [];
  for (const word of words) {
    if (!out.includes(word)) out.push(word);
    if (out.length >= 5) break;
  }
  return out.length ? out : ["context", "process", "signal"];
}

function paletteFor(prompt: string): { bg: string; bg2: string; ink: string; accent: string; accentSoft: string; alt: string; altSoft: string } {
  const palettes = [
    { bg: "#f7f1e6", bg2: "#d7eef2", ink: "#17324d", accent: "#e64646", accentSoft: "rgba(230,70,70,.34)", alt: "#00a7a5", altSoft: "rgba(0,167,165,.32)" },
    { bg: "#eef4ff", bg2: "#f8e7cf", ink: "#16213a", accent: "#3d7cff", accentSoft: "rgba(61,124,255,.32)", alt: "#ffb000", altSoft: "rgba(255,176,0,.34)" },
    { bg: "#f5f7ee", bg2: "#e3eef8", ink: "#213021", accent: "#168a55", accentSoft: "rgba(22,138,85,.3)", alt: "#e84d8a", altSoft: "rgba(232,77,138,.28)" },
    { bg: "#f7f4ff", bg2: "#e8f8ef", ink: "#251942", accent: "#7c3aed", accentSoft: "rgba(124,58,237,.24)", alt: "#14b8a6", altSoft: "rgba(20,184,166,.3)" },
  ];
  const hash = crypto.createHash("sha1").update(prompt).digest();
  return palettes[hash[0]! % palettes.length]!;
}

function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
