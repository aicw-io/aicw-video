import readline from "node:readline";
import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { ok, bad, dim, bold, heading, promptText } from "./colors.js";
import { runDoctor } from "./doctor.js";
import { runStatus } from "./status.js";
import { defaultProjectRoot } from "./projectFolder.js";

function p(q: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((r) => rl.question(q, (a) => { rl.close(); r(a); }));
}

const SEP = `${"─".repeat(48)}`;

export async function runMainMenu(opts: { runInteractiveFlow: () => Promise<void> }): Promise<void> {
  for (;;) {
    console.log(`\n${heading("aicw-video")}  ${dim("AI-powered video toolkit (MCP plugin)")}`);
    console.log(SEP);
    console.log(dim("  Most work happens inside Claude / Codex / ChatGPT once aicw-video"));
    console.log(dim("  is connected as an MCP plugin. Use this CLI to set it up and explore."));
    console.log("");
    console.log(`  ${bold("1)")} ${bold("Setup")} — connect to Claude / ChatGPT / Codex ${dim("(start here)")}`);
    console.log(`  ${bold("2)")} How to use it from your AI ${dim("(natural-language commands)")}`);
    console.log(`  ${bold("3)")} Open existing project ${dim("(status, reveal, render manually)")}`);
    console.log(`  ${bold("4)")} Doctor — check installed tools`);
    console.log(`  ${bold("5)")} Process locally without AI ${dim("(no host needed; ffmpeg-only path)")}`);
    console.log(`  ${bold("q)")} Quit`);
    const a = (await p("\nChoice [1]: ")).trim().toLowerCase();
    if (a === "q" || a === "quit" || a === "exit") return;
    try {
      if (a === "1" || a === "") {
        await setupMenu();
      } else if (a === "2") {
        printAiUsage();
        await p("\npress Enter to return to menu… ");
      } else if (a === "3") {
        await openProjectMenu();
      } else if (a === "4") {
        await runDoctor();
        await p("\npress Enter to return to menu… ");
      } else if (a === "5") {
        await opts.runInteractiveFlow();
        await p("\npress Enter to return to menu… ");
      } else {
        console.log(bad("invalid choice"));
      }
    } catch (e) {
      console.error(bad(`error: ${e instanceof Error ? e.message : String(e)}`));
      await p("\npress Enter to return to menu… ");
    }
  }
}

// ─── How-to cheat sheet ─────────────────────────────────────────────

export function printAiUsage(): void {
  console.log(`\n${heading("Use aicw-video from Claude / ChatGPT / Codex")}\n`);
  console.log(bold("Steps") + dim(" — paste each prompt into your AI:") + "\n");
  console.log(`  1. ${promptText('"analyze video at <local-path>"')}`);
  console.log(`  2. ${promptText('"plan clips"')}                ${dim("(shows the plan)")}`);
  console.log(`  3. ${promptText('"make clips"')}                ${dim("(makes clips according to the plan)")}`);
  console.log(`  4. ${promptText('"update plan: <change>"')}     ${dim("(updates the plan, then say \"make clips\" again)")}`);
  console.log("");
  console.log(bold("CLI helpers") + dim(" (terminal):") + "  " + dim("aicw-video status | where | reveal | doctor"));
}

// ─── Setup submenu ──────────────────────────────────────────────────

async function setupMenu(): Promise<void> {
  for (;;) {
    console.log(`\n${heading("Setup")}  ${dim("connect aicw-video to your AI host")}`);
    console.log(SEP);
    console.log(`  ${bold("1)")} Claude Code ${dim("(CLI — recommended)")}`);
    console.log(`  ${bold("2)")} Claude Desktop`);
    console.log(`  ${bold("3)")} Codex CLI ${dim("(OpenAI)")}`);
    console.log(`  ${bold("4)")} ChatGPT Desktop ${dim("(MCP varies by build)")}`);
    console.log(`  ${bold("?)")} Show example AI prompts ${dim("(what to type once connected)")}`);
    console.log(`  ${bold("b)")} Back`);
    const a = (await p("\nChoice: ")).trim().toLowerCase();
    if (a === "b" || a === "back" || a === "0" || a === "") return;
    if (a === "1") { printClaudeCode(); printAfterSetup(); }
    else if (a === "2") { printClaudeDesktop(); printAfterSetup(); }
    else if (a === "3") { printCodexCli(); printAfterSetup(); }
    else if (a === "4") { printChatGPT(); printAfterSetup(); }
    else if (a === "?" || a === "help") printAiUsage();
    else { console.log(bad("invalid choice")); continue; }
    await p("\npress Enter to continue… ");
  }
}

function printAfterSetup(): void {
  console.log(`\n${dim("Once connected, type \"How to use it from your AI\" (option 2 in main menu)")}`);
  console.log(`${dim("for example prompts you can paste into your AI host.")}`);
}

function cliBin(): string {
  return path.resolve(process.argv[1] || "");
}

function printClaudeCode(): void {
  const cli = cliBin();
  console.log(`\n${bold("Register with Claude Code")}\n`);
  console.log(`  claude mcp add aicw-video -- node ${cli} mcp\n`);
  console.log(`${dim("Verify:")} claude mcp list`);
  console.log(`${dim("Remove:")} claude mcp remove aicw-video`);
  console.log(`${dim("Then in any Claude Code session: \"use aicw-video to ...\"")}`);
}

function printClaudeDesktop(): void {
  const cli = cliBin();
  console.log(`\n${bold("Register with Claude Desktop")}\n`);
  console.log(`  edit ${dim("~/Library/Application Support/Claude/claude_desktop_config.json")}`);
  console.log(`  merge in:\n`);
  console.log(`{
  "mcpServers": {
    "aicw-video": {
      "command": "node",
      "args": ["${cli}", "mcp"]
    }
  }
}`);
  console.log(`\n${dim("Quit Claude Desktop with ⌘Q (closing the window isn't enough) and relaunch.")}`);
}

function printCodexCli(): void {
  const cli = cliBin();
  console.log(`\n${bold("Register with Codex CLI (OpenAI)")}\n`);
  console.log(`  edit ${dim("~/.codex/config.toml")}\n  add:\n`);
  console.log(`[mcp_servers.aicw-video]
command = "node"
args = ["${cli}", "mcp"]`);
}

function printChatGPT(): void {
  console.log(`\n${bold("ChatGPT Desktop")}\n`);
  console.log(`ChatGPT Desktop's MCP support is build-dependent. Check Settings →`);
  console.log(`Connectors / Developer Mode. If present, the JSON shape matches Claude`);
  console.log(`Desktop's:`);
  printClaudeDesktop();
  console.log(`\n${dim("If not available in your build, use Codex CLI (option 3 in Setup).")}`);
}

// ─── Open project submenu ───────────────────────────────────────────

async function openProjectMenu(): Promise<void> {
  const projectsRoot = path.dirname(defaultProjectRoot("x"));
  let entries: string[] = [];
  try {
    entries = (await readdir(projectsRoot, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    entries = [];
  }
  console.log(`\n${heading("Open existing project")}  ${dim(projectsRoot)}`);
  console.log(SEP);
  if (entries.length === 0) {
    console.log(dim("(no projects yet — start with \"New project\" from the main menu)"));
    await p("\npress Enter to return to menu… ");
    return;
  }
  entries.forEach((e, i) => console.log(`  ${bold(`${i + 1})`)} ${e}`));
  console.log(`  ${bold("p)")} Enter a custom path`);
  console.log(`  ${bold("b)")} Back`);
  const a = (await p("\nChoice: ")).trim().toLowerCase();
  if (a === "b" || a === "0" || a === "") return;
  let projectPath: string | null = null;
  if (a === "p") {
    const custom = (await p("project path: ")).trim();
    if (!custom) return;
    projectPath = custom;
  } else {
    const idx = parseInt(a, 10) - 1;
    if (Number.isNaN(idx) || idx < 0 || idx >= entries.length) {
      console.log(bad("invalid choice"));
      return;
    }
    projectPath = path.join(projectsRoot, entries[idx]!);
  }
  await projectActionsMenu(projectPath);
}

async function projectActionsMenu(projectPath: string): Promise<void> {
  for (;;) {
    console.log(`\n${heading("Project")} ${path.basename(projectPath)}  ${dim(projectPath)}`);
    console.log(SEP);
    console.log(`  ${bold("g)")} ${bold("Go")} ${dim("— audio + transcribe + analyze + plan UI in one shot")}`);
    console.log(`  ${bold("1)")} Status`);
    console.log(`  ${bold("2)")} Reveal in Finder`);
    console.log(`  ${bold("3)")} Transcribe ${dim("(audio → whisper)")}`);
    console.log(`  ${bold("4)")} Analyze ${dim("(scene + keyframes)")}`);
    console.log(`  ${bold("5)")} Suggest clips`);
    console.log(`  ${bold("6)")} Open plan-builder UI in browser`);
    console.log(`  ${bold("7)")} Render shorts ${dim("(into shorts/render-<ts>/)")}`);
    console.log(`  ${bold("8)")} Build tutorial`);
    console.log(`  ${bold("b)")} Back`);
    const a = (await p("\nChoice: ")).trim().toLowerCase();
    if (a === "b" || a === "0" || a === "") return;
    try {
      if (a === "g" || a === "go") {
        const m = await import("./go.js");
        await m.runGo(projectPath);
      } else if (a === "1") {
        await runStatus(projectPath);
      } else if (a === "2") {
        if (process.platform === "darwin") {
          spawn("open", [projectPath], { stdio: "ignore", detached: true }).unref();
        }
        console.log(ok(`opened ${projectPath}`));
      } else if (a === "3") {
        const m = await import("./transcribe.js");
        const t = await m.transcribe(projectPath);
        console.log(ok(`wrote ${t.json}`));
        console.log(ok(`wrote ${t.srt}`));
        console.log(ok(`wrote ${t.words}`));
      } else if (a === "4") {
        const m = await import("./analyze.js");
        const r = await m.analyzeVideo(projectPath);
        console.log(ok(`${r.cached ? "reused" : "wrote"} analysis (${r.analysis.moments.length} moments)`));
      } else if (a === "5") {
        const m = await import("./suggest.js");
        const r = await m.suggestClips(projectPath);
        console.log(ok(`wrote ${r.outPath} (${r.suggestions.length} clips)`));
      } else if (a === "6") {
        const m = await import("./plan-builder.js");
        const out = await m.buildPlanUi(projectPath);
        if (process.platform === "darwin") {
          spawn("open", [out], { stdio: "ignore", detached: true }).unref();
        }
        console.log(ok(out));
      } else if (a === "7") {
        const m = await import("./shorts.js");
        const outs = await m.renderAllShorts(projectPath);
        for (const o of outs) console.log(ok(o));
      } else if (a === "8") {
        const title = (await p("title (Enter for default): ")).trim() || "Tutorial";
        const m = await import("./tutorial-aicw.js");
        const r = await m.buildTutorial(projectPath, { title });
        console.log(ok(r.outputDir));
      } else {
        console.log(bad("invalid choice"));
        continue;
      }
    } catch (e) {
      console.error(bad(`error: ${e instanceof Error ? e.message : String(e)}`));
    }
    await p("\npress Enter to continue… ");
  }
}
