#!/bin/bash
# Removes the program. Your collected data is kept unless you say otherwise.
#   instagram-scraper uninstall
set -euo pipefail
APP="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="${INSTAGRAM_SCRAPER_BIN:-$HOME/.local/bin}"
STATE="${XDG_STATE_HOME:-$HOME/.local/state}/instagram-scraper"
DATA="$( [ -f "$APP/.data-dir" ] && cat "$APP/.data-dir" || echo "$HOME/instagram-scraper-data" )"

if [ -r /dev/tty ]; then exec 3</dev/tty; else exec 3<&0; fi
ask() { local prompt="$1" default="$2" reply; printf '\n%s [%s]: ' "$prompt" "$default" >&2; IFS= read -r reply <&3 || reply=''; printf '%s' "${reply:-$default}"; }

cat >&2 <<INFO

This will remove:
  program        $APP
  command        $BIN/instagram-scraper (and igscrape)
  whisper server $STATE

Your collected posts, media and database are in:
  $DATA
INFO

case "$(ask 'Remove the program? (yes/no)' 'no')" in
  y|Y|yes|YES|Yes) ;;
  *) echo "Nothing was removed." >&2; exit 0 ;;
esac

# Stop a local Whisper server this program started.
[ -f "$STATE/whisper.pid" ] && kill "$(cat "$STATE/whisper.pid")" 2>/dev/null || true

KEEP_DATA=1
case "$(ask "Also delete your collected data in $DATA? (yes/no)" 'no')" in
  y|Y|yes|YES|Yes)
    # Deleting is final, so the folder is named once more before it goes.
    case "$(ask "Type the word DELETE to erase $DATA" 'no')" in
      DELETE) KEEP_DATA=0 ;;
      *) echo "Data kept." >&2 ;;
    esac ;;
esac

rm -f "$BIN/instagram-scraper" "$BIN/igscrape"
rm -rf "$STATE"
[ "$KEEP_DATA" = "0" ] && rm -rf "$DATA"

# A checkout you work in (with its git history) is never deleted: only the command that points at it.
STANDARD="${INSTAGRAM_SCRAPER_HOME:-$HOME/.local/share/instagram-scraper}"
if [ -d "$APP/.git" ] && [ "$APP" != "$STANDARD" ]; then
  printf '\nThe command is gone. %s looks like a folder you work in, with its own git history, so it was left alone.\nDelete it yourself if you want it gone.\n' "$APP" >&2
  exit 0
fi
rm -rf "$APP"

printf '\nRemoved. %s\n' "$( [ "$KEEP_DATA" = "1" ] && echo "Your data is still in $DATA" || echo "Data deleted." )" >&2
printf 'Homebrew users: whisper.cpp stays installed; remove it with: brew uninstall whisper-cpp\n' >&2
