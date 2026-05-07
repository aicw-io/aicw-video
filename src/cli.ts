#!/usr/bin/env node
import readline from "node:readline";
import { spawn, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
void spawnSync; // kept for future use; suppresses ts unused warning
import { startMcpServer } from "./index.js";
import { initProject, importVideo, resolveProject, sourceVideoPath, deriveProjectName, defaultProjectRoot } from "./projectFolder.js";
import { runMainMenu } from "./menu.js";
import { runGo } from "./go.js";
import { extractAudio } from "./audio.js";
import { transcribe } from "./transcribe.js";
import {
  renderShort,
  renderAllShorts,
  PlanSchema,
  type Plan,
  type Clip,
} from "./shorts.js";
import { renderThumbnail, renderAllThumbnails } from "./thumbnail.js";
import { suggestClips } from "./suggest.js";
import { buildPlanUi } from "./plan-builder.js";
import { startPlanServer } from "./plan-server.js";
import { startHomeServer } from "./home-server.js";
import { runDoctor, silentPreflight } from "./doctor.js";
import { runStatus } from "./status.js";
import { analyzeVideo } from "./analyze.js";
import { buildTutorial } from "./tutorial-aicw.js";
import { replaceAudio, swapSourceToReplaced } from "./replace-audio.js";
import { matchAudioFiles } from "./match-audio.js";
import { firstAvailableAiCliToolLabel, getProvider } from "./llm/index.js";
import { describeKeyframes, proposeShortsPlan } from "./ai-tasks.js";
import { ok, bad, warn, step as stepLine, dim, bold, heading } from "./colors.js";

const HELP = `${heading("aicw-video")} — AI-powered video toolkit (CLI + MCP)

${bold("Usage")}
  aicw-video <command> [options]

${bold("Setup")}
  ${dim("(no args)")}                                 In a terminal: launches the hub in your browser.
                                            With piped stdio (e.g. Claude Code spawn): MCP server.
  home                                      Force the hub (MCP setup + project browser).
  menu                                      Open the interactive menu instead.
  doctor                                    Preflight: check ffmpeg,
                                            whisper-cli, encoders, model.
  interactive (or i)                        Guided REPL — paste a local video path.

${bold("Project lifecycle")}
  init <path>                               Create a project folder.
  import <source> [--project <p>]           Local video file.
  transcribe [--project <p>]                Extract audio + run whisper (sentence
                                            and word-level).
  analyze [--project <p>] [--force]         Run everything: scene detect, key-
                                            frames, transcript pairing →
                                            analysis/moments.json.
  go [--project <p>]                        ALL OF IT in one shot: audio →
                                            transcribe → analyze → suggest →
                                            plan UI in browser. Skips already-
                                            done steps. Use this and you're done.
  status [--project <p>]                    Show what's done and what's next.
  where [--project <p>]                     Print the absolute path of the
                                            project folder (for shell scripting).
  reveal [--project <p>]                    Open the project folder in Finder.

${bold("Outputs")}
  tutorial [--project <p>] [--title T]      Step-by-step HTML/MD tutorial from
                  [--steps N] [--format H]  the analysis (key moments + text).
  plan-ui [--project <p>]                   Self-contained HTML plan-builder UI
                                            in /tmp; opens in browser.
  suggest [--project <p>] [--count N]       Heuristic clip suggestions →
                  [--duration S]            shorts/suggestions.json.
  plan [--project <p>] [--no-render]        Show shorts/plan.json, approve, render.
  render [--project <p>] [--clip <id>]      Render shorts. Default: all.
                  [--concurrency N]
  thumbnail [--project <p>] [--clip <id>]   Render JPG cover(s).

${bold("AI steps (standalone — uses configured ai_cli_tools fallback chain)")}
  describe [--project <p>] [--frame-count N]  AI summary + per-keyframe captions →
                                              description.json
  plan-clips [--project <p>] [--count N]      AI proposes a shorts plan →
              [--duration S] [--hint ...]     shorts/plan.json

${bold("Server")}
  mcp                                       MCP server on stdio (default if no args).
  setup-mcp                                 Print MCP setup snippets for
                                            Claude Code, Claude Desktop,
                                            Codex, and ChatGPT.
  setup-claude-code                         Print the 'claude mcp add ...' command
                                            to register this build with Claude Code.
  setup-claude-desktop                      Print the JSON snippet for
                                            claude_desktop_config.json.

${bold("Project resolution")} ${dim("--project → $AICW_VIDEO_PROJECT → current dir")}

${bold("Environment")}
  ${dim("Tools")}     FFMPEG_PATH, FFPROBE_PATH, WHISPER_PATH, EDITOR
  ${dim("Render")}    AICW_VIDEO_ENCODER (libx264|h264_videotoolbox), AICW_VIDEO_RENDER_CONCURRENCY
  ${dim("Whisper")}   AICW_VIDEO_WHISPER_MODEL (path to ggml model)
`;

main().catch((e) => {
  console.error(`aicw-video: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];

  // No-args dispatch:
  //   • TTY (user typed `aicw-video` in terminal) → open the hub in a browser
  //   • piped stdio (Claude Code / Claude Desktop spawn) → MCP server
  // AICW_VIDEO_NO_HOME=1 forces MCP mode even on a TTY (useful for debugging).
  if (!cmd) {
    const wantHome =
      process.stdin.isTTY === true &&
      process.stdout.isTTY === true &&
      process.env.AICW_VIDEO_NO_HOME !== "1";
    if (wantHome) return runHome();
    return startMcpServer();
  }
  if (cmd === "mcp") return startMcpServer();
  if (cmd === "home") return runHome();
  if (cmd === "menu") {
    await runMainMenu({ runInteractiveFlow: runInteractive });
    return;
  }
  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(HELP);
    return;
  }

  const { positional, flags } = parseArgs(argv.slice(1));
  const project = (flags.project as string | undefined) ?? process.env.AICW_VIDEO_PROJECT ?? process.cwd();

  switch (cmd) {
    case "init": {
      const p = positional[0] ?? project;
      console.log(`initialized ${await initProject(p)}`);
      return;
    }
    case "import": {
      const src = positional[0];
      if (!src) throw new Error("import: missing <source>");
      // Auto-derive project path from the source name when --project / $AICW_VIDEO_PROJECT
      // / cwd weren't explicitly set. Default lives at ~/aicw-video/projects/<slug>.
      const explicit = (flags.project as string | undefined) ?? process.env.AICW_VIDEO_PROJECT;
      const target = explicit ?? defaultProjectRoot(deriveProjectName(src));
      const out = await importVideo(src, target);
      console.log(ok(`project ${target}`));
      console.log(ok(`imported ${out}`));
      return;
    }
    case "transcribe": {
      const root = await resolveProject(project);
      if (!existsSync(path.join(root, "audio.wav"))) {
        console.log(`extracted ${await extractAudio(project)}`);
      }
      const t = await transcribe(project);
      console.log(`wrote ${t.json}\nwrote ${t.srt}`);
      return;
    }
    case "plan":
      return planCommand(project, flags);
    case "render": {
      const conc = flags.concurrency ? parseInt(flags.concurrency as string, 10) : undefined;
      if (flags.clip) {
        console.log(`wrote ${await renderShort(project, flags.clip as string)}`);
      } else {
        const outs = await renderAllShorts(project, { concurrency: conc });
        for (const o of outs) console.log(`wrote ${o}`);
      }
      return;
    }
    case "thumbnail": {
      if (flags.clip) {
        console.log(`wrote ${await renderThumbnail(project, flags.clip as string)}`);
      } else {
        const outs = await renderAllThumbnails(project);
        for (const o of outs) console.log(`wrote ${o}`);
      }
      return;
    }
    case "plan-ui": {
      const out = await buildPlanUi(project);
      const planDir = path.dirname(out);
      const server = await startPlanServer(planDir, project);
      console.log(ok(`plan UI live at ${server.url}`));
      console.log(dim(`  saves go to: ${await resolveProject(project)}/shorts/plan.json`));
      console.log(dim(`  Ctrl-C to stop the server`));
      if (process.platform === "darwin") {
        spawn("open", [server.url], { stdio: "ignore", detached: true }).unref();
      }
      // Hold the process open until the user Ctrl-Cs. close() on signal.
      await new Promise<void>((resolve) => {
        const stop = async (): Promise<void> => {
          await server.close();
          resolve();
        };
        process.on("SIGINT", stop);
        process.on("SIGTERM", stop);
      });
      return;
    }
    case "interactive":
    case "i": {
      await runInteractive();
      return;
    }
    case "doctor": {
      const r = await runDoctor();
      process.exit(r.allOk ? 0 : 1);
    }
    case "status": {
      await runStatus(project);
      return;
    }
    case "where": {
      // Resolve and print only the absolute project path, no decoration —
      // designed for `cp -r "$(aicw-video where -p X)" backup/`.
      const root = await resolveProject(project);
      console.log(root);
      return;
    }
    case "reveal": {
      const root = await resolveProject(project);
      if (process.platform === "darwin") {
        spawn("open", [root], { stdio: "ignore", detached: true }).unref();
        console.log(ok(`opened ${root} in Finder`));
      } else {
        console.log(root);
      }
      return;
    }
    case "setup-claude-code": {
      console.log(bold("Register aicw-video with Claude Code:") + "\n");
      printClaudeCodeMcpSetup();
      console.log("\n" + dim("Then in any Claude Code session: \"use aicw-video to ...\""));
      console.log(dim("Verify it landed:        claude mcp list"));
      console.log(dim("Remove it:               claude mcp remove aicw-video"));
      return;
    }
    case "setup-claude-desktop": {
      console.log(bold("Add aicw-video to Claude Desktop:") + "\n");
      console.log(dim(`  edit  ~/Library/Application Support/Claude/claude_desktop_config.json`));
      console.log(dim("  merge in:") + "\n");
      console.log(JSON.stringify(claudeDesktopMcpSnippet(), null, 2));
      console.log("\n" + dim("Quit Claude Desktop with ⌘Q (not just close window) and relaunch."));
      return;
    }
    case "setup-codex": {
      printCodexMcpSetup();
      return;
    }
    case "setup-chatgpt": {
      printChatGptMcpSetup();
      return;
    }
    case "setup-mcp": {
      printAllMcpSetup();
      return;
    }
    case "analyze": {
      const force = flags.force === true;
      console.log(stepLine(`analyzing ${project}...`));
      const { analysis, cached } = await analyzeVideo(project, { force });
      if (cached) console.log(ok(`reused cached analysis ${dim(`(${analysis.moments.length} moments, pass --force to re-run)`)}`));
      else console.log(ok(`wrote analysis/moments.json ${dim(`(${analysis.moments.length} key moments)`)}`));
      return;
    }
    case "go": {
      await runGo(project);
      return;
    }
    case "describe": {
      const frameCount = flags["frame-count"] ? parseInt(flags["frame-count"] as string, 10) : 6;
      console.log(stepLine(`describing keyframes with ${firstAvailableAiCliToolLabel({ requiresImages: true }) || "configured AI CLI"} (frame-count=${frameCount})…`));
      const provider = getProvider();
      const r = await describeKeyframes(provider, project, frameCount);
      console.log(ok(`wrote ${r.outPath}`));
      console.log(dim(`  ${r.keyMomentCount} key moments`));
      console.log(dim(`  Summary: ${r.summary.slice(0, 200)}${r.summary.length > 200 ? "…" : ""}`));
      return;
    }
    case "plan-clips": {
      const count = flags.count ? parseInt(flags.count as string, 10) : 3;
      const target = flags.duration ? parseInt(flags.duration as string, 10) : 25;
      const hint = (flags.hint as string | undefined) ?? undefined;
      console.log(stepLine(`proposing shorts plan with ${firstAvailableAiCliToolLabel() || "configured AI CLI"} (count=${count}, target=${target}s)…`));
      const provider = getProvider();
      const r = await proposeShortsPlan(provider, project, { count, target_duration_sec: target, hint });
      console.log(ok(`wrote ${r.outPath}`));
      console.log(dim(`  ${r.clipCount} clips:`));
      console.log(r.summary);
      return;
    }
    case "tutorial": {
      const title = (flags.title as string) || undefined;
      const steps = flags.steps ? parseInt(flags.steps as string, 10) : undefined;
      const format = (flags.format as "html" | "md" | "both" | undefined) || "both";
      console.log(stepLine(`building tutorial...`));
      const { outputDir, files } = await buildTutorial(project, { title, steps, format });
      console.log(ok(`wrote ${outputDir}`));
      for (const f of files) console.log(`     ${dim(f)}`);
      return;
    }
    case "replace-audio": {
      const audio = (flags.audio as string | undefined) ?? positional[0];
      if (!audio) throw new Error("replace-audio: missing --audio <path>");
      console.log(stepLine(`aligning external audio to video via transcript match…`));
      const r = await replaceAudio(project, audio);
      console.log(ok(`wrote ${r.outPath}`));
      console.log(dim(`  diagnostics: ${r.diagnosticsPath}`));
      console.log(
        dim(
          `  offset: ${(r.offsetMs / 1000).toFixed(3)}s ${
            r.offsetMs >= 0 ? "(external started after video)" : "(external started before video)"
          }`,
        ),
      );
      console.log(dim(`  matched: ${JSON.stringify(r.matchedPhrase)} (${r.matchedWordCount} words)`));
      console.log(dim(`  to make this canonical: aicw-video swap-source --to replaced`));
      return;
    }
    case "match-audio": {
      const folder = (flags.folder as string | undefined) ?? positional[0];
      if (!folder) throw new Error("match-audio: missing --folder <path>");
      console.log(stepLine(`scanning ${folder} (cached transcripts reused)…`));
      const report = await matchAudioFiles(folder);
      console.log("");
      console.log(bold("Pairings:"));
      for (const v of report.videos) {
        if (v.best) {
          console.log(
            `  ${ok("✓")} ${v.videoName}  →  ${v.best.audioName}  ${dim(
              `(${v.best.totalMatchedWords}w · ${v.best.anchorCount} anchors · longest ${v.best.longestAnchor})`,
            )}`,
          );
        } else {
          console.log(
            `  ${warn("?")} ${v.videoName}  →  ${dim("no clear match")}  ${dim(
              `(top: ${v.allScores[0]?.audioName ?? "-"} ${v.allScores[0]?.totalMatchedWords ?? 0}w)`,
            )}`,
          );
        }
      }
      if (report.unpairedAudios.length > 0) {
        console.log("");
        console.log(`  ${dim("Unpaired audio:")} ${report.unpairedAudios.join(", ")}`);
      }
      return;
    }
    case "swap-source": {
      const to = (flags.to as string | undefined) ?? "replaced";
      if (to === "replaced") {
        const target = await swapSourceToReplaced(project);
        console.log(ok(`source swapped → ${target}`));
        return;
      }
      throw new Error(`swap-source: --to must be 'replaced' (got '${to}')`);
    }
    case "suggest": {
      const count = flags.count ? parseInt(flags.count as string, 10) : undefined;
      const targetDurationSec = flags.duration ? parseInt(flags.duration as string, 10) : undefined;
      const { suggestions, outPath } = await suggestClips(project, { count, targetDurationSec });
      console.log(`wrote ${outPath}\n`);
      for (const s of suggestions) {
        console.log(
          `  ${s.id}  ${(s.start_ms / 1000).toFixed(0).padStart(3)}s–${(s.end_ms / 1000).toFixed(0).padStart(3)}s  score=${s.score.toFixed(2)}  ${s.reason}`,
        );
      }
      return;
    }
    default:
      console.error(`aicw-video: unknown command '${cmd}'\n\n${HELP}`);
      process.exit(1);
  }
}

async function runHome(): Promise<void> {
  const handle = await startHomeServer();
  console.log(ok(`AICW Video is live at ${handle.url}`));
  console.log(dim(`  shows MCP setup + browses ~/aicw-video/projects/`));
  console.log(dim(`  Ctrl-C to stop`));
  if (process.platform === "darwin") {
    spawn("open", [handle.url], { stdio: "ignore", detached: true }).unref();
  }
  await new Promise<void>((resolve) => {
    const stop = async (): Promise<void> => {
      await handle.close();
      resolve();
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
}

function mcpInvocation(): { command: string; args: string[]; display: string } {
  const cliPath = path.resolve(process.argv[1] || "");
  const isGlobal = !cliPath.endsWith(".js") || cliPath.includes("/node_modules/.bin/");
  if (isGlobal) {
    return { command: "aicw-video", args: ["mcp"], display: "aicw-video mcp" };
  }
  return { command: "node", args: [cliPath, "mcp"], display: `node ${shellQuote(cliPath)} mcp` };
}

function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

function claudeDesktopMcpSnippet(): { mcpServers: Record<string, { command: string; args: string[] }> } {
  const invocation = mcpInvocation();
  return {
    mcpServers: {
      "aicw-video": {
        command: invocation.command,
        args: invocation.args,
      },
    },
  };
}

function printClaudeCodeMcpSetup(): void {
  console.log(`  claude mcp add aicw-video -- ${mcpInvocation().display}`);
}

function printCodexMcpSetup(): void {
  const invocation = mcpInvocation();
  console.log(bold("Add aicw-video to Codex CLI:") + "\n");
  console.log(dim("  edit  ~/.codex/config.toml"));
  console.log(dim("  add:") + "\n");
  console.log(`[mcp_servers.aicw-video]
command = "${invocation.command}"
args = ${JSON.stringify(invocation.args)}`);
  console.log("\n" + dim("Restart Codex, then ask: \"Use aicw-video MCP. Call list_projects.\""));
}

function printChatGptMcpSetup(): void {
  const invocation = mcpInvocation();
  console.log(bold("ChatGPT Desktop / ChatGPT Developer Mode:") + "\n");
  console.log("AICW Video currently exposes a local stdio MCP server:");
  console.log(`  ${invocation.display}`);
  console.log("");
  console.log("ChatGPT Developer Mode currently imports remote MCP servers using SSE or streaming HTTP.");
  console.log("Do not paste the local stdio command into ChatGPT's remote MCP URL field.");
  console.log("");
  console.log("For OpenAI local-MCP workflows today, use Codex CLI with:");
  console.log(`[mcp_servers.aicw-video]
command = "${invocation.command}"
args = ${JSON.stringify(invocation.args)}`);
  console.log("Once AICW Video has an HTTP MCP mode, use ChatGPT Settings -> Apps/Connectors -> Developer Mode and add that HTTPS MCP URL.");
}

function printAllMcpSetup(): void {
  const invocation = mcpInvocation();
  console.log(bold("AICW Video MCP server command:") + "\n");
  console.log(`  ${invocation.display}`);

  console.log("\n" + bold("Claude Code") + "\n");
  printClaudeCodeMcpSetup();
  console.log(dim("  verify: claude mcp list"));
  console.log(dim("  remove: claude mcp remove aicw-video"));

  console.log("\n" + bold("Claude Desktop") + "\n");
  console.log(dim("  edit  ~/Library/Application Support/Claude/claude_desktop_config.json"));
  console.log(dim("  merge in:") + "\n");
  console.log(JSON.stringify(claudeDesktopMcpSnippet(), null, 2));
  console.log(dim("\n  Quit Claude Desktop with Cmd+Q and relaunch."));

  console.log("");
  printCodexMcpSetup();

  console.log("");
  printChatGptMcpSetup();
}

async function planCommand(
  project: string,
  flags: Record<string, string | boolean>,
): Promise<void> {
  const root = await resolveProject(project);
  const planPath = path.join(root, "shorts", "plan.json");
  if (!existsSync(planPath)) {
    console.error(
      `no plan at ${planPath}\n` +
        `generate one with the hub, MCP save_clip_plan, or write it yourself.`,
    );
    process.exit(2);
  }
  const plan = PlanSchema.parse(JSON.parse(await readFile(planPath, "utf8")));
  printPlan(plan, planPath);

  if (flags.render === false) return;

  const ans = (await prompt("Approve and render all clips? [y/N/e=edit] ")).trim().toLowerCase();
  if (ans === "y" || ans === "yes") {
    const outs = await renderAllShorts(project);
    for (const o of outs) console.log(`wrote ${o}`);
    return;
  }
  if (ans === "e" || ans === "edit") {
    const editor = process.env.EDITOR || "vi";
    spawnSync(editor, [planPath], { stdio: "inherit" });
    return planCommand(project, flags);
  }
  console.log(`aborted (plan preserved at ${planPath})`);
}

function printPlan(plan: Plan, planPath: string): void {
  console.log(`\nPlan: ${planPath} (${plan.clips.length} clips)\n`);
  plan.clips.forEach((c: Clip, i: number) => {
    const dur = ((c.end_ms - c.start_ms) / 1000).toFixed(1);
    const line1 =
      `  ${String(i + 1).padStart(2, " ")}. ${c.id.padEnd(12)} ` +
      `${fmtTime(c.start_ms)} → ${fmtTime(c.end_ms)}  (${dur}s)  ` +
      `reframe=${c.reframe ?? "crop"}, captions=${c.caption_style ?? "plain"}`;
    console.log(line1);
    console.log(`      Title: ${c.title}`);
    if (c.caption_lines && c.caption_lines.length) {
      console.log(`      Captions:`);
      for (const l of c.caption_lines) console.log(`        • ${l}`);
    }
    console.log("");
  });
}

function fmtTime(ms: number): string {
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const ms3 = ms % 1000;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(ms3).padStart(3, "0")}`;
}

function parseArgs(args: string[]): {
  positional: string[];
  flags: Record<string, string | boolean>;
} {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--no-")) {
      flags[a.slice(5)] = false;
      continue;
    }
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
      continue;
    }
    positional.push(a);
  }
  return { positional, flags };
}

function prompt(q: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => rl.question(q, (a) => { rl.close(); resolve(a); }));
}

async function runInteractive(): Promise<void> {
  // Quiet by default. Set AICW_VIDEO_VERBOSE=1 to see the full doctor report up front.
  if (process.env.AICW_VIDEO_VERBOSE === "1") {
    console.log(`\n${heading("aicw-video")} — interactive mode`);
    console.log(dim("(Enter accepts defaults; Ctrl-C exits)\n"));
    try { await runDoctor(); } catch { /* non-fatal */ }
  } else {
    console.log(`\n${heading("New project")}  ${dim("(Enter accepts defaults; Ctrl-C exits)")}\n`);
    // Silent preflight — only speak up when something's actually broken.
    try {
      const pre = await silentPreflight();
      if (!pre.allOk) {
        console.log(warn(`missing required tools: ${pre.missing.join(", ")}`));
        console.log(dim(`run "aicw-video doctor" for install hints\n`));
        const cont = (await prompt("continue anyway? [y/N]: ")).trim().toLowerCase();
        if (cont !== "y" && cont !== "yes") return;
      }
    } catch { /* preflight crashing shouldn't kill interactive */ }
  }

  // 1. Source first — so we can derive the project folder name from the file.
  const source = (await prompt("Source video (local file path): ")).trim();
  if (!source) { console.error("aborted (no source)"); return; }

  // 2. Project folder — default to ~/aicw-video/projects/<source-slug>. Survives reboot.
  const derived = deriveProjectName(source);
  const defaultProject = defaultProjectRoot(derived);
  const projectInput = (await prompt(`Project folder [${defaultProject}]: `)).trim();
  const projectPath = projectInput || defaultProject;
  await initProject(projectPath);
  console.log(`  ✓ initialized ${projectPath}\n`);

  // 3. Import the source — retry loop on failure
  let sourceImported = false;
  try {
    await sourceVideoPath(projectPath);
    sourceImported = true;
    console.log(`  ✓ source video already present in ${projectPath}/source/\n`);
  } catch {}
  if (!sourceImported) {
    let imported = false;
    let currentSource = source;
    while (!imported) {
      try {
        const dst = await importVideo(currentSource, projectPath);
        console.log(`  ✓ imported ${dst}\n`);
        imported = true;
      } catch (e) {
        console.error(`  ✗ ${e instanceof Error ? e.message : String(e)}`);
        currentSource = (await prompt("paste a different source (or empty to abort): ")).trim();
        if (!currentSource) return;
      }
    }
  }

  // 3. Transcribe (skip prompt if no audio detected — but cheap to try anyway)
  const wantTranscribe = (await prompt("Transcribe audio? [Y/n]: ")).trim().toLowerCase();
  if (wantTranscribe === "" || wantTranscribe === "y" || wantTranscribe === "yes") {
    console.log("  transcribing… (whisper-cli, may auto-download model on first run)");
    try {
      const { json, srt, words } = await transcribe(projectPath);
      console.log(`  ✓ ${json}`);
      console.log(`  ✓ ${srt}`);
      console.log(`  ✓ ${words}\n`);
    } catch (e) {
      console.error(`  ✗ transcribe failed: ${e instanceof Error ? e.message : String(e)}`);
      console.error("  (continuing — captions can be entered manually in the plan UI)\n");
    }
  }

  // 4. Centralised analysis — scene detection + keyframes + transcript pairing
  const wantAnalyze = (await prompt("Run full analysis (scene detect + keyframes + transcript pairing)? [Y/n]: ")).trim().toLowerCase();
  if (wantAnalyze === "" || wantAnalyze === "y" || wantAnalyze === "yes") {
    console.log(stepLine("analyzing… (saves analysis/moments.json with frame paths and timing)"));
    try {
      const { analysis, cached } = await analyzeVideo(projectPath, { transcribe: false });
      if (cached) console.log(ok(`reused cached analysis ${dim(`(${analysis.moments.length} moments)`)}\n`));
      else console.log(ok(`${analysis.moments.length} key moments saved to analysis/moments.json\n`));
    } catch (e) {
      console.error(bad(`analyze failed: ${e instanceof Error ? e.message : String(e)}\n`));
    }
  }

  // 5. Suggest clips
  const wantSuggest = (await prompt("Suggest clips? [Y/n]: ")).trim().toLowerCase();
  if (wantSuggest === "" || wantSuggest === "y" || wantSuggest === "yes") {
    const countStr = (await prompt("  how many [5]: ")).trim();
    const durStr = (await prompt("  target duration in seconds [25]: ")).trim();
    const count = countStr ? parseInt(countStr, 10) : 5;
    const targetDurationSec = durStr ? parseInt(durStr, 10) : 25;
    const { suggestions, outPath } = await suggestClips(projectPath, { count, targetDurationSec });
    console.log(ok(`${outPath} ${dim(`(${suggestions.length} clips)`)}`));
    for (const s of suggestions) {
      console.log(`     ${dim(`${s.id}  ${(s.start_ms / 1000).toFixed(0)}s–${(s.end_ms / 1000).toFixed(0)}s  score=${s.score.toFixed(2)}`)}`);
    }
    console.log("");
  }

  // 6. Tutorial
  const wantTutorial = (await prompt("Build a step-by-step tutorial (HTML+MD)? [y/N]: ")).trim().toLowerCase();
  if (wantTutorial === "y" || wantTutorial === "yes") {
    const title = (await prompt("  tutorial title: ")).trim() || "Tutorial";
    console.log(stepLine("rendering tutorial..."));
    try {
      const { outputDir, files } = await buildTutorial(projectPath, { title });
      console.log(ok(`${outputDir}`));
      for (const f of files) console.log(`     ${dim(f)}`);
      console.log("");
    } catch (e) {
      console.error(bad(`tutorial failed: ${e instanceof Error ? e.message : String(e)}\n`));
    }
  }

  // 7. Plan UI
  const wantUi = (await prompt("Open plan UI in browser? [Y/n]: ")).trim().toLowerCase();
  if (wantUi === "" || wantUi === "y" || wantUi === "yes") {
    console.log(stepLine("building plan UI…"));
    const out = await buildPlanUi(projectPath);
    console.log(ok(out));
    if (process.platform === "darwin") {
      spawn("open", [out], { stdio: "ignore", detached: true }).unref();
      console.log(ok("opened in default browser\n"));
    } else {
      console.log(`  ${dim(`open with: open '${out}'`)}\n`);
    }
  }

  console.log(`${ok(`project ready at ${projectPath}`)}`);
  console.log(dim(`  next: aicw-video status --project ${projectPath}\n        aicw-video render --project ${projectPath}`));
}

function dateStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
