#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

have() {
  command -v "$1" >/dev/null 2>&1
}

homebrew_ffmpeg_full_bin() {
  for p in \
    /opt/homebrew/opt/ffmpeg-full/bin/ffmpeg \
    /usr/local/opt/ffmpeg-full/bin/ffmpeg
  do
    if [[ -x "$p" ]]; then
      printf "%s\n" "$p"
      return 0
    fi
  done
  return 1
}

homebrew_ffprobe_full_bin() {
  for p in \
    /opt/homebrew/opt/ffmpeg-full/bin/ffprobe \
    /usr/local/opt/ffmpeg-full/bin/ffprobe
  do
    if [[ -x "$p" ]]; then
      printf "%s\n" "$p"
      return 0
    fi
  done
  return 1
}

render_ffmpeg_bin() {
  if [[ -n "${FFMPEG_PATH:-}" && -x "${FFMPEG_PATH}" ]]; then
    printf "%s\n" "$FFMPEG_PATH"
    return 0
  fi
  homebrew_ffmpeg_full_bin && return 0
  command -v ffmpeg
}

ffmpeg_supports_subtitles() {
  local ffmpeg
  ffmpeg="$(render_ffmpeg_bin 2>/dev/null || true)"
  [[ -n "$ffmpeg" ]] || return 1
  "$ffmpeg" -hide_banner -h filter=subtitles 2>&1 | grep -Eiq "Filter subtitles|subtitles AVOptions"
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
  warn "this setup script is macOS-first; install ffmpeg with libass/subtitles support, whisper-cpp, Node.js 20+, and npm manually on this platform"
else
  if ! have brew; then
    printf "Homebrew is required to install system dependencies.\n"
    printf "Install it from https://brew.sh, then run this script again.\n"
    exit 1
  fi

  BREW_PACKAGES=""
  if ! have ffmpeg && ! homebrew_ffmpeg_full_bin >/dev/null 2>&1; then
    need_brew_pkg ffmpeg-full
  fi
  if ! have ffprobe && ! homebrew_ffprobe_full_bin >/dev/null 2>&1; then
    need_brew_pkg ffmpeg-full
  fi
  ffmpeg_supports_subtitles || need_brew_pkg ffmpeg-full
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
