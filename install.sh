#!/bin/bash
# One-line install for macOS, Linux and WSL:
#   curl -fsSL https://raw.githubusercontent.com/0xping/instagram-scraper/main/install.sh | bash
# Installs into ~/.local/share/instagram-scraper and puts `instagram-scraper` (short: `igscrape`) on your PATH.
set -euo pipefail

REPO="${INSTAGRAM_SCRAPER_REPO:-https://github.com/0xping/instagram-scraper.git}"
APP="${INSTAGRAM_SCRAPER_HOME:-$HOME/.local/share/instagram-scraper}"
BIN="${INSTAGRAM_SCRAPER_BIN:-$HOME/.local/bin}"
say() { printf '\n\033[1;36m==>\033[0m %s\n' "$1"; }
die() { printf '\n\033[1;31mInstall stopped:\033[0m %s\n' "$1" >&2; exit 1; }

command -v git >/dev/null 2>&1 || die "git is required. Install it, then run this again."

node_ok() {
  command -v node >/dev/null 2>&1 &&
    node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)' 2>/dev/null
}
if ! node_ok; then
  say "Installing Node.js 22+"
  if command -v brew >/dev/null 2>&1; then brew install node
  elif command -v apt-get >/dev/null 2>&1; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs
  else
    die "Node.js 22.13 or newer is required. Install it from https://nodejs.org/en/download and run this again."
  fi
fi
node_ok || die "Node.js 22.13 or newer is still not on your PATH. Open a new terminal and run this again."

if [ -d "$APP/.git" ]; then
  say "Updating $APP"
  git -C "$APP" pull --ff-only
else
  say "Downloading into $APP"
  mkdir -p "$(dirname "$APP")"
  git clone --depth 1 "$REPO" "$APP"
fi

say "Installing dependencies (this also downloads FFmpeg)"
(cd "$APP" && npm ci --no-audit --no-fund)
if [ "${INSTAGRAM_SCRAPER_SKIP_BROWSER:-0}" != "1" ]; then
  say "Downloading the browser it drives"
  (cd "$APP" && npx --yes playwright install chromium)
fi
say "Building"
(cd "$APP" && npm run build >/dev/null)
[ -f "$APP/.env" ] || { cp "$APP/.env.example" "$APP/.env"; chmod 600 "$APP/.env"; }

mkdir -p "$BIN"
cat > "$BIN/instagram-scraper" <<LAUNCHER
#!/bin/bash
# Opens the dashboard. Collected data lives in \${INSTAGRAM_SCRAPER_DATA:-\$HOME/instagram-scraper-data}.
set -e
APP="$APP"
export DATA_DIR="\${INSTAGRAM_SCRAPER_DATA:-\$HOME/instagram-scraper-data}"
if [ "\${1:-}" = "update" ]; then
  git -C "\$APP" pull --ff-only && (cd "\$APP" && npm ci --no-audit --no-fund && npm run build >/dev/null)
  echo "Updated."; exit 0
fi
if [ "\${1:-}" = "cli" ]; then shift; cd "\$APP"; exec node dist/cli.js "\$@"; fi
cd "\$APP"
exec node dist/app/main.js "\$@"
LAUNCHER
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
  Your data:   ${INSTAGRAM_SCRAPER_DATA:-$HOME/instagram-scraper-data}
  Update:      instagram-scraper update
  Old CLI:     instagram-scraper cli help

$PATH_NOTE
DONE
