#!/bin/bash
set -euo pipefail
DEST="$HOME/TantularWorkshop"
echo "Mengunduh paket workshop Tantular ke $DEST ..."
mkdir -p "$DEST"
curl -fsSL "https://workshop-web-gamma.vercel.app/downloads/tantular-workshop.zip" -o "$DEST/tantular-workshop.zip"
cd "$DEST"
unzip -oq tantular-workshop.zip
# Reattach the terminal: under "curl | bash" stdin is the pipe, and the
# installer has interactive prompts (sudo, pertanyaan tenant, Enter penutup).
bash install-tantular-workshop.command < /dev/tty
