#!/usr/bin/env bash
set -euo pipefail

# Fetch a pinned llama.cpp checkout for the optional on-device Tantular SLM build.
# Usage:
#   android/TantularGuard/scripts/fetch_llama_cpp.sh
#   LLAMA_CPP_REF=<commit-or-tag> android/TantularGuard/scripts/fetch_llama_cpp.sh
#
# The directory is intentionally git-ignored so this repo stays small.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CPP_DIR="$PROJECT_DIR/app/src/main/cpp"
TARGET_DIR="$CPP_DIR/llama.cpp"
REPO_URL="${LLAMA_CPP_REPO:-https://github.com/ggerganov/llama.cpp.git}"
# Keep a visible default rather than silently tracking moving master. Override if
# a newer llama.cpp is required for your NDK/toolchain.
REF="${LLAMA_CPP_REF:-master}"

mkdir -p "$CPP_DIR"

if [[ -d "$TARGET_DIR/.git" ]]; then
  echo "llama.cpp already exists at $TARGET_DIR"
  git -C "$TARGET_DIR" fetch --tags --depth 1 origin "$REF"
  git -C "$TARGET_DIR" checkout FETCH_HEAD
else
  echo "Cloning llama.cpp ($REF) into $TARGET_DIR"
  git clone --depth 1 --branch "$REF" "$REPO_URL" "$TARGET_DIR" 2>/dev/null || {
    echo "Branch/tag clone failed; trying generic fetch of ref $REF"
    rm -rf "$TARGET_DIR"
    git clone --depth 1 "$REPO_URL" "$TARGET_DIR"
    git -C "$TARGET_DIR" fetch --tags --depth 1 origin "$REF"
    git -C "$TARGET_DIR" checkout FETCH_HEAD
  }
fi

echo "llama.cpp ready: $(git -C "$TARGET_DIR" rev-parse --short HEAD)"
echo "Next build: ./gradlew assembleDebug -PtantularNative=true"
