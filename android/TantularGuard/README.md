# Tantular Guard Android — Stage 1 APK Scaffold

This is the Android scaffold for **Pattern C, Stage 1**:

```text
paste/share suspicious SMS or WhatsApp text
  -> local BLOCK / WARN / ALLOW verdict
  -> user sees a safety warning
```

Stage 1 is intentionally conservative:

- no SMS permission;
- no notification-listener permission;
- no WhatsApp scraping;
- the user explicitly pastes or shares text into the app;
- **no network by default** — the message never leaves the device unless you
  explicitly enable the optional Tantular SLM layer (see below).

This makes the first APK demo safer and easier to review.

## Tantular SLM layer (opt-in, implemented)

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

> On-device inference (a quantized GGUF via llama.cpp/MediaPipe, no server) is
> the production target and is not in this build — the HTTP backend is the
> testable dev path today.

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

If `gradlew` is not present yet, open the project in Android Studio or run Gradle
from a machine with Android Gradle Plugin support. Android Studio can generate
the wrapper for this project.

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

Stage 1 is **not yet the SLM**. It is the local safety shell around the future
SLM:

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

Future SLM stage:

```text
RiskScorer says WARN/BLOCK candidate
  -> run quantized Tantular 1.5B/3B locally
  -> model classifies: penipuan / mencurigakan / aman
  -> app combines model verdict with hard safety rules
```

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

