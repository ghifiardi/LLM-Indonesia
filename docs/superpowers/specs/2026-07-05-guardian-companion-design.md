# Guardian Companion — in-app alert inbox (Family Guardian, slice 2)

**Status:** approved ("just build it"), implementing
**Date:** 2026-07-05
**Branch:** feat/tantular-model-naming

## Problem

Family Guardian alerts are carrier-DELIVERED to the guardian's number but the
guardian sometimes never sees them — the phone's Messages app filters the
scam-wording SMS into a spam/blocked folder. No cloud is allowed, so SMS stays
the transport; we need the alert to surface reliably on the guardian's phone.

## Insight

`SMS_RECEIVED` broadcasts reach observer apps **regardless** of how the default
Messages app later files the message (spam folder is a default-app behavior). So
Tantular on the guardian's phone, with RECEIVE_SMS, can catch its own alert SMS
directly and surface it loudly — bypassing the Messages app entirely.

## Design

**Mode Pelindung (guardian receiving mode)** — a new opt-in toggle, independent
of the scam-guard toggle. When on (and RECEIVE_SMS granted):

- `SmsReceiver.onReceive` first checks every incoming SMS: if the body carries
  the Tantular alert signature, it is a guardian alert → store in
  `GuardianInbox` + post a prominent "🛡️ Peringatan Keluarga" notification, then
  return (do not scam-score our own alert). Runs for both SMS_RECEIVED and
  SMS_DELIVER; if this app is the default SMS app it also writes the alert to the
  inbox so nothing is lost.

**Signature.** `GuardianAlert.ALERT_SIGNATURE = "dari aplikasi Tantular"` (the
existing sign-off). `looksLikeGuardianAlert(body)` = body contains it. Stable,
human-readable, not spam-triggering.

**Store `GuardianInbox`** (SharedPreferences + JSON, capped, like GuardLog):
`Entry(id, timestampMs, sender, body)`; `add`, `list`, `count`, `clear`.

**`GuardianInboxActivity`** (programmatic, mirrors GuardLogActivity): list of
received alerts (time, sender, full alert text), with a Kosongkan button.

**UI.** A home card "📥 Mode Pelindung": toggle + a count + "Lihat pesan" button.
Enabling the toggle requests RECEIVE_SMS (reuses the Stage-2 permission request).

## Wiring

- `MainActivity`: `KEY_GUARDIAN_MODE_ON = "guardian_mode_on"`; toggle + button +
  `refreshGuardianInbox()`; request RECEIVE_SMS on enable.
- `AndroidManifest`: register `.GuardianInboxActivity`.
- `strings.xml`: `guardian_mode_*`, `guardian_inbox_*` strings.

## Honest limit

If the alert is dropped in the carrier cloud (never reaches the handset), no
receiver fires and this cannot help. But the delivery reports we saw were
`DELIVERED` (handset-level), which is exactly the spam-folder case this fixes.

## Test

On the guardian phone: install Tantular, enable Mode Pelindung, grant SMS. From
the protected phone trigger a scam → guardian phone shows the "🛡️ Peringatan
Keluarga" notification and the alert appears in Kotak Pelindung, even if the
Messages app files the SMS as spam.
