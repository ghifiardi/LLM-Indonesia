#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"

echo "Instalasi Workshop Tantular Office"
echo "=================================="

find_ollama() {
  command -v ollama >/dev/null 2>&1 && return 0
  for candidate in /usr/local/bin/ollama /opt/homebrew/bin/ollama "/Applications/Ollama.app/Contents/Resources/ollama"; do
    [ -x "$candidate" ] && return 0
  done
  return 1
}

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js belum terpasang."
  if command -v brew >/dev/null 2>&1; then
    echo "Memasang Node.js lewat Homebrew..."
    brew install node
  else
    echo "Mengunduh installer resmi Node.js (butuh password admin Mac ini)..."
    curl -fsSL "https://nodejs.org/dist/v22.17.0/node-v22.17.0.pkg" -o /tmp/node-lts.pkg
    sudo installer -pkg /tmp/node-lts.pkg -target /
    export PATH="/usr/local/bin:$PATH"
  fi
fi
command -v node >/dev/null 2>&1 || { echo "Node.js masih belum terdeteksi. Pasang manual dari https://nodejs.org lalu jalankan installer ini lagi."; exit 1; }

if ! find_ollama; then
  echo "Ollama belum terpasang. Mengunduh aplikasi Ollama..."
  curl -fsSL "https://ollama.com/download/Ollama-darwin.zip" -o /tmp/Ollama.zip
  ditto -xk /tmp/Ollama.zip /Applications
  open -a Ollama || true
  echo "Aplikasi Ollama dibuka. Jika muncul dialog, izinkan pemasangan command line tool."
  sleep 5
fi
find_ollama || { echo "Ollama masih belum terdeteksi. Pasang manual dari https://ollama.com/download lalu jalankan installer ini lagi."; exit 1; }

echo "Memasang sertifikat localhost tepercaya untuk Office..."
npm run cert:office

echo "Menyiapkan model Tantular Office (unduhan bisa beberapa GB)..."
npm run model:office

MANIFEST="$PWD/tantular-workshop-manifest.xml"
read -r -p "Apakah admin Microsoft 365 Anda sudah memasang Tantular ke akun Anda? [y/N] " TENANT_DEPLOYED
if [[ "$TENANT_DEPLOYED" =~ ^[Yy]$ ]]; then
  echo "Melewati penyalinan manifest lokal; tombol Tantular akan muncul lewat deployment tenant."
else
  for app in Word Excel Powerpoint; do
    DIR="$HOME/Library/Containers/com.microsoft.$app/Data/Documents/wef"
    mkdir -p "$DIR"
    cp "$MANIFEST" "$DIR/tantular-workshop-manifest.xml"
  done
  echo "Manifest workshop lokal terpasang untuk Word, Excel, dan PowerPoint."
fi

echo
echo "Instalasi selesai."
echo "1. Tutup penuh Word, Excel, dan PowerPoint dengan Cmd+Q."
echo "2. Jalankan start-tantular-companion.command dan biarkan terminalnya tetap terbuka."
echo "3. Buka kembali Office → Home → Tantular → Open Tantular."
read -r -p "Tekan Enter untuk menutup..."
