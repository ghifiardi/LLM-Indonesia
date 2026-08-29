#!/usr/bin/env bash
set -euo pipefail

# Install an Ollama model's base GGUF blob and optional ADAPTER blob to an
# Android device/emulator for Tantular Guard on-device SLM testing.
#
# Usage:
#   scripts/install_ollama_tantular_model.sh tantular:0.2-id-3b-lora

MODEL_TAG="${1:-tantular:0.2-id-3b-lora}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v ollama >/dev/null 2>&1; then
  echo "ollama CLI not found" >&2
  exit 1
fi

MODELF=$(ollama show --modelfile "$MODEL_TAG")
BASE=$(printf '%s\n' "$MODELF" | awk '/^FROM \/.*\.ollama\/models\/blobs\// {print $2; exit}')
ADAPTER=$(printf '%s\n' "$MODELF" | awk '/^ADAPTER \/.*\.ollama\/models\/blobs\// {print $2; exit}')

if [[ -z "$BASE" || ! -s "$BASE" ]]; then
  echo "Could not find local Ollama base blob for $MODEL_TAG" >&2
  exit 1
fi

if [[ -n "$ADAPTER" && -s "$ADAPTER" ]]; then
  echo "Installing $MODEL_TAG with LoRA adapter"
  exec "$SCRIPT_DIR/install_tantular_model.sh" "$BASE" "$ADAPTER"
else
  echo "Installing $MODEL_TAG base model without adapter"
  exec "$SCRIPT_DIR/install_tantular_model.sh" "$BASE"
fi
