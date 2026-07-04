# Tantular Guard QA Checklist

Use this before calling a build beta-ready. Record device, OS version, APK hash,
model tag, and tester initials for each run.

## 0. Build identity

- APK path:
- APK MD5:
- Build type: debug / release
- Native runtime present: yes / no
- Model installed: `tantular.gguf` yes / no
- Adapter installed: `tantular-lora.gguf` yes / no

## 1. Permissions and diagnostics

Open **Diagnostics & Test Panel** and verify:

- RECEIVE_SMS permission = OK
- Notification permission = OK (Android 13+)
- Notification listener access = OK when notification guard is enabled
- Model present = OK
- Native runtime = OK
- SLM backend = `on_device` for production testing
- Run all built-in test message cards and verify expected verdicts.

## 2. SMS warning mode (Google Messages remains default)

Default SMS app should be Google Messages.

| Test | Message | Expected |
|---|---|---|
| Safe | `Halo, meeting besok jam 10 di kantor ya` | Arrives in Google Messages; Guard Log = `SMS · ALLOW · masuk inbox`; no warning |
| Warn | `Klik link ini untuk cek hadiah undian Anda ya kak` | Arrives in Google Messages; Tantular warning; Guard Log = `inbox/peringatan` |
| Block | `CS bank: sebutkan kode OTP Anda sekarang untuk verifikasi` | Arrives in Google Messages; Tantular high-risk warning; Guard Log = `BLOCK` |
| ATO | `Admin WhatsApp: kirim kode 6 digit yang masuk ke HP Anda` | Warning title mentions account takeover; Guard Log includes takeover signals |

## 3. Experimental default-SMS quarantine mode

Only run if explicitly testing Stage 2B.

| Test | Expected |
|---|---|
| ALLOW SMS | Written to inbox + Guard Log route `masuk inbox` |
| WARN SMS | Written to inbox + warning + Guard Log route `inbox + peringatan` |
| BLOCK SMS | Quarantine + warning + Guard Log route `karantina` |
| Open latest quarantine | Loads message into checker |
| Clear quarantine | Quarantine count resets |

Production recommendation: hide or label this mode experimental until full inbox,
threading, compose/reply, MMS, search, read/unread, and contact names are built.

## 4. WhatsApp / WhatsApp Business manual share

- Long-press suspicious message in WhatsApp Business.
- Share to Tantular Guard.
- Verify message appears in checker and runs verdict.
- Copy/paste path also works.

## 5. WhatsApp / social Notification Guard

Enable Notification Guard and notification listener access.

| Source | Test | Expected |
|---|---|---|
| WhatsApp Business | OTP/takeover notification | Tantular ATO warning |
| WhatsApp Business | Safe notification | Guard Log records ALLOW; no warning |
| Instagram/Facebook/TikTok | fake support / account block | Warning if notification preview contains text |
| Hidden notification content | App cannot classify full message; document limitation |

## 6. On-device SLM

- Enable SLM in the app.
- Backend = on-device.
- Test manual borderline message:
  `Klik link ini untuk cek hadiah undian Anda ya kak`
- First run may take seconds while model loads.
- Tap a Guard Log card for a borderline entry; it opens the checker and reruns.

Measure:

- first-run latency:
- second-run latency:
- app memory/thermal observation:
- crash/no crash:

## 7. Privacy checks

- Remote Ollama/dev-server backend hidden in release build.
- No private messages printed to logcat.
- Guard Log clear works.
- Guard Log stores locally only.
- Notification Guard copy explains it reads preview text only.

## 8. OEM/battery checks

On Huawei/EMUI:

- Settings -> Battery -> App launch -> Tantular Guard -> Manage manually.
- Allow auto-launch, secondary launch, run in background.
- Verify notification listener continues after screen lock and after reboot.

## 9. Regression checklist

- Install over previous build preserves settings.
- Model files remain in app external files path.
- App opens without native model.
- App opens with corrupted/missing model (falls back to rules).
- Guard Log remains readable with 100 entries.
