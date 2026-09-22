#!/bin/bash
# What the `instagram-scraper` command runs. The command on your PATH is a thin wrapper around this file,
# so `instagram-scraper update` also updates the commands below.
set -euo pipefail
APP="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN="${INSTAGRAM_SCRAPER_BIN:-$HOME/.local/bin}"
# The Node.js the installer unpacked here, for computers that had none of their own.
if [ -x "$APP/.node/bin/node" ]; then export PATH="$APP/.node/bin:$PATH"; fi
# The data folder comes from .env (chosen during setup); this overrides it for one run.
[ -n "${INSTAGRAM_SCRAPER_DATA:-}" ] && export DATA_DIR="$INSTAGRAM_SCRAPER_DATA"

write_launcher() {
  mkdir -p "$BIN"
  printf '#!/bin/bash\n# Thin wrapper: the real commands live in the app, so updates reach them.\nexec bash "%s/bin/run.sh" "$@"\n' "$APP" > "$BIN/instagram-scraper"
  chmod +x "$BIN/instagram-scraper"
  ln -sf "$BIN/instagram-scraper" "$BIN/igscrape"
}

case "${1:-}" in
  update)
    # Installed without git (a new Mac has none), so the installer fetches the new code the same way it first did.
    if [ -d "$APP/.git" ] && git --version >/dev/null 2>&1; then
      git -C "$APP" pull --ff-only
      (cd "$APP" && npm ci --no-audit --no-fund && npm run build >/dev/null)
      write_launcher
    else
      # Run a copy: the download replaces install.sh underneath a script bash is still reading.
      installer="$(mktemp)"; cp "$APP/install.sh" "$installer"
      INSTAGRAM_SCRAPER_HOME="$APP" INSTAGRAM_SCRAPER_FORCE_DOWNLOAD=1 \
        INSTAGRAM_SCRAPER_NO_SETUP=1 INSTAGRAM_SCRAPER_SKIP_BROWSER=1 bash "$installer"
      rm -f "$installer"
    fi
    echo "Updated." ;;
  setup) exec bash "$APP/setup.sh" ;;
  whisper) shift; exec bash "$APP/whisper.sh" "$@" ;;
  uninstall) exec bash "$APP/uninstall.sh" ;;
  cli) shift; cd "$APP"; exec node dist/cli.js "$@" ;;
  help|--help|-h)
    cat <<USAGE
instagram-scraper              open the dashboard
instagram-scraper setup        choose your defaults again
instagram-scraper whisper ...  install | start | stop | status  (local transcription)
instagram-scraper update       get the latest version
instagram-scraper uninstall    remove the program (your data is kept unless you confirm)
instagram-scraper cli ...      the command-line interface
USAGE
    ;;
  *) cd "$APP"; exec node dist/app/main.js "$@" ;;
esac
