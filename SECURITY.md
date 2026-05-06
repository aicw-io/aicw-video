# Security policy

## Reporting a vulnerability

Use GitHub's **"Report a vulnerability"** link on the **Security** tab of
this repository. Please do **not** file a public issue for security reports.

We aim to acknowledge reports within 5 working days.

## Scope

In scope:

- Code in this repository (`src/`, `dist/`).
- The local HTTP servers (`home-server`, `plan-server`) — both bind to
  `127.0.0.1`. Reports of cross-origin escalation, path traversal, or
  command injection through their endpoints are appreciated.
- Subprocess spawning (`runProc`) — argument-injection or unintended path
  traversal via user input.

Out of scope (not bugs in this project):

- Bugs or vulnerabilities in upstream dependencies (`ffmpeg`,
  `whisper.cpp`, `@modelcontextprotocol/sdk`). Please report
  those upstream.
- Misuse of the tool against content the user does not own. See
  [`NOTICE.md`](NOTICE.md) for the project's stance on responsible use.
- Issues caused by running the tool on untrusted videos with non-default
  configurations (e.g. a manually edited `plan.json` containing malicious
  ffmpeg filter expressions). The project assumes plans are produced by
  the user or their AI host, not by attackers.

## Threat model

`aicw-video` is a single-user, local tool. It does not host content, does
not accept incoming network connections from anywhere except `127.0.0.1`,
and does not send telemetry. The threat model assumes:

1. The user trusts the videos they import.
2. The user trusts the AI host they connect (Claude, OpenClaw, etc.).
3. The user is the only person with shell access to their machine.

If your environment violates any of those assumptions, the tool may not
fit your security needs.
