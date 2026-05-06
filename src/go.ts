import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { resolveProject } from "./projectFolder.js";
import { extractAudio } from "./audio.js";
import { transcribe } from "./transcribe.js";
import { analyzeVideo } from "./analyze.js";
import { suggestClips } from "./suggest.js";
import { buildPlanUi } from "./plan-builder.js";
import { ok, dim, step as stepLine, heading, bad } from "./colors.js";
import { aiCliAvailable, firstAvailableAiCliToolLabel, getProvider } from "./llm/index.js";
import { describeKeyframes, proposeShortsPlan } from "./ai-tasks.js";

// Single end-to-end "go" command: ensure audio → transcript → analysis →
// suggestions → plan UI in one pass. Skips steps that already produced their
// output. Opens the plan UI in the default browser at the end (macOS).
//
export async function runGo(projectPath: string, opts: { open?: boolean } = {}): Promise<{ planHtml: string }> {
  const root = await resolveProject(projectPath);
  console.log(`\n${heading("aicw-video go")}  ${dim(root)}\n`);

  // 1. Audio
  const audioPath = path.join(root, "audio.wav");
  if (!existsSync(audioPath)) {
    console.log(stepLine("extracting audio…"));
    await extractAudio(projectPath);
    console.log(ok(`audio.wav`));
  } else {
    console.log(ok(`audio.wav ${dim("(already extracted)")}`));
  }

  // 2. Transcribe — only when audio is non-empty (silent screencaps may have a
  // dummy audio stream; whisper still tolerates that).
  const transcriptPath = path.join(root, "transcript.json");
  if (!existsSync(transcriptPath)) {
    console.log(stepLine("transcribing with whisper.cpp…"));
    try {
      await transcribe(projectPath);
      console.log(ok(`transcript.json + .srt + .words.json`));
    } catch (e) {
      console.log(dim(`(transcribe skipped: ${e instanceof Error ? e.message : e})`));
    }
  } else {
    console.log(ok(`transcript.json ${dim("(already transcribed)")}`));
  }

  // 3. Analyze (scene detect + keyframes + transcript pairing). Cached on second run.
  const analysisPath = path.join(root, "analysis", "moments.json");
  if (!existsSync(analysisPath)) {
    console.log(stepLine("analyzing — scene detect + keyframes + transcript pairing…"));
    const { analysis } = await analyzeVideo(projectPath);
    console.log(ok(`analysis/moments.json ${dim(`(${analysis.moments.length} moments)`)}`));
  } else {
    console.log(ok(`analysis/moments.json ${dim("(already analyzed — pass --force to rebuild)")}`));
  }

  // 4. AI description (configured CLI fallback, standalone). Skipped when no
  // AI CLI tool is available — heuristic suggestClips still produces a usable plan.
  const descPath = path.join(root, "description.json");
  if (!existsSync(descPath)) {
    if (aiCliAvailable({ requiresImages: true })) {
      console.log(stepLine(`describing keyframes with ${firstAvailableAiCliToolLabel({ requiresImages: true })}…`));
      try {
        const provider = getProvider();
        const r = await describeKeyframes(provider, projectPath);
        console.log(ok(`description.json ${dim(`(${r.keyMomentCount} key moments)`)}`));
      } catch (e) {
        console.log(bad(`describe failed: ${e instanceof Error ? e.message : e}`));
      }
    } else {
      console.log(dim(`describe skipped — no configured image-capable AI CLI is available; edit config.json ai_cli_tools or run through MCP`));
    }
  } else {
    console.log(ok(`description.json ${dim("(already described)")}`));
  }

  // 5. AI shorts plan (configured CLI fallback). If it succeeds we have an editable
  // plan.json the user can tweak in the hub. If no AI CLI is available, we
  // fall through to heuristic suggestions and let the user build the plan.
  const planPath = path.join(root, "shorts", "plan.json");
  let planFromAi = false;
  if (!existsSync(planPath) && aiCliAvailable()) {
    console.log(stepLine(`proposing shorts plan with ${firstAvailableAiCliToolLabel()}…`));
    try {
      const provider = getProvider();
      const r = await proposeShortsPlan(provider, projectPath, { count: 3, target_duration_sec: 25 });
      console.log(ok(`shorts/plan.json ${dim(`(${r.clipCount} clips)`)}`));
      planFromAi = true;
    } catch (e) {
      console.log(bad(`plan-clips failed: ${e instanceof Error ? e.message : e}`));
    }
  } else if (existsSync(planPath)) {
    console.log(ok(`shorts/plan.json ${dim("(already exists)")}`));
    planFromAi = true;
  }

  // 6. Heuristic suggestions (cheap; always run so the latest transcript and
  // scene data feed into the plan UI's "suggested" sidebar).
  console.log(stepLine("scoring clip candidates (heuristic)…"));
  const { suggestions, outPath: suggestionsPath } = await suggestClips(projectPath);
  console.log(ok(`shorts/suggestions.json ${dim(`(${suggestions.length} candidates)`)}`));
  void planFromAi;

  // 5. Build plan UI and open it.
  console.log(stepLine("building plan-builder UI (preview frames + style swatches)…"));
  const planHtml = await buildPlanUi(projectPath);
  console.log(ok(planHtml));

  if (opts.open !== false && process.platform === "darwin") {
    spawn("open", [planHtml], { stdio: "ignore", detached: true }).unref();
    console.log(ok(`opened in browser`));
  }

  console.log(`\n${heading("Next")}`);
  console.log(`  • In the browser, pick clips, styles, durations, then click "Copy shell command".`);
  console.log(`  • Paste it in your terminal — runs ${dim("aicw-video render")} which creates`);
  console.log(`    ${dim("shorts/render-<timestamp>/")} so each iteration is preserved.`);
  console.log(`  • To regenerate: tweak the plan UI selections and copy/paste again.`);
  console.log(`  • From Claude / ChatGPT / Codex, use the AICW Video MCP tools`);
  console.log(`    ${dim("analyze_project")}, ${dim("get_clip_plan")}, and ${dim("save_clip_plan")}.`);
  console.log(`  ${dim("• Per-clip voice-over is available in each clip's Settings tab.")}`);
  void suggestionsPath;
  return { planHtml };
}
