#!/bin/bash
# Double-click this after downloading the folder. Everything it needs is in install.sh,
# which installs into this folder and asks for nothing the Mac does not already have.
set -e
cd "$(dirname "$0")"
trap 'echo "Install failed. See the error above."; read -r -p "Press Enter to close..."' ERR

INSTAGRAM_SCRAPER_HOME="$PWD" bash ./install.sh

read -r -p "Press Enter to close..."
