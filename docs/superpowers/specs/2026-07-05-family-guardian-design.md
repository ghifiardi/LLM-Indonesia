# Family Guardian (Tantular Guard)

**Status:** design + implementation candidate
**Date:** 2026-07-05
**Branch:** feat/tantular-model-naming

## Why

The strongest growth + retention driver: let an adult child protect a parent
(or vice-versa). When Tantular blocks a scam on the protected phone, a linked
guardian is alerted so they can call and intervene. Emotional, recurring,
multi-device, word-of-mouth.

## Hard constraint: stay on-device / no server

Tantular's promise is "no cloud, message never leaves the device." Family
Guardian must not break that. So the transport is the phone's own SMS, not a
backend:

```
Protected phone detects BLOCK / account-takeover
  -> Tantular sends a SHORT, privacy-safe alert SMS to the guardian number(s)
  -> no message content is included, no server, no cloud
```

This reuses the SEND_SMS capability already declared in the manifest.

## Privacy rules (non-negotiable)

- The alert SMS contains: protected person's chosen display name (optional),
  the risk level, and a short signal summary (e.g. "diminta OTP"). It NEVER
  includes the original message text, sender, or any PII.
- Guardian numbers are stored locally only.
- Feature is OFF by default; enabling shows a clear explanation + requests
  SEND_SMS at runtime.
- Rate-limited (default 1 alert / 5 minutes) to avoid spam and pulsa drain.

## Data model (local, SharedPreferences + JSON)

```
guardian_on: Boolean
protected_name: String        # e.g. "Ibu" (optional)
guardian_numbers: [String]    # normalized
last_alert_ms: Long
```

## Pure logic (unit-tested): GuardianAlert

```kotlin
normalizeNumber(raw): String     // trim, strip spaces/dashes, 08xx -> +628xx
isValidNumber(raw): Boolean      // >= 9 digits after normalize
buildAlert(name, level, signals): String   // privacy-safe SMS body
shouldSend(now, last, minInterval): Boolean
```

## Android glue: GuardianAlerter

```
maybeAlert(context, verdict, source):
  if !enabled or numbers empty -> return
  if verdict != BLOCK and !accountTakeover -> return
  if SEND_SMS not granted -> return
  if !shouldSend(now, last, MIN_INTERVAL) -> return
  send multipart SMS to each guardian; update last_alert_ms; log
sendTest(context): send a sample alert now (ignores verdict + rate limit)
```

Hook points:
- `SmsReceiver` (incoming SMS BLOCK / takeover)
- `MainActivity.evaluateCurrent` (manual check BLOCK / takeover)

## UI: "🛡️ Pelindung Keluarga" card

- Switch: Aktifkan Pelindung Keluarga (requests SEND_SMS)
- Field: nama yang dilindungi (opsional), e.g. "Ibu"
- Field + Tambah: nomor HP pelindung; list with hapus
- Button: Kirim tes ke pelindung
- Button: Lihat contoh pesan (preview, no send)
- Privacy note about SMS + pulsa + no content shared

## Alert copy (example)

```
[Tantular Guard] Peringatan: Ibu menerima pesan berisiko tinggi (diminta OTP).
Mohon segera hubungi dan ingatkan jangan beri OTP/PIN atau klik tautan.
```

## Testing

- GuardianAlertTest (JVM): normalize, validation, rate-limit, alert text
  contains name + level, and NEVER contains the raw message.
- On device: add own second number, tap "Kirim tes", confirm SMS arrives.
  (Real cross-device send needs a second phone/number; costs pulsa.)

## Out of scope (later slices)

- Two-way linking / pairing codes, guardian-side app confirmation.
- Delivery receipts, escalation if unanswered.
- Non-SMS transport.
