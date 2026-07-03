# Tantular Guard Android — Stage 1 APK

This is the Android project for **Pattern C, Stage 1**:

```text
paste/share suspicious SMS or WhatsApp text
  -> local BLOCK / WARN / ALLOW verdict
  -> user sees a safety warning
```

Stage 1 is intentionally conservative by default:

- no SMS permission;
- no notification-listener permission;
- no WhatsApp scraping;
- the user explicitly pastes or shares text into the app;
- **no network by default** — the message never leaves the device unless you
  explicitly enable the optional Tantular SLM layer (see below).

This makes the first APK demo safer and easier to review.

## Current APK output

A debug APK has been built by Android Studio/Gradle and is available at:

```text
app/build/outputs/apk/debug/app-debug.apk
```

A convenience copy is also available from the repository reports directory:

```text
../../reports/tantular-guard-stage1-debug.apk
```

If you modify source after this point, rebuild from Android Studio or run:

```bash
./gradlew assembleDebug
```

Note for this Codex shell: `./gradlew assembleDebug` cannot run here until a
Java Runtime is available on PATH. Android Studio normally supplies this when
you build from the IDE.

## Tantular SLM layer (opt-in dev path, implemented)

The SLM reasoning layer is wired in behind the deterministic rules:

```text
message -> RiskScorer rules (offline, instant BLOCK/WARN/ALLOW)
        -> if borderline AND "Gunakan Tantular SLM" is ON:
             POST to your Ollama server /api/chat -> PENIPUAN / MENCURIGAKAN / AMAN
        -> fuse: the SLM can only ESCALATE, never downgrade the rules' verdict
```

Files: `SlmClassifier.kt` (interface + `OllamaSlmClassifier` HTTP backend +
offline `StubSlmClassifier`); fusion lives in `RiskScorer.evaluate(..., slmLabel)`.

**Test it:** run `ollama serve` on a reachable machine, then in the app tick
*Gunakan Tantular SLM* and set the endpoint:

- Android emulator → host machine: `http://10.0.2.2:11434`
- Real device → dev machine on same Wi-Fi: `http://<your-ip>:11434`

The model tag is `tantular:0.2-id-7b` (see `strings.xml` → `slm_model`). Only
borderline messages hit the server; hard fraud gates stay in the rules, so the
app is safe even if the server is down.

### On-device backend (slot present, native runtime pending)

The app now has a **backend selector**: *Di perangkat (on-device)* vs *Server
(Ollama)*. The on-device path is fully wired — `OnDeviceSlmClassifier` loads a
quantized GGUF from app storage and calls `NativeLlama` — but the native
llama.cpp layer (`NativeLlama.AVAILABLE = false`) is not compiled in yet, so
on-device selection reports *"runtime on-device belum terpasang"* and safely
falls back to the rules. This keeps the app shippable while the native `.so`
is finished.

Drop-in model path (adb-pushable, app-private external storage):

```bash
adb push tantular.gguf \
  /sdcard/Android/data/ai.sakana.tantularguard/files/models/tantular.gguf
```

Remaining work for true on-device: compile llama.cpp for `arm64-v8a` (NDK),
add JNI bindings, and implement `NativeLlama.classifyToken(...)`. Everything
above that seam is done.

> The HTTP/Ollama backend is the testable dev path today; on-device is the
> production target and only needs the native layer dropped into the seam.

## Project layout

```text
android/TantularGuard/
  settings.gradle.kts
  build.gradle.kts
  app/
    build.gradle.kts
    src/main/
      AndroidManifest.xml
      java/ai/sakana/tantularguard/
        MainActivity.kt
        RiskScorer.kt
        SlmClassifier.kt
      res/layout/activity_main.xml
      res/values/*.xml
      res/drawable/*.xml
```

## How Stage 1 works

1. User opens Tantular Guard.
2. User pastes a suspicious SMS/WhatsApp text, or shares text into the app via
   Android's share sheet.
3. `RiskScorer.kt` runs fully locally.
4. App shows:
   - `BLOCK`
   - `WARN`
   - `ALLOW`
5. App also shows matched risk signals, for example:
   - `minta_otp`
   - `minta_pin_cvv`
   - `link_mencurigakan`
   - `apk_mencurigakan`
   - `remote_access`

## Build APK

From this directory:

```bash
cd godel_agent_prototype/android/TantularGuard
./gradlew assembleDebug
```

APK output:

```text
app/build/outputs/apk/debug/app-debug.apk
```

Install to a connected Android device/emulator:

```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

If the shell says Java is missing, build from Android Studio instead:

1. File → Open → select `android/TantularGuard`
2. Wait for Gradle sync
3. Build → Build Bundle(s) / APK(s) → Build APK(s)
4. Use the generated `app-debug.apk`

## Test messages

BLOCK:

```text
Pak, saya CS bank. Untuk batalkan transaksi, tolong sebutkan OTP dan PIN Anda sekarang juga.
```

BLOCK:

```text
Selamat! Anda menang undian. Klik link ini dan install APK untuk klaim hadiah.
```

BLOCK:

```text
Petugas minta saya pasang AnyDesk untuk remote access agar bisa bantu refund.
```

ALLOW:

```text
Jadwal meeting tim besok jam 10 di ruang rapat, jangan lupa bawa laptop.
```

## How the SLM fits against phishing/scamming messages

The default Stage 1 path is the local safety shell:

```text
message text
  -> deterministic risk scorer
  -> if risky/borderline: local Tantular SLM
  -> deterministic safety floor
  -> UI warning
```

Why not rely only on the SLM?

- Scam protection needs predictable behavior.
- OTP/PIN/CVV/APK/link/remote-access cases must be hard-gated.
- A small model can add context and natural language explanation, but the app
  should still have deterministic rules for critical threats.

The current dev SLM path is opt-in:

```text
RiskScorer says WARN/BLOCK candidate
  -> if "Gunakan Tantular SLM" is enabled, call your configured Ollama endpoint
  -> Tantular classifies: PENIPUAN / MENCURIGAKAN / AMAN
  -> app combines model verdict with hard safety rules
```

The SLM is advisory only: it can escalate, but it cannot downgrade the rule
floor.

Recommended first SLM integration target:

- Tantular 1.5B or 3B quantized;
- local inference runtime such as llama.cpp/MLC/MediaPipe LLM depending on
  Android constraints;
- model only runs on suspicious/borderline messages to save battery.

## Future stages

### Stage 2 — SMS opt-in

Add Android SMS permission and evaluate incoming SMS locally. This requires
careful permission UX and policy review.

### Stage 3 — Notification opt-in

Add `NotificationListenerService` so the user can opt in to checking
notifications from SMS/WhatsApp/etc. This should be explicit, transparent, and
privacy-preserving.

### Stage 4 — On-device Tantular SLM

Add local quantized Tantular inference for borderline cases. Keep the rule-based
safety floor.
