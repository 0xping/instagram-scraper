#!/bin/bash
# Optional local transcription with whisper.cpp: free, private, nothing leaves this computer.
#   instagram-scraper whisper install | start | stop | status
set -euo pipefail
APP="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODELS="$APP/models"
STATE="${XDG_STATE_HOME:-$HOME/.local/state}/instagram-scraper"
PIDFILE="$STATE/whisper.pid"
PORT="${WHISPER_PORT:-8080}"
say() { printf '\n\033[1;36m==>\033[0m %s\n' "$1" >&2; }
die() { printf '\n\033[1;31mWhisper setup stopped:\033[0m %s\n' "$1" >&2; exit 1; }
server_bin() { command -v whisper-server 2>/dev/null || { [ -x "$APP/whisper.cpp/build/bin/whisper-server" ] && echo "$APP/whisper.cpp/build/bin/whisper-server"; }; }
model_file() { ls "$MODELS"/ggml-*.bin 2>/dev/null | head -1; }

ask_yes() { local reply; printf '\n%s [yes]: ' "$1" >&2; IFS= read -r reply <&0 || reply=''; case "${reply:-yes}" in y|Y|yes|YES|Yes) return 0 ;; *) return 1 ;; esac; }

# A new Mac has no compiler and no Homebrew, which is why this step used to be skipped without saying why.
prepare_mac() {
  if ! xcode-select -p >/dev/null 2>&1; then
    say "macOS needs its command line tools first (one time, a few minutes)"
    xcode-select --install >/dev/null 2>&1 || true
    printf '\nFinish the install window macOS just opened, then press Enter here: ' >&2
    IFS= read -r _ <&0 || true
    xcode-select -p >/dev/null 2>&1 || die "The command line tools are still missing. Run 'xcode-select --install', then try again."
  fi
  command -v brew >/dev/null 2>&1 && return 0
  say "Whisper on this computer is built with Homebrew, which you do not have yet"
  ask_yes "Install Homebrew now? It asks for your Mac password" \
    || die "Nothing installed. Choose Groq in 'instagram-scraper setup' instead: free, and nothing to build."
  NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  for brew_bin in /opt/homebrew/bin/brew /usr/local/bin/brew; do
    [ -x "$brew_bin" ] && eval "$("$brew_bin" shellenv)" && break
  done
  command -v brew >/dev/null 2>&1 || die "Homebrew did not end up on your PATH. Open a new terminal and run: instagram-scraper whisper install"
}

install_server() {
  if [ -n "$(server_bin)" ]; then say "whisper.cpp is already installed"; return; fi
  [ "$(uname -s)" = Darwin ] && prepare_mac
  if command -v brew >/dev/null 2>&1; then
    say "Installing whisper.cpp with Homebrew"
    brew install whisper-cpp
  elif command -v cmake >/dev/null 2>&1 && command -v git >/dev/null 2>&1; then
    say "Building whisper.cpp (a few minutes)"
    [ -d "$APP/whisper.cpp" ] || git clone --depth 1 https://github.com/ggml-org/whisper.cpp "$APP/whisper.cpp"
    cmake -S "$APP/whisper.cpp" -B "$APP/whisper.cpp/build" -DCMAKE_BUILD_TYPE=Release -DWHISPER_BUILD_SERVER=ON >/dev/null
    cmake --build "$APP/whisper.cpp/build" --config Release -j"$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)" >/dev/null
  else
    die "Needs cmake and git. Install them, or choose Groq in 'instagram-scraper setup' instead."
  fi
  [ -n "$(server_bin)" ] || die "whisper-server was not found after installing."
}

install_model() {
  if [ -n "$(model_file)" ]; then say "Model already downloaded: $(basename "$(model_file)")"; return; fi
  local choice name size
  printf '\n  1) large-v3-turbo   best quality, about 1.6 GB   (recommended on Apple Silicon)\n  2) small           lighter, about 490 MB       (better on older laptops)\n' >&2
  printf '\nChoose 1-2 [1]: ' >&2
  IFS= read -r choice <&0 || choice=''
  case "${choice:-1}" in 2) name="small"; size="490 MB" ;; *) name="large-v3-turbo"; size="1.6 GB" ;; esac
  say "Downloading the $name model ($size)"
  mkdir -p "$MODELS"
  curl -fL --progress-bar -o "$MODELS/ggml-$name.bin" \
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-$name.bin" || die "Model download failed."
}

start_server() {
  local bin model
  bin="$(server_bin)" || true
  [ -n "$bin" ] || die "whisper.cpp is not installed. Run: instagram-scraper whisper install"
  model="$(model_file)" || true
  [ -n "$model" ] || die "No model downloaded. Run: instagram-scraper whisper install"
  if status_server >/dev/null 2>&1; then say "Already running on port $PORT"; return; fi
  mkdir -p "$STATE"
  # -l auto keeps Arabic, French and other languages in their own language instead of assuming English.
  nohup "$bin" -m "$model" -l auto --convert --inference-path /v1/audio/transcriptions \
    --host 127.0.0.1 --port "$PORT" >"$STATE/whisper.log" 2>&1 &
  echo $! > "$PIDFILE"
  sleep 2
  status_server >/dev/null 2>&1 || die "The server did not start. See $STATE/whisper.log"
  say "Running on http://127.0.0.1:$PORT (log: $STATE/whisper.log)"
}

stop_server() {
  [ -f "$PIDFILE" ] || { echo "Not running."; return; }
  kill "$(cat "$PIDFILE")" 2>/dev/null || true
  rm -f "$PIDFILE"
  echo "Stopped."
}

status_server() {
  [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null || { echo "Not running." >&2; return 1; }
  echo "Running on http://127.0.0.1:$PORT (pid $(cat "$PIDFILE"))"
}

case "${1:-install}" in
  install)
    install_server
    install_model
    (cd "$APP" && node dist/cli.js settings-set "TRANSCRIPTION_PROVIDER=custom" \
      "TRANSCRIPTION_BASE_URL=http://127.0.0.1:$PORT/v1" \
      "TRANSCRIPTION_MODEL=$(basename "$(model_file)" .bin | sed 's/^ggml-//')" >/dev/null)
    start_server
    say "Transcription now uses Whisper on this computer. Start it after a reboot with: instagram-scraper whisper start"
    ;;
  start) start_server ;;
  stop) stop_server ;;
  status) status_server ;;
  *) die "Use: install, start, stop or status" ;;
esac
