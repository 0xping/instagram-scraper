#!/bin/bash
set -e
cd "$(dirname "$0")"
trap 'echo "Install failed. See the error above."; read -r -p "Press Enter to close..."' ERR

node_ok() {
  command -v node >/dev/null 2>&1 &&
    node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || major === 22 && minor >= 13 ? 0 : 1)'
}

if ! node_ok; then
  if command -v brew >/dev/null 2>&1; then
    echo "Installing Node.js with Homebrew..."
    brew install node
  else
    echo "Node.js 22.13 or newer is required. Opening the download page."
    open https://nodejs.org/en/download
    echo "Install Node.js, then double-click Install again."
    read -r -p "Press Enter to close..."
    exit 1
  fi
fi
if ! node_ok; then
  echo "Node.js 22.13 or newer is still unavailable. Install it and rerun Install."
  read -r -p "Press Enter to close..."
  exit 1
fi

npm ci
npx playwright install chromium
npm run build
if [ ! -f .env ]; then
  cp .env.example .env
  chmod 600 .env
fi
echo "Done. Double-click Start."
read -r -p "Press Enter to close..."
