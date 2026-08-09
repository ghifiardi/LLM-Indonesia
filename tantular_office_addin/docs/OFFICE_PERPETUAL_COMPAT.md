# Checklist Kompatibilitas: Office 2019 / 2021 / 2024 (Lisensi Perpetual)

Tantular dibangun di platform web add-in (Office.js) yang juga tersedia di Office versi beli-putus (perpetual), bukan hanya Microsoft 365. Perbedaannya: versi perpetual **membeku pada level API saat rilis** — tidak pernah mendapat requirement set baru. Dokumen ini adalah checklist verifikasi per mesin sebelum workshop/deployment.

## Ringkasan dukungan

| Versi Office | Mac | Windows | Catatan |
|---|---|---|---|
| Microsoft 365 (langganan) | ✅ | ✅ | Target utama; teruji |
| Office 2024 (perpetual) | ✅ diharapkan | ✅ diharapkan | WebView modern; verifikasi 1x per SKU |
| Office 2021 (perpetual) | ✅ diharapkan | ✅ diharapkan | WebView2 (Windows); verifikasi 1x |
| Office 2019 (perpetual) | ⚠️ kemungkinan bisa | ❌ berisiko tinggi | Windows 2019 memakai webview IE11 lama yang **tidak mendukung ES modules** — pane Tantular kemungkinan blank. Lihat §4 |
| Office 2016 dan lebih lama | ❌ | ❌ | Tidak direkomendasikan |
| Office di web | ✅ | ✅ | Companion harus berjalan lokal |

> Prasyarat yang berlaku untuk SEMUA versi: Tantular Companion + Ollama berjalan di mesin yang sama. Versi Office bukan penentu utama — spesifikasi mesin (RAM untuk model) tetap syarat terberat.

## 1. Identifikasi versi (per mesin)

- **File → Account (Akun)** → lihat "About Word/PowerPoint/Excel": catat versi (2019/2021/2024/M365) dan build.
- Pastikan menu **Insert → My Add-ins / Add-ins** ada. Jika tidak ada sama sekali → platform add-in tidak tersedia (Office terlalu lama / SKU tertentu) → mesin tidak didukung.

## 2. Pemasangan (sama dengan alur workshop)

- **Mac**: jalankan installer workshop (`install-tantular-workshop.command`) — manifest disalin ke folder `wef`.
- **Windows**: `install-tantular-workshop.bat` (registrasi otomatis) atau fallback Word di web → *Upload My Add-in*.
- Tutup penuh aplikasi Office, buka kembali, lalu **Home → Tantular → Open Tantular**.

## 3. Checklist verifikasi fungsional

Jalankan berurutan; catat hasil per mesin. Kolom "API minimum" menunjukkan requirement set yang dipakai fitur itu dan fallback bawaan Tantular bila tidak tersedia.

| # | Uji | API minimum | Perilaku bila API absen (fallback bawaan) |
|---|---|---|---|
| 1 | Pane terbuka, tag build (mis. `b0806h`+) terlihat di header | Office.js dasar | Pane blank → lihat §4 (webview) |
| 2 | Pengaturan model → **Tes model terpilih** | — (HTTP ke Companion) | Gagal = masalah Companion/sertifikat, bukan Office |
| 3 | Chat Word: tanya + jawab | WordApi 1.1 | — |
| 4 | Sisipkan jawaban (tombol "Sisipkan setelah teks yang saya pilih") | WordApi 1.1 (`insertHtml`) | Otomatis turun ke teks polos per-paragraf |
| 5 | Jawaban bergaya heading/list masuk dengan format | WordApi 1.3 (`styleBuiltIn`) → dicoba dulu via `insertHtml` 1.1 | Bold/ukuran font langsung + penanda "• " (pesan "tanpa gaya…") |
| 6 | Jawaban bertabel markdown → tabel Word asli | WordApi 1.1 (`insertHtml`) | Baris teks `\| … \|` polos |
| 7 | "Perbarui sub-section ini" (tracked changes) | WordApi 1.4 | Jalur edit polos tanpa track changes (sudah feature-gated) |
| 8 | Document Studio → "Buat di Word" | `insertFileFromBase64` | Pesan error jelas + gunakan "Download .docx" |
| 9 | PowerPoint: Deck Studio → "Buat Deck (sisip ke presentasi)" | PowerPointApi 1.2 (`insertSlidesFromBase64`) | Otomatis mengunduh file .pptx |
| 10 | Excel: Sheet Studio → buat workbook | ExcelApi ~1.4 (`getUsedRangeOrNullObject`, `freezePanes`) | Verifikasi manual; bila error, catat pesan |

Kelulusan minimum untuk workshop: #1–#4 wajib; #5–#10 boleh memakai fallback (catat mana yang fallback).

## 4. Risiko khusus Office 2019 Windows (webview lama)

Add-in Office di Windows memakai webview yang berbeda-beda: Office 2021/2024 & M365 memakai **Edge WebView2** (modern); **Office 2019/2016 perpetual memakai Internet Explorer 11** sebagai webview. Pane Tantular memakai JavaScript ES modules yang **tidak didukung IE11** — gejala: pane terbuka tapi **blank/putih** tanpa pesan error.

- Diagnosa cepat: jika #1 gagal (blank) di Office 2019 Windows sedangkan mesin lain normal → penyebabnya webview IE11, bukan instalasi.
- Solusi jangka pendek: gunakan **Word di web** di mesin itu (browser modern, Companion tetap lokal), atau tingkatkan Office.
- Solusi jangka panjang (belum dikerjakan): build bundel legacy (transpile + non-module) khusus IE11 — effort signifikan; putuskan hanya jika audiens 2019-Windows nyata.
- Office 2019 **Mac** memakai WKWebView (Safari) yang mendukung ES modules — kemungkinan besar berfungsi; tetap jalankan checklist penuh.

## 5. Pencatatan hasil

Per mesin, catat: versi Office + build, OS, hasil #1–#10 (OK / fallback / gagal + pesan), tag build pane, dan model yang dipakai (8B / 4B / lite). Simpan di lembar verifikasi workshop. Temuan gagal yang tidak tercakup dokumen ini → laporkan dengan screenshot pesan status (pesan Tantular memuat tag build + diagnosa).
