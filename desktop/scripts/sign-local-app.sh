#!/usr/bin/env bash
# Seal a completed local --no-sign bundle without replacing Node's vendor signature.
# Run after packaging and after the final resource copy, with Annie closed.
set -euo pipefail

if [ "$(uname -s)" != Darwin ] || [ "$#" -ne 1 ]; then
  echo "Usage (macOS): bash desktop/scripts/sign-local-app.sh /path/to/Annie.app" >&2
  exit 1
fi

app="$1"
# A stable Apple Development / Developer ID identity keeps TCC grants across builds.
# The ad-hoc fallback is for local testing; its cdhash changes when the code changes.
identity="${ANNIE_CODESIGN_IDENTITY:--}"
identifier=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app/Contents/Info.plist")
if [ "$identifier" != app.annie.desktop ]; then
  echo "Expected an Annie app bundle (app.annie.desktop)." >&2
  exit 1
fi
test -x "$app/Contents/MacOS/annie-desktop"
test -x "$app/Contents/MacOS/annie-computer-use"
test -x "$app/Contents/MacOS/node"

# Sign nested code first. Do not use --deep for signing: Node keeps its original signature.
codesign --verify --strict --all-architectures "$app/Contents/MacOS/node"
codesign --force --sign "$identity" --identifier app.annie.desktop.computer-use \
  "$app/Contents/MacOS/annie-computer-use"
codesign --force --sign "$identity" --identifier app.annie.desktop "$app"
codesign --verify --deep --strict --all-architectures --verbose=2 "$app"
