# Tantular Guard — On-device SLM Runtime

This document describes the production-privacy SLM path for Tantular Guard:

```text
local rules first
  -> on-device SLM only for borderline messages
  -> no cloud by default
  -> remote Ollama only as explicit dev mode
```

The app is wired so the default SLM backend is `OnDeviceSlmClassifier`. The
actual native runtime is provided by `libtantular-llama.so`, a JNI bridge around
llama.cpp.

## Current implementation

Implemented in this repo:

```text
app/src/main/java/ai/sakana/tantularguard/SlmClassifier.kt
  NativeLlama        # Kotlin JNI bridge + model cache
  OnDeviceSlmClassifier

app/src/main/cpp/CMakeLists.txt
app/src/main/cpp/tantular_jni.cpp
  libtantular-llama.so JNI layer

scripts/fetch_llama_cpp.sh
  fetches llama.cpp into app/src/main/cpp/llama.cpp

scripts/install_tantular_model.sh
  pushes tantular.gguf to the device path expected by the app
```

The native build is **opt-in**. A normal Gradle build remains pure Kotlin and
falls back to deterministic local rules if no native library is bundled.

## Build prerequisites

Install:

- JDK 17
- Android Studio or Android SDK command line tools
- Android NDK
- CMake 3.22.1 or compatible Android Studio CMake
- `git`
- `adb`

## Fetch llama.cpp

From the repository root:

```bash
cd godel_agent_prototype/android/TantularGuard
./scripts/fetch_llama_cpp.sh
```

Optional pin:

```bash
LLAMA_CPP_REF=<commit-or-tag> ./scripts/fetch_llama_cpp.sh
```

The fetched checkout is git-ignored:

```text
app/src/main/cpp/llama.cpp/
```

## Build an APK with native SLM enabled

```bash
cd godel_agent_prototype/android/TantularGuard
./gradlew assembleDebug -PtantularNative=true
```

Without `-PtantularNative=true`, the app still builds and runs, but the
on-device SLM runtime is unavailable and the app falls back to local rules.

## Install a GGUF model

The APK does not bundle model weights by default. Push a GGUF model after
installing the APK:

```bash
./scripts/install_tantular_model.sh /path/to/base.gguf /path/to/tantular-lora.gguf
```

Expected device path:

```text
/sdcard/Android/data/ai.sakana.tantularguard/files/models/tantular.gguf
/sdcard/Android/data/ai.sakana.tantularguard/files/models/tantular-lora.gguf  # optional LoRA adapter
```

Then open the app:

1. Enable `Gunakan Tantular SLM on-device untuk kasus borderline`.
2. Select `On-device Tantular SLM (default, tanpa cloud)`.
3. Paste/share a borderline message.

Clear ALLOW and clear BLOCK cases skip SLM inference. OTP/PIN/CVV/password/APK
and remote-access requests are deterministic hard-safety gates.


## Install from local Ollama model

If the model already exists in Ollama, install its local base GGUF blob and
optional LoRA adapter blob directly:

```bash
./scripts/install_ollama_tantular_model.sh tantular:0.2-id-3b-lora
```

This script parses `ollama show --modelfile`, finds the `FROM` blob and
`ADAPTER` blob, then pushes them to:

```text
/sdcard/Android/data/ai.sakana.tantularguard/files/models/tantular.gguf
/sdcard/Android/data/ai.sakana.tantularguard/files/models/tantular-lora.gguf
```

## Runtime behavior

- `NativeLlama` tries to load `libtantular-llama.so` at startup.
- If the library is missing, `NativeLlama.AVAILABLE == false`.
- If the model file is missing, the SLM returns an unavailable error.
- In both cases, Tantular Guard falls back to local rules and does not crash.
- The native layer caches the loaded model handle and runs classification on a
  background thread from `MainActivity`.

## Model recommendation

For phones, start with the smallest acceptable model:

- 1.5B or smaller for broad device coverage.
- 3B Q4 only for mid/high-end devices.
- Keep inference limited to borderline cases to protect battery and latency.

Use a constrained one-word classifier prompt returning:

```text
PENIPUAN
MENCURIGAKAN
AMAN
```

Kotlin parses the raw output defensively in `SlmParsing.parse(...)`.

## Known limitations

- This JNI bridge targets a recent llama.cpp API. If the pinned llama.cpp commit
  changes APIs, adjust `tantular_jni.cpp` accordingly.
- The bridge uses CPU-only inference by default for predictable Android behavior.
- The native code has not been compiled in the current Codex shell because this
  shell has no Java Runtime/Android NDK available.
- The model is not bundled into the APK, which avoids a huge APK and keeps model
  distribution explicit.

## Privacy claim boundary

It is safe to say:

> Rules run locally first. The production SLM path is on-device and no cloud is
> used by default. Remote Ollama is dev-only and explicit.

Do not say:

> The current APK always runs the real SLM on-device.

unless the APK was built with `-PtantularNative=true`, llama.cpp compiled
successfully, and `tantular.gguf` is installed on the device.
