# Contributing

Thanks for your interest in `aicw-video`. This is a small, focused project —
PRs that keep it that way are most welcome.

## Dev setup

```bash
git clone https://github.com/aicw-io/aicw-video
cd aicw-video
npm install
npm run build
```

Run from your clone:

```bash
node dist/cli.js doctor
node dist/cli.js home
```

Or symlink onto your `PATH` for everyday testing:

```bash
npm link
```

## Project conventions

- **macOS-first.** Don't add cross-platform shims unless the feature
  fundamentally needs them.
- **MVP-focused.** No premature multi-provider plumbing. Ship one path that
  works, then add alternatives only when a second real use case shows up.
- **No telemetry.** No network calls except the third-party tools we already
  spawn (ffmpeg, whisper model download).
  Bind any HTTP server to `127.0.0.1`.
- **Boring code over clever code.** The pipeline writes structured JSON at
  every stage; later steps read those files. Keep that contract simple.
- **No new top-level abstractions** without two real call sites.

## PR checklist

- `npm run build` is clean (TypeScript strict mode).
- The `doctor` command still runs cleanly on macOS.
- If you touched the plan UI, manually load it once with a real project and
  click the things you changed.
- If you touched the renderer, render at least one clip end-to-end and
  confirm captions still align.
- New env vars are documented in `README.md`.
- New user-visible behaviour is documented in `NOTICE.md` if it has any
  privacy or rights implications (e.g. uploading anything or talking to a
  new third-party endpoint).

## Reporting bugs

Open a GitHub issue with:

- macOS version + chip (Intel / Apple Silicon).
- `aicw-video doctor` output.
- The exact prompt or CLI command that triggered the issue.
- For renderer issues: attach the project's `shorts/plan.json`.

## Reporting security issues

Please use GitHub's "Report a vulnerability" link on the repository's
**Security** tab rather than opening a public issue.
