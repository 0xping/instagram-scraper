#!/bin/bash
# Asks for your defaults and writes them to .env. Run again any time: `instagram-scraper setup`.
# Every question has a default in [brackets]: press Enter to accept it.
set -euo pipefail
APP="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$APP"

# curl | bash leaves stdin on the pipe, so questions are read from the terminal itself.
if [ -r /dev/tty ]; then exec 3</dev/tty; else
  echo "No terminal available for questions; keeping the current settings. Run 'instagram-scraper setup' later."; exit 0
fi
ask() { local prompt="$1" default="$2" reply; printf '\n%s [%s]: ' "$prompt" "$default" >&2; IFS= read -r reply <&3 || reply=''; printf '%s' "${reply:-$default}"; }
ask_secret() { local prompt="$1" reply; printf '\n%s: ' "$prompt" >&2; IFS= read -rs reply <&3 || reply=''; printf '\n' >&2; printf '%s' "$reply"; }
set_setting() { node dist/cli.js settings-set "$@" >/dev/null; }
title() { printf '\n\033[1;36m%s\033[0m\n' "$1" >&2; }

title "Setup — press Enter to accept each default"

# 1. Where collected data is kept.
CURRENT_DATA="$( [ -f "$APP/.data-dir" ] && cat "$APP/.data-dir" || true )"
DATA_DEFAULT="${INSTAGRAM_SCRAPER_DATA:-${CURRENT_DATA:-$HOME/instagram-scraper-data}}"
DATA_DIR="$(ask "Where should collected posts and media be stored?" "$DATA_DEFAULT")"
mkdir -p "$DATA_DIR"
DATA_DIR="$(cd "$DATA_DIR" && pwd)"   # store it absolute: the command runs from the app folder
set_setting "DATA_DIR=$DATA_DIR"
printf '%s\n' "$DATA_DIR" > "$APP/.data-dir"

# 2. Transcription service.
title "Video speech transcription"
cat >&2 <<'MENU'
  1) Groq        free account, nothing to install  (recommended)
  2) Whisper on this computer   free and private, downloads about 1 GB
  3) OpenAI      paid per minute
  4) Off         no transcripts
MENU
case "$(ask "Choose 1-4" "1")" in
  1) KEY="$(ask_secret 'Paste your Groq API key (console.groq.com/keys)')"
     if [ -n "$KEY" ]; then set_setting "GROQ_API_KEY=$KEY" "TRANSCRIPTION_PROVIDER=groq"
     else echo "No key given; transcription left off." >&2; set_setting "TRANSCRIPTION_PROVIDER="; fi ;;
  2) bash "$APP/whisper.sh" install <&3 || { echo "Whisper setup did not finish (the reason is above); transcription is off. Run 'instagram-scraper setup' again to pick Groq, or 'instagram-scraper whisper install' to retry." >&2; set_setting "TRANSCRIPTION_PROVIDER="; } ;;
  3) KEY="$(ask_secret 'Paste your OpenAI API key')"
     if [ -n "$KEY" ]; then set_setting "OPENAI_API_KEY=$KEY" "TRANSCRIPTION_PROVIDER=openai"
     else echo "No key given; transcription left off." >&2; set_setting "TRANSCRIPTION_PROVIDER="; fi ;;
  *) set_setting "TRANSCRIPTION_PROVIDER=" ;;
esac

# 3. Collection defaults.
title "Collection defaults"
COMMENTS="$(ask "Comments to save per post (number, or 'all')" "100")"
FPS="$(ask "Images to save per second of video" "1")"
BROWSER="$(ask "Show the browser window while collecting? (yes/no)" "no")"
INTERVAL="$(node -e "const n=Number(process.argv[1]);process.stdout.write(Number.isFinite(n)&&n>0?String(1/n):'1')" "$FPS")"
case "$BROWSER" in y|Y|yes|YES|Yes) HEADED=true ;; *) HEADED=false ;; esac
set_setting "COMMENT_LIMIT=$COMMENTS" "FRAME_INTERVAL=$INTERVAL" "BROWSER_HEADED=$HEADED"

printf '\n\033[1;32mSaved.\033[0m Data folder: %s\n' "$DATA_DIR" >&2
printf 'Change anything later in the dashboard (Settings) or by running: instagram-scraper setup\n' >&2
