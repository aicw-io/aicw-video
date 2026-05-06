#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

have() {
  command -v "$1" >/dev/null 2>&1
}

line() {
  printf "\n==> %s\n" "$1"
}

ok() {
  printf "ok: %s\n" "$1"
}

warn() {
  printf "warn: %s\n" "$1"
}

need_brew_pkg() {
  case " ${BREW_PACKAGES} " in
    *" $1 "*) ;;
    *) BREW_PACKAGES="${BREW_PACKAGES} $1" ;;
  esac
}

line "AICW Video setup"

if [[ "$(uname -s)" != "Darwin" ]]; then
  warn "this setup script is macOS-first; install ffmpeg, whisper-cpp, Node.js 20+, and npm manually on this platform"
else
  if ! have brew; then
    printf "Homebrew is required to install system dependencies.\n"
    printf "Install it from https://brew.sh, then run this script again.\n"
    exit 1
  fi

  BREW_PACKAGES=""
  have ffmpeg || need_brew_pkg ffmpeg
  have ffprobe || need_brew_pkg ffmpeg
  have whisper-cli || need_brew_pkg whisper-cpp
  have node || need_brew_pkg node
  have npm || need_brew_pkg node

  if have node; then
    NODE_MAJOR="$(node -p "Number(process.versions.node.split('.')[0])" 2>/dev/null || printf "0")"
    if [[ "${NODE_MAJOR}" -lt 20 ]]; then
      warn "Node.js 20+ is required; installing Homebrew node"
      need_brew_pkg node
    fi
  fi

  if [[ -n "${BREW_PACKAGES// /}" ]]; then
    line "Installing system packages"
    # shellcheck disable=SC2086
    brew install ${BREW_PACKAGES}
  else
    ok "system packages already installed"
  fi
fi

line "Installing app dependencies"
cd "$ROOT"
SHARP_IGNORE_GLOBAL_LIBVIPS=1 npm install
npm run build

line "Running preflight"
node dist/cli.js doctor

line "Done"
printf "Run: npm start\n"
printf "Or after npm link: aicw-video\n"
