---
name: aicw-video
description: Use AICW Video to turn local video/audio files into short clips, captions, rendered social videos, or step-by-step tutorials through the aicw-video MCP tools and local review hub. Trigger on requests involving local videos, screen recordings, screencasts, demos, shorts, clip planning, caption editing, tutorial export, or review links.
---

# AICW Video

AICW Video is a local CLI, MCP server, and browser review hub. Prefer the
aicw-video MCP tools and review UI over hand-written ffmpeg commands.

## Default Workflow

1. Call `create_project` with the local files. Use `autoMatchAudio: true` unless the user asks otherwise.
2. Call `analyze_project`.
3. Call `review_project` and give the user the returned local URL.
4. Let the user review ranges, captions, tutorial steps, privacy options, and render settings in the hub.
5. If the user asks for edits, call `get_clip_plan`, patch only the requested fields, then call `save_clip_plan`.
6. Render only when the user asks: use `render_clip` or `render_all_clips`.

## Tutorials

For screencasts and demos, keep tutorials simple: key moments, screenshots, and editable text. The user can remove extra screenshots or text later.

- If the user asks for a tutorial from a selected clip, call `export_clip_tutorial`.
- If no clip is selected, send the user to the review hub and point them to `Export tutorial`.

## Rules

- Preserve original source files.
- Do not re-run analysis if the project already has useful outputs unless the user asks.
- Do not manually edit generated mp4 files unless the user explicitly requests custom post-processing.
- If AI scene analysis is enabled, sampled frames/transcripts may be sent to the configured AI host. Local Whisper and local face detection do not require cloud AI.
- Return local paths and review URLs clearly.
