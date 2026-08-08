#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# The model is published on ollama.com, so the default path is a straight
# `ollama pull` — no local Modelfile build, fewer failure modes on
# participant machines. The local build remains as an offline fallback.
REGISTRY_MODEL="${TANTULAR_OFFICE_REGISTRY_MODEL:-ghifidanukusumo/tantular}"
BASE_MODEL="${TANTULAR_OFFICE_BASE_MODEL:-qwen3:8b}"
MODEL_NAME="${TANTULAR_OFFICE_MODEL_NAME:-tantular-office:0.3-8b}"
REGISTRY_TAG="latest"

# Machines without enough RAM for an 8B model (~5GB weights) swap to disk and
# time out on every Studio call. Use the lighter 4B variant there instead.
TOTAL_RAM_GB=$(( $(sysctl -n hw.memsize 2>/dev/null || echo 0) / 1073741824 ))
LITE_MODE=0
if [ -z "${TANTULAR_OFFICE_BASE_MODEL:-}" ] && [ "$TOTAL_RAM_GB" -gt 0 ] && [ "$TOTAL_RAM_GB" -lt 12 ]; then
  LITE_MODE=1
  BASE_MODEL="qwen3:4b"
  MODEL_NAME="tantular-office:lite"
  REGISTRY_TAG="lite"
  echo "RAM terdeteksi ${TOTAL_RAM_GB}GB (<12GB): memakai model ringan $MODEL_NAME."
fi

# The Ollama Mac app ships its CLI inside the bundle; it may not be on PATH
# yet on a fresh install, so resolve the binary from known locations too.
OLLAMA_BIN="$(command -v ollama || true)"
if [ -z "$OLLAMA_BIN" ]; then
  for candidate in /usr/local/bin/ollama /opt/homebrew/bin/ollama "/Applications/Ollama.app/Contents/Resources/ollama"; do
    if [ -x "$candidate" ]; then OLLAMA_BIN="$candidate"; break; fi
  done
fi

if [ -z "$OLLAMA_BIN" ]; then
  echo "Ollama tidak ditemukan. Instal Ollama terlebih dahulu." >&2
  exit 1
fi

# Preferred path: pull the published model, then alias it to the local name
# the add-in expects in the Model Studio field.
echo "Mengunduh $REGISTRY_MODEL:$REGISTRY_TAG dari ollama.com..."
if "$OLLAMA_BIN" pull "$REGISTRY_MODEL:$REGISTRY_TAG"; then
  "$OLLAMA_BIN" cp "$REGISTRY_MODEL:$REGISTRY_TAG" "$MODEL_NAME"
else
  # Offline / registry-blocked fallback: build locally from the Modelfile.
  echo "Pull dari ollama.com gagal; mencoba build lokal dari Modelfile..."
  if ! "$OLLAMA_BIN" show "$BASE_MODEL" >/dev/null 2>&1; then
    echo "Base model $BASE_MODEL belum ada. Mengunduh..."
    "$OLLAMA_BIN" pull "$BASE_MODEL"
  fi
  echo "Membuat $MODEL_NAME dari $BASE_MODEL..."
  TMP_MODELFILE="$(mktemp)"
  sed "s|^FROM .*|FROM $BASE_MODEL|" "$ROOT/models/Modelfile.office-8b" > "$TMP_MODELFILE"
  "$OLLAMA_BIN" create "$MODEL_NAME" -f "$TMP_MODELFILE"
  rm -f "$TMP_MODELFILE"
fi

if [ "$LITE_MODE" = "1" ]; then
  echo "Selesai. PENTING: di Pengaturan model lokal, isi kolom 'Model Studio' dengan: $MODEL_NAME"
else
  echo "Selesai. Gunakan Model deck: $MODEL_NAME"
fi
