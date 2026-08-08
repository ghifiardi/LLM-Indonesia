#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MANIFEST="$ROOT/manifest.xml"
WEF_DIR="$HOME/Library/Containers/com.microsoft.Excel/Data/Documents/wef"
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
echo "1. Save workbooks, then fully quit Microsoft Excel with Cmd+Q."
echo "   Closing the workbook/window is NOT enough; Excel scans this folder only at app startup."
echo "2. Reopen Excel and open (or create) a workbook."
echo "3. Home tab → Tantular → Open Tantular."
echo "4. Keep 'npm run dev' running and trust https://localhost:3000 if prompted."
echo "5. In the pane, open '📊 Sheet Studio' (Excel only)."
