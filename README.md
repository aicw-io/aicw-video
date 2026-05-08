# AICW Video

AICW Video is an open-source AI agent and standalone app for editing human
video interviews into captioned, privacy-aware social clips.

## Quick Links

- [Features](#features)
- [Screenshots and demo](#screenshots-and-demo)
- [Requirements](#requirements)
- [Install AICW Video](#install-aicw-video)
- [Run as AI Agent for Claude, Codex, ChatGPT](#run-as-ai-agent-for-claude-codex-chatgpt)
- [Start as Standalone App](#start-as-standalone-app)
- [Typical Workflow](#typical-workflow)
- [Troubleshooting](#troubleshooting)
- [Caveats](#caveats)
- [How AI Is Used](#how-ai-is-used)

## Features

- **Auto-matches separately recorded audio** Detects, aligns, and syncs external audio tracks to the parent video.
- **Auto-generates captions** Transcribes speech locally, previews captions, and renders them into the final video.
- **Protects faces** Detects face regions locally, then blurs them or replaces them with emoji overlays.
- **Protects voices** Replaces original speaking audio with computer-generated voice-over.
- **Suggests short clip moments** Uses AI scene analysis to find strong ranges for social clips.
- **Exports social formats** Renders TikTok, Instagram Reels, YouTube Shorts, LinkedIn, Instagram feed, and YouTube landscape MP4s.
- **Live preview for every option** Review ranges, captions, crop, privacy, voice-over, and format settings before rendering.
- **Works standalone or with AI agents** Use the browser hub directly, or connect Claude, Codex, and ChatGPT-compatible MCP hosts.

## Screenshots And Demo

**Screenshots**

![Claude Code rendering captioned clips with AICW Video](docs/img/aicw-video-from-claude-2.png)
![AICW Video Screenshot 1](docs/img/aicw-video-screenshot-1.png)
![AICW Video Screenshot 2](docs/img/aicw-video-screenshot-2.png)


**Video Demo:**

https://github.com/user-attachments/assets/0044971a-9da1-4b01-97d3-a0329eb3157f

## Requirements

| Requirement | Notes |
| --- | --- |
| macOS / Mac OS X | Primary supported platform today. Windows support is planned. |
| 8 GB RAM or more | More RAM helps with longer source videos and parallel renders. |
| Node.js 20+ | Runtime for the CLI, MCP server, and web hub. |
| `ffmpeg-full` / `ffprobe` | Used for local audio extraction, frame sampling, video probing, and rendering. Caption rendering requires ffmpeg's libass/subtitles filter. |
| `whisper-cpp` | Used for local speech transcription. |
| `tensorflow` | Auto-installed as a library for local face detection. |
| AI: Claude Code, Claude Desktop, Codex CLI, ChatGPT-compatible remote MCP, or Ollama | Optional. Needed when AI scene analysis is enabled. Claude Code is the recommended/tested standalone path today. |

## Install AICW Video

### From Homebrew

```bash
brew install aicw-io/tap/aicw-video
```

## Run as AI Agent for Claude, Codex, ChatGPT

AICW Video ships a local stdio MCP server and a packaged Claude Skill. Claude
Code, Claude Desktop, Codex, and ChatGPT-compatible remote MCP hosts can use it
to import a video, analyze it, create a plan, open the review hub, and render
clips.

```bash
aicw-video setup-mcp
```

| Host | Setup | Notes |
| --- | --- | --- |
| Claude Code | `claude mcp add aicw-video -- aicw-video mcp` | Recommended path. |
| Claude Skill | Open the browser hub, then copy the packaged skill from **How to use -> Claude Skill** into `~/.claude/skills/aicw-video/SKILL.md`. | Works alongside MCP and improves natural-language triggering. |
| Claude Desktop | Add the JSON from `aicw-video setup-mcp` to `claude_desktop_config.json`. | Quit with Cmd+Q, then relaunch. |
| Codex CLI | Add the TOML from `aicw-video setup-mcp` to `~/.codex/config.toml`. | Restart Codex. |
| ChatGPT / ChatGPT Desktop | Requires a remote MCP server URL using SSE or streaming HTTP. | Local `aicw-video mcp` is stdio, so use Codex CLI for OpenAI local-MCP workflows today. |

Prompt example:

```text
use aicw-video to cut /path/to/video.mov into clips
```

Claude Code can run the whole flow and return the output folder:

![Claude Code creating and analyzing an AICW Video project](docs/img/aicw-video-from-claude-1.png)
![Claude Code rendering captioned clips with AICW Video](docs/img/aicw-video-from-claude-2.png)
![Rendered AICW Video clips in Finder](docs/img/aicw-video-from-claude-3.png)

ChatGPT Developer Mode currently documents remote MCP support, not local stdio
commands: <https://platform.openai.com/docs/guides/developer-mode>.

## Start As Standalone App

```bash
aicw-video
```

The browser hub opens at `http://127.0.0.1:8764/`. From there you can create a
project, add videos and audio tracks, analyze sources, open each video plan, and
render clips.

From a source checkout, `npm start` runs `bin/start`, which builds the app and
starts the same browser hub.

## Typical Workflow

1. Add an interview video and, if available, a separately recorded audio file.
2. Analyze the project to transcribe speech, sync external audio, detect faces, and suggest short clips.
3. Open the plan UI to preview clip ranges, captions, crop, privacy overlays, voice-over, and export formats.
4. Render selected clips for TikTok, Instagram Reels, YouTube Shorts, LinkedIn, or other formats.

Files are stored in the AICW Video projects folder:

```text
~/aicw-video/projects/<project>/<video>/shorts/render-<timestamp>/
```

## Troubleshooting

- **`aicw-video doctor` shows a missing `whisper-cli`:** install whisper.cpp
  with `brew install whisper-cpp`.
- **Hub says "error: Load failed" when opening a project:** first plan builds can
  take a short while because AICW Video generates frame and caption-style
  previews. Reopen after the build finishes.
- **Port 8764 is busy:** the hub scans nearby ports. Check terminal output for
  the actual URL.
- If nothing helps, [create new issue](https://github.com/aicw-io/aicw-video/issues/new)

### From Source

```bash
git clone https://github.com/aicw-io/aicw-video
cd aicw-video
./scripts/setup.sh
npm link
```

`scripts/setup.sh` is the recommended source install path. On macOS it installs
missing system dependencies with Homebrew, installs npm dependencies, builds the
app, and runs the preflight:

```bash
aicw-video doctor
```

The whisper model (`ggml-base.en.bin`, about 140 MB) downloads itself on first
use into `~/.cache/aicw-video/`.

If you do not want to link the command globally, run it from the clone:

```bash
node dist/cli.js doctor
node dist/cli.js home
```

For source development, these scripts build and start the browser hub:

```bash
bin/dev
bin/start
```

#### Homebrew installation notes

Homebrew pulls Node.js, ffmpeg-full, and whisper-cpp as dependencies. Release runbook:
[`docs/release/HOMEBREW.md`](docs/release/HOMEBREW.md).

To install the development build from the upstream `main` branch:

```bash
brew install --HEAD aicw-io/tap/aicw-video
```

## Caveats

- macOS is the supported platform today; Windows support is planned.
- Per-clip voice-over is alpha, macOS-only today, and uses the system text-to-speech engine.
- Caption preview in the plan UI is approximate; the final ffmpeg/libass render
  is authoritative.

## How AI Is Used

AICW Video is processing **locally** the following:
- audio and video extraction
- audio to text (via whisper local mode)
- face detection (via local tensorflow, used for privacy features)

Uses **cloud** but can also use **local** LLM: 
When you enable AI scene analysis, AICW Video can use the AI tools you already
have installed:

- **Claude Code / Claude CLI**: used through CLI
- **Codex CLI**: can be used through CLI
- **Ollama**: can be configured as a local AI fallback in
  `config.json`. The current built-in Ollama adapter is text-only, so visual
  frame descriptions still require Claude Code, Codex, or an MCP host that supports sampling.
- **MCP host sampling**: Claude Code, Claude Desktop, and Codex can call the
  local MCP server; ChatGPT requires a remote MCP URL.

AI scene analysis is used for: suggested clip ranges, keyframe labels,
silent-video visual captions, and optional caption proofreading. When it is off,
the app skips visual descriptions and uses local Whisper plus local face detection.

**Privacy note:** local face region detection never needs cloud AI. But note that when you use Claude
Code, Codex, or another cloud-connected AI host for describing a video, sampled frames, transcript
snippets, and caption text may be sent to that provider by the host tool. 

If you need full local AI only, then configure Ollama with local LLM like Qwen or Gemma (see below)

### Advanced: Local Ollama

Ollama is useful if you want a local AI fallback for text-only steps today, and
it is the intended path for future local visual scene descriptions once the
AICW Video Ollama adapter accepts image frames.

```bash
brew install ollama
ollama serve
ollama pull qwen3-vl:8b
```

`qwen3-vl` is a vision-language model in Ollama:
<https://ollama.com/library/qwen3-vl>. For smaller machines, use a smaller tag
such as `qwen3-vl:4b` or `qwen3-vl:2b`. Then edit `config.json` if you want
Ollama to be the local text fallback:

```json
{
  "ai_cli_tools": [
    { "name": "ollama", "command": "ollama", "model": "qwen3-vl:8b", "supports_images": false }
  ]
}
```

Keep `supports_images` as `false` until image-capable Ollama support is added
to AICW Video. Use Claude Code, Codex, or MCP host sampling for visual scene
descriptions in the current release.

## Contributing & License

PRs welcome. See [`CONTRIBUTING.md`](CONTRIBUTING.md).

AICW Video is licensed under AGPL-3.0. See [LICENSE](LICENSE).
