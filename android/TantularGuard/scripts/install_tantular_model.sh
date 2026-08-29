#!/usr/bin/env bash
set -euo pipefail

# Push a Tantular GGUF model, plus optional LoRA adapter, to the app-private
# external-files path expected by OnDeviceSlmClassifier.
#
# Usage:
#   scripts/install_tantular_model.sh /path/to/base.gguf [/path/to/adapter.gguf]
#
# Optional env:
#   PACKAGE=ai.sakana.tantularguard
#   DEVICE_SERIAL=<adb serial>
#   ADB=/path/to/adb

if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo "Usage: $0 /path/to/base.gguf [/path/to/adapter.gguf]" >&2
  exit 2
fi

MODEL="$1"
ADAPTER="${2:-}"
if [[ ! -s "$MODEL" ]]; then
  echo "Model file missing or empty: $MODEL" >&2
  exit 1
fi
if [[ -n "$ADAPTER" && ! -s "$ADAPTER" ]]; then
  echo "Adapter file missing or empty: $ADAPTER" >&2
  exit 1
fi

PACKAGE="${PACKAGE:-ai.sakana.tantularguard}"
if [[ -z "${ADB:-}" ]]; then
  if command -v adb >/dev/null 2>&1; then
    ADB="$(command -v adb)"
  elif [[ -x "$HOME/Library/Android/sdk/platform-tools/adb" ]]; then
    ADB="$HOME/Library/Android/sdk/platform-tools/adb"
  elif [[ -x "$HOME/android-sdk/platform-tools/adb" ]]; then
    ADB="$HOME/android-sdk/platform-tools/adb"
  else
    echo "adb not found. Set ADB=/path/to/adb" >&2
    exit 1
  fi
fi

ADB_CMD=("$ADB")
if [[ -n "${DEVICE_SERIAL:-}" ]]; then
  ADB_CMD=("$ADB" -s "$DEVICE_SERIAL")
fi

DEST_DIR="/sdcard/Android/data/${PACKAGE}/files/models"
MODEL_DEST="${DEST_DIR}/tantular.gguf"
ADAPTER_DEST="${DEST_DIR}/tantular-lora.gguf"

"${ADB_CMD[@]}" shell "mkdir -p '$DEST_DIR'"
"${ADB_CMD[@]}" push "$MODEL" "$MODEL_DEST"
if [[ -n "$ADAPTER" ]]; then
  "${ADB_CMD[@]}" push "$ADAPTER" "$ADAPTER_DEST"
fi
"${ADB_CMD[@]}" shell "ls -lh '$DEST_DIR'"

echo "Installed model at $MODEL_DEST"
if [[ -n "$ADAPTER" ]]; then
  echo "Installed LoRA adapter at $ADAPTER_DEST"
fi
echo "Open Tantular Guard -> enable SLM -> select On-device Tantular SLM."
