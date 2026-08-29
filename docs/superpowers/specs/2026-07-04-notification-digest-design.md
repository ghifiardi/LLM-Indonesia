# Personal Notification Digest (Consumer Message Assistant, Cluster D — slice 1)

**Status:** design + implementation candidate
**Date:** 2026-07-04
**Branch:** feat/tantular-model-naming

## Context

Tantular already has an opt-in NotificationListenerService that warns on risky
notifications. This slice reuses the SAME listener to also organize everyday
notifications into a friendly, on-device daily digest — reducing notification
overload without sending anything to the cloud.

## Goal

For notifications from monitored apps, classify each into a category and keep a
small local, grouped, daily digest the user can open on demand.

Categories:

```
keuangan | paket | sekolah | kerja | keluarga | kesehatan | travel | promo |
keamanan_akun | umum
```

100% local, no network. Only preview text of monitored apps (same privacy
posture as the existing notification guard).

## Non-goals (this slice)

- No scheduled daily push ("ringkasan siap") yet — on demand only.
- No SLM summarization — deterministic category + short preview only.
- No cross-device sync, no export.

## Reuse

- `NotificationClassifier` (new, deterministic) gives the category + priority.
- `NotificationDigestStore` (new) persists entries (SharedPreferences + JSON,
  capped, like SmsQuarantine/GuardLog).
- `NotificationGuardService` adds one call to store a digest entry — this runs
  even when the message is ALLOW (safe), because digest is about organizing, not
  warning. Guard warnings remain unchanged.

## Capture scope (content-first, not messaging-only)

The digest examples are BCA / JNE / Shopee / Grab — finance, delivery, promo —
whose packages are NOT in the scam guard's messaging-only `MONITORED_PACKAGES`.
So the digest must capture more broadly, but safely:

- **Skip** own package and system/launcher/keyboard packages (`android`,
  `com.android.*`, `com.google.android.gms`, systemui, package installer,
  anything containing `launcher`), plus group-summary and empty notifications.
- **Classify** title+text.
- **Store** when `category != umum`, OR when the package is a monitored
  messenger (keeps personal `umum` chats). Other `umum` notifications are dropped
  so random app noise is not stored.

Any bank/delivery/travel app then works automatically via its Indonesian keyword
text (transaksi, resi, tiket, …). App display name comes from `PackageManager`,
not a guessed package→name map.

## Data model

```kotlin
data class DigestEntry(
    val id: String,
    val timestampMs: Long,
    val packageName: String,
    val app: String,       // human app label (PackageManager)
    val category: String,  // keuangan | paket | ...
    val priority: String,  // tinggi | sedang | rendah
    val title: String,
    val preview: String,   // trimmed notification text
)
```

Store API: `add` (dedupes same package+preview), `list`, `today`, `groupedToday`,
`count`, `countToday`, `clear`. Cap 200 items.

Priority: `tinggi` for keamanan_akun or text with segera/jatuh tempo/deadline/
terakhir/expired/diblokir; `sedang` for keuangan/paket/kesehatan/travel; else
`rendah`. "Penting saja" filter hides `promo` + `umum`.

## Classifier rules (deterministic, Indonesian-tuned)

| category | signals |
|---|---|
| keamanan_akun | otp, kode verifikasi, kode login, login, verifikasi, perangkat tertaut |
| keuangan | transfer, saldo, transaksi, qris, pembayaran, debit, kredit, tagihan, bank, e-wallet, gopay, ovo, dana, bca, bri, mandiri, bni |
| paket | paket, resi, kurir, dikirim, pengiriman, cod, pesanan, shopee, tokopedia, jne, j&t, sicepat, anteraja |
| sekolah | sekolah, kelas, guru, siswa, orang tua, kampus, ujian, spp |
| kerja | meeting, rapat, hr, interview, kantor, deadline, proyek, gaji |
| kesehatan | dokter, klinik, rumah sakit, obat, kontrol, resep, bpjs kesehatan, vaksin |
| travel | tiket, booking, hotel, pesawat, kereta, penerbangan, check-in, boarding |
| promo | promo, diskon, cashback, voucher, gratis, flash sale, kupon |
| umum | fallback |

Priority order: keamanan_akun first, then finance/package/etc; umum last.

## UI

- Home card: "🗂️ Ringkasan notifikasi" with count + button "Lihat ringkasan".
- `NotificationDigestActivity`: grouped by category, each group shows up to 5
  recent items (app label, time, preview). Buttons: Muat ulang, Hapus.
- Only meaningful when notification access + notif guard are enabled; if not,
  card explains how to enable.

## Privacy copy

"Tantular hanya membaca teks notifikasi yang muncul, bukan seluruh isi chat.
Ringkasan disimpan di HP dan bisa dihapus kapan saja."

## Testing

Python reference `classify_notification(text)` + smoke cases:

1. "BCA: transaksi Rp125.000 berhasil" -> keuangan
2. "JNE: paket akan tiba hari ini" -> paket
3. "Sekolah: pembayaran kegiatan paling lambat Jumat" -> sekolah
4. "Promo diskon 40% khusus hari ini" -> promo
5. "Kode OTP Anda 123456" -> keamanan_akun
6. "Dokter: jadwal kontrol Selasa 09.00" -> kesehatan
7. "Tiket kereta Anda sudah terbit" -> travel
8. "Halo apa kabar" -> umum

Kotlin `NotificationClassifier` mirrors the reference; unit test with same cases.
