#!/bin/bash
# Double-click to open the dashboard. run.sh knows where Node.js is, even the bundled one.
cd "$(dirname "$0")"
bash bin/run.sh
status=$?
if [ "$status" -ne 0 ]; then
  echo "The dashboard exited with an error."
  read -r -p "Press Enter to close..."
fi
exit "$status"
