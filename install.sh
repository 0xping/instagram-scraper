#!/bin/bash
# One-line install for macOS, Linux and WSL:
#   curl -fsSL https://raw.githubusercontent.com/0xping/instagram-scraper/main/install.sh | bash
# Installs into ~/.local/share/instagram-scraper and puts `instagram-scraper` (short: `igscrape`) on your PATH.
# A brand-new Mac has no git, no Homebrew and no Node.js. It has curl, and that is all this needs:
# the app arrives as a tarball and Node.js is unpacked inside the app folder. No sudo, nothing system-wide.
set -euo pipefail

REPO="${INSTAGRAM_SCRAPER_REPO:-https://github.com/0xping/instagram-scraper.git}"
BRANCH="${INSTAGRAM_SCRAPER_BRANCH:-main}"
APP="${INSTAGRAM_SCRAPER_HOME:-$HOME/.local/share/instagram-scraper}"
BIN="${INSTAGRAM_SCRAPER_BIN:-$HOME/.local/bin}"
NODE_MAJOR=22   # package.json wants >=22.13, and better-sqlite3 ships ready-built binaries for it
say() { printf '\n\033[1;36m==>\033[0m %s\n' "$1"; }
die() { printf '\n\033[1;31mInstall stopped:\033[0m %s\n' "$1" >&2; exit 1; }

# macOS keeps a /usr/bin/git that only pops up the Xcode tools dialog, so ask git itself, not the PATH.
have_git() { git --version >/dev/null 2>&1; }
node_ok() {
  command -v node >/dev/null 2>&1 &&
    node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)' 2>/dev/null
}
use_bundled_node() { if [ -x "$APP/.node/bin/node" ]; then export PATH="$APP/.node/bin:$PATH"; fi; }

# Node.js for this program only: the official build, unpacked into the app folder.
install_node() {
  local os arch file base
  case "$(uname -s)" in
    Darwin) os=darwin ;;
    Linux) os=linux ;;
    *) die "Install Node.js $NODE_MAJOR.13 or newer from https://nodejs.org/en/download and run this again." ;;
  esac
  case "$(uname -m)" in
    arm64|aarch64) arch=arm64 ;;
    x86_64) arch=x64 ;;
    *) die "No ready-made Node.js build for $(uname -m). Install Node.js from https://nodejs.org/en/download and run this again." ;;
  esac
  base="https://nodejs.org/dist/latest-v$NODE_MAJOR.x"
  file="$(curl -fsSL "$base/" | grep -o "node-v[0-9.]*-$os-$arch\.tar\.gz" | head -1)" || true
  [ -n "$file" ] || die "Could not reach nodejs.org. Check your connection, or install Node.js yourself and run this again."
  say "Installing Node.js for this program only, in $APP/.node"
  mkdir -p "$APP/.node"
  curl -fSL --progress-bar "$base/$file" | tar xz --strip-components=1 -C "$APP/.node"
  export PATH="$APP/.node/bin:$PATH"
  node_ok || die "The downloaded Node.js did not run. Install Node.js from https://nodejs.org/en/download and run this again."
}

download_app() {
  if [ -d "$APP/.git" ] && have_git; then
    say "Updating $APP"
    git -C "$APP" pull --ff-only
  elif [ -f "$APP/package.json" ] && [ "${INSTAGRAM_SCRAPER_FORCE_DOWNLOAD:-0}" != "1" ]; then
    say "Using the copy already in $APP"
  elif have_git; then
    say "Downloading into $APP"
    mkdir -p "$APP"
    git clone --depth 1 --branch "$BRANCH" "$REPO" "$APP"
  else
    say "Downloading into $APP"
    mkdir -p "$APP"
    curl -fsSL "${REPO%.git}/archive/refs/heads/$BRANCH.tar.gz" | tar xz --strip-components=1 -C "$APP" \
      || die "Download failed. Check your connection and run this again."
  fi
}

download_app
use_bundled_node
node_ok || install_node

say "Installing dependencies (this also downloads FFmpeg)"
(cd "$APP" && npm ci --no-audit --no-fund)
if [ "${INSTAGRAM_SCRAPER_SKIP_BROWSER:-0}" != "1" ]; then
  say "Downloading the browser it drives"
  (cd "$APP" && npx --yes playwright install chromium)
fi
say "Building"
(cd "$APP" && npm run build >/dev/null)
[ -f "$APP/.env" ] || { cp "$APP/.env.example" "$APP/.env"; chmod 600 "$APP/.env"; }

# Re-running the installer must not move the data folder someone already chose.
CURRENT_DATA="$( [ -f "$APP/.data-dir" ] && cat "$APP/.data-dir" || true )"
DEFAULT_DATA="${INSTAGRAM_SCRAPER_DATA:-${CURRENT_DATA:-$HOME/instagram-scraper-data}}"
(cd "$APP" && node dist/cli.js settings-set "DATA_DIR=$DEFAULT_DATA" >/dev/null)
printf '%s\n' "$DEFAULT_DATA" > "$APP/.data-dir"
if [ "${INSTAGRAM_SCRAPER_NO_SETUP:-0}" != "1" ]; then
  bash "$APP/setup.sh" || say "Setup skipped; defaults kept. Run 'instagram-scraper setup' any time."
fi

mkdir -p "$BIN"
# A thin wrapper on purpose: every command lives in bin/run.sh inside the app, so `update` refreshes them too.
printf '#!/bin/bash\n# Thin wrapper: the real commands live in the app, so updates reach them.\nexec bash "%s/bin/run.sh" "$@"\n' "$APP" > "$BIN/instagram-scraper"
chmod +x "$BIN/instagram-scraper"
ln -sf "$BIN/instagram-scraper" "$BIN/igscrape"

case ":$PATH:" in
  *":$BIN:"*) PATH_NOTE="" ;;
  *) PATH_NOTE="Add this line to your ~/.zshrc or ~/.bashrc, then open a new terminal:
    export PATH=\"$BIN:\$PATH\"" ;;
esac

cat <<DONE

  Installed. Start it with:

    instagram-scraper        (short: igscrape)

  In the dashboard: connect Instagram, add accounts, then choose Collect posts and media.
  Your data:   $( [ -f "$APP/.data-dir" ] && cat "$APP/.data-dir" || echo "$HOME/instagram-scraper-data" )
  Change settings: instagram-scraper setup
  Local Whisper:   instagram-scraper whisper start|stop|status
  Update:          instagram-scraper update
  Remove it:       instagram-scraper uninstall
  Command line:    instagram-scraper cli help

$PATH_NOTE
DONE
