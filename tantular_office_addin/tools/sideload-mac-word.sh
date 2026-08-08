#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MANIFEST="$ROOT/manifest.xml"
WEF_DIR="$HOME/Library/Containers/com.microsoft.Word/Data/Documents/wef"
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
echo "1. Save your open documents, then fully quit Microsoft Word with Cmd+Q."
echo "   Closing the window with the red button is NOT enough; Word scans this folder only at app startup."
echo "2. Reopen Word and open (or create) a document."
echo "3. Home tab → Tantular → Open Tantular (or Insert → My Add-ins → Developer Add-ins)."
echo "4. Keep 'npm run dev' running and trust https://localhost:3000 if prompted."
echo "5. In the pane, open '📄 Document Studio' (Word only)."
