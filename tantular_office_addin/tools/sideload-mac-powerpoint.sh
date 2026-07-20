#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MANIFEST="$ROOT/manifest.xml"
WEF_DIR="$HOME/Library/Containers/com.microsoft.Powerpoint/Data/Documents/wef"
TARGET="$WEF_DIR/manifest.xml"

if [[ ! -f "$MANIFEST" ]]; then
  echo "manifest.xml not found at $MANIFEST" >&2
  exit 1
fi

mkdir -p "$WEF_DIR"
cp "$MANIFEST" "$TARGET"

echo "Copied Tantular manifest to:"
echo "  $TARGET"
echo
echo "Next steps:"
echo "1. Fully quit PowerPoint desktop."
echo "2. Reopen PowerPoint."
echo "3. Insert → My Add-ins / Office Add-ins → Shared Folder / Developer Add-ins → Tantular."
echo "4. Keep npm run dev running and trust https://127.0.0.1:3000 if prompted."
