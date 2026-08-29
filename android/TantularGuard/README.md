# Tantular Guard Android — Pattern C

This is the Android project for **Pattern C**.

Implemented stages:

```text
Stage 1: paste/share suspicious SMS or WhatsApp text
  -> local BLOCK / WARN / ALLOW verdict
  -> user sees a safety warning

Stage 2: opt-in incoming SMS guard
  -> incoming SMS is checked locally
  -> BLOCK/WARN messages trigger a Tantular Guard notification
  -> tap notification to inspect the message in the app

Stage 2B: default-SMS quarantine prototype
  -> user makes Tantular Guard the default SMS app
  -> BLOCK/WARN SMS are stored in local quarantine, not written to inbox
  -> ALLOW SMS are written to the SMS inbox
```

Default privacy posture:

- no WhatsApp scraping;
- no notification-listener permission;
- no network by default;
- SMS guard is opt-in;
- background SMS checks do **not** call Ollama/SLM;
- optional Tantular SLM/Ollama backend only runs when the user enables it in the app.

## Current APK output

A debug APK has been built by Android Studio/Gradle and is available at:

```text
app/build/outputs/apk/debug/app-debug.apk
```

A convenience copy is also available from the repository reports directory:

```text
../../reports/tantular-guard-stage1-debug.apk
```

After source changes, rebuild from Android Studio or run:

```bash
./gradlew assembleDebug
```

Note for this Codex shell: `./gradlew assembleDebug` cannot run here until a Java Runtime is available on PATH. Android Studio normally supplies this when you build from the IDE.

## Stage 1 — paste/share flow

1. User opens Tantular Guard.
2. User pastes a suspicious SMS/WhatsApp text, or shares text into the app via Android's share sheet.
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

## Stage 2 — SMS guard opt-in

When enabled:

```text
incoming SMS
  -> SmsReceiver
  -> RiskScorer local rules
  -> if BLOCK/WARN: show Tantular Guard notification
  -> tap notification: open app with SMS prefilled
```

Files:

```text
app/src/main/java/ai/sakana/tantularguard/SmsReceiver.kt
app/src/main/AndroidManifest.xml
app/src/main/res/layout/activity_main.xml
```

Permissions:

```xml
<uses-permission android:name="android.permission.RECEIVE_SMS" />
<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
```

The app requests these at runtime only when the user turns on:

```text
Aktifkan pemeriksaan SMS masuk
```

Privacy behavior:

- SMS is checked locally with deterministic rules.
- Background SMS receiver does **not** call Ollama/SLM.
- SLM can still be run manually after the user taps the notification/open app.
- WhatsApp is not read automatically.

### Test Stage 2 in Android emulator

Install and run the app, then enable SMS guard in the UI. From your host shell:

```bash
adb emu sms send +628123456789 "Pak, saya CS bank. Untuk batalkan transaksi, tolong sebutkan OTP dan PIN Anda sekarang juga."
```

Expected: Tantular Guard posts a warning notification. Tap it to open the app with the SMS text prefilled.

### Test Stage 2 on a physical phone

1. Install the APK.
2. Enable SMS guard in the app.
3. Grant SMS and notification permissions.
4. Send a test SMS to the phone from another number.

Use harmless test messages that resemble scams; do not use real OTPs.

## Stage 2B — default-SMS quarantine prototype

Stage 2 warning mode cannot stop SMS delivery: Android still sends the SMS to
the default Messages app. To actually keep a scam SMS out of the primary inbox,
Tantular Guard must become the default SMS app.

The prototype now exposes:

```text
2B. Quarantine mode — default SMS app
```

Flow:

```text
Tap "Jadikan Tantular Guard aplikasi SMS default"
  -> Android default-SMS role dialog
  -> incoming SMS delivered to Tantular Guard
  -> RiskScorer evaluates locally
  -> BLOCK/WARN: store in local quarantine + notification
  -> ALLOW: insert into system SMS inbox
```

Files:

```text
app/src/main/java/ai/sakana/tantularguard/SmsQuarantine.kt
app/src/main/java/ai/sakana/tantularguard/SmsReceiver.kt
app/src/main/java/ai/sakana/tantularguard/MmsReceiver.kt
app/src/main/java/ai/sakana/tantularguard/RespondViaMessageService.kt
```

Default-SMS candidacy entries:

```xml
SMS_DELIVER receiver
WAP_PUSH_DELIVER receiver (MMS no-op)
ACTION_SENDTO activity
RESPOND_VIA_MESSAGE service
```

Limitations:

- This is a quarantine prototype, not a full SMS replacement.
- MMS is no-op.
- SMS sending/threads/conversation UI are not implemented.
- Use for controlled testing; do not use as your daily default SMS app yet.

### Test Stage 2B

1. Install the rebuilt APK.
2. Open Tantular Guard.
3. Enable `Aktifkan pemeriksaan SMS masuk`.
4. Tap `Jadikan Tantular Guard aplikasi SMS default`.
5. Accept Android's default-SMS role dialog.
6. Send a scam-like SMS.

Expected:

- BLOCK/WARN message: appears in Tantular Guard quarantine, not the normal inbox.
- ALLOW message: written to SMS inbox.

Open the latest quarantined message with:

```text
Buka terakhir
```

## Tantular SLM layer — production privacy architecture

The app is now wired around the production privacy goal:

```text
message -> RiskScorer rules (offline, instant BLOCK/WARN/ALLOW)
        -> if and only if the message is borderline AND "Gunakan Tantular SLM" is ON:
             default backend: on-device Tantular GGUF runtime
             dev-only backend: explicit Ollama HTTP server
        -> fuse: the SLM can only ESCALATE, never downgrade the rules' verdict
```

Key invariants:

- Local deterministic rules always run first.
- OTP, PIN/CVV, password, APK-install, and remote-access requests are deterministic hard-safety gates and can BLOCK without any model.
- SLM inference is skipped for clear ALLOW and clear BLOCK cases.
- The selected default SLM backend is **on-device**.
- The Ollama HTTP backend is still available only as an explicit **Dev only** option.
- Background SMS handling does not call remote SLM; it stays local and deterministic.
- The SLM can escalate a borderline case, but it cannot downgrade hard fraud rules.

Files:

```text
app/src/main/java/ai/sakana/tantularguard/RiskScorer.kt      # pure rules + borderline gate
app/src/main/java/ai/sakana/tantularguard/SlmClassifier.kt   # on-device seam + dev Ollama backend
app/src/main/java/ai/sakana/tantularguard/MainActivity.kt    # backend selector + fusion flow
```

Current implementation status:

- `OnDeviceSlmClassifier` is the production-default path.
- `NativeLlama` loads `libtantular-llama.so` when the APK is built with the optional native runtime.
- If the native library or model file is missing, the app falls back safely to local rules and shows a status message.
- Full build/setup instructions live in `ON_DEVICE_SLM.md`.
- The model path expected by the prototype is:

```text
/sdcard/Android/data/ai.sakana.tantularguard/files/models/tantular.gguf
/sdcard/Android/data/ai.sakana.tantularguard/files/models/tantular-lora.gguf  # optional LoRA adapter
```

Native build quick start:

```bash
cd godel_agent_prototype/android/TantularGuard
./scripts/fetch_llama_cpp.sh
./gradlew assembleDebug -PtantularNative=true
./scripts/install_tantular_model.sh /path/to/base.gguf /path/to/tantular-lora.gguf
```

Optional dev server testing:

1. Select `Dev only: server Ollama / HTTP` in the SLM backend selector.
2. Run `ollama serve` on a reachable machine.
3. Use one of these endpoints:

- Android emulator → host machine: `http://10.0.2.2:11434`
- Real device → dev machine on same Wi-Fi: `http://<your-ip>:11434`

The dev model tag is `tantular:0.2-id-3b-lora` (see `strings.xml` → `slm_model`). This dev mode is not the production privacy posture because borderline messages are sent to the configured server.

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
        SmsReceiver.kt
      res/layout/activity_main.xml
      res/values/*.xml
      res/drawable/*.xml
```

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

## Why rules + SLM

Why not rely only on the SLM?

- Scam protection needs predictable behavior.
- OTP/PIN/CVV/APK/link/remote-access cases must be hard-gated.
- A small model can add context and natural language explanation, but the app should still have deterministic rules for critical threats.

The SLM is advisory only: it can escalate, but it cannot downgrade the rule floor.
