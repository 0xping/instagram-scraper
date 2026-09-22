#!/bin/bash
cd "$(dirname "$0")"
npm run app
status=$?
if [ "$status" -ne 0 ]; then
  echo "The dashboard exited with an error."
  read -r -p "Press Enter to close..."
fi
exit "$status"
