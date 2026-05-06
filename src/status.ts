import { readFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { resolveProject, sourceVideoPath } from "./projectFolder.js";
import { ok, bad, dim, step, heading } from "./colors.js";

export async function runStatus(projectPath: string): Promise<void> {
  const root = await resolveProject(projectPath);
  console.log(`\n${heading("Project")} ${root}\n`);

  console.log(heading("Source"));
  let hasSource = false;
  try {
    const src = await sourceVideoPath(projectPath);
    hasSource = true;
    const dur = await probeDurationMs(src);
    const dims = await probeDims(src);
    const audio = await streamHas(src, "a");
    console.log(ok(`${path.relative(root, src).padEnd(28)} ${dim(`${(dur / 1000).toFixed(1)}s · ${dims}${audio ? "" : " · silent"}`)}`));
  } catch {
    console.log(bad("no source video — run: " + dim("aicw-video import <source>")));
  }

  if (hasSource) {
    console.log(`\n${heading("Pipeline")}`);
    await checkArtifact(root, "audio.wav", "16 kHz mono PCM");
    await checkArtifact(root, "transcript.json", "sentence-level transcript");
    await checkArtifact(root, "transcript.srt", "captions");
    await checkArtifact(root, "transcript.words.json", "word-level timing");
    await checkArtifact(root, "analysis/moments.json", "key-moment analysis");
    await checkArtifact(root, "description.json", "summary + key moments");

    console.log(`\n${heading("Outputs")}`);
    const planFile = path.join(root, "shorts", "plan.json");
    if (existsSync(planFile)) {
      const plan = JSON.parse(await readFile(planFile, "utf8"));
      console.log(ok(`shorts/plan.json${" ".repeat(13)} ${dim(`${plan.clips?.length ?? 0} clips`)}`));
    } else console.log(dim("-  shorts/plan.json"));

    const renderedShorts = (await readdir(path.join(root, "shorts")).catch(() => [])).filter((f: string) => f.endsWith(".mp4"));
    if (renderedShorts.length) console.log(ok(`shorts/*.mp4${" ".repeat(17)} ${dim(`${renderedShorts.length} rendered`)}`));
    else console.log(dim("-  shorts/*.mp4"));

    const suggestionsPath = path.join(root, "shorts", "suggestions.json");
    if (existsSync(suggestionsPath)) {
      const s = JSON.parse(await readFile(suggestionsPath, "utf8"));
      console.log(ok(`shorts/suggestions.json${" ".repeat(6)} ${dim(`${s.clips?.length ?? 0} candidates`)}`));
    } else console.log(dim("-  shorts/suggestions.json"));

    const tutorialEntries = (await readdir(path.join(root, "tutorials")).catch(() => []));
    if (tutorialEntries.length) console.log(ok(`tutorials/${" ".repeat(19)} ${dim(`${tutorialEntries.length} tutorial(s)`)}`));
    else console.log(dim("-  tutorials/"));
  }

  console.log(`\n${heading("Next steps")}`);
  if (!hasSource) return;
  const nextSteps: string[] = [];
  if (!existsSync(path.join(root, "transcript.json"))) nextSteps.push(`aicw-video transcribe --project ${root}`);
  if (!existsSync(path.join(root, "analysis", "moments.json"))) nextSteps.push(`aicw-video analyze --project ${root}`);
  if (!existsSync(path.join(root, "shorts", "plan.json"))) nextSteps.push(`aicw-video plan-ui --project ${root}      ${dim("(visual plan builder)")}`);
  const renderedShorts = (await readdir(path.join(root, "shorts")).catch(() => [])).filter((f: string) => f.endsWith(".mp4"));
  if (existsSync(path.join(root, "shorts", "plan.json")) && !renderedShorts.length) nextSteps.push(`aicw-video render --project ${root}`);
  const tutorialEntries = (await readdir(path.join(root, "tutorials")).catch(() => []));
  if (!tutorialEntries.length) nextSteps.push(`aicw-video tutorial --project ${root}    ${dim("(step-by-step from key moments)")}`);
  if (nextSteps.length === 0) console.log(dim("  (everything looks done)"));
  for (const s of nextSteps) console.log(step(s));
  console.log("");
}

async function checkArtifact(root: string, rel: string, label: string): Promise<void> {
  const p = path.join(root, rel);
  if (existsSync(p)) {
    const s = await stat(p);
    console.log(ok(`${rel.padEnd(28)} ${dim(`${label} · ${(s.size / 1024).toFixed(1)} KB`)}`));
  } else {
    console.log(dim(`-  ${rel.padEnd(28)} ${label}`));
  }
}

async function probeDurationMs(videoPath: string): Promise<number> {
  return new Promise((resolve) => {
    let out = "";
    const p = spawn(process.env.FFPROBE_PATH || "ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nokey=1:noprint_wrappers=1", videoPath], { stdio: ["ignore", "pipe", "ignore"] });
    p.stdout.on("data", (d) => { out += d.toString(); });
    p.on("error", () => resolve(0));
    p.on("exit", () => resolve(Math.round(parseFloat(out.trim() || "0") * 1000)));
  });
}

async function probeDims(videoPath: string): Promise<string> {
  return new Promise((resolve) => {
    let out = "";
    const p = spawn(process.env.FFPROBE_PATH || "ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", videoPath], { stdio: ["ignore", "pipe", "ignore"] });
    p.stdout.on("data", (d) => { out += d.toString(); });
    p.on("error", () => resolve("?"));
    p.on("exit", () => resolve(out.trim().replace(",", "×") || "?"));
  });
}

async function streamHas(videoPath: string, spec: "a" | "v"): Promise<boolean> {
  return new Promise((resolve) => {
    let out = "";
    const p = spawn(process.env.FFPROBE_PATH || "ffprobe", ["-v", "error", "-select_streams", spec, "-show_entries", "stream=index", "-of", "csv=p=0", videoPath], { stdio: ["ignore", "pipe", "ignore"] });
    p.stdout.on("data", (d) => { out += d.toString(); });
    p.on("error", () => resolve(false));
    p.on("exit", () => resolve(out.trim().length > 0));
  });
}
