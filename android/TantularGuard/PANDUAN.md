# Panduan Tantular Guard — untuk Penguji

Terima kasih sudah mau mencoba **Tantular Guard** 🛡️ — aplikasi pengecek pesan
penipuan (SMS/WhatsApp) yang bekerja **sepenuhnya di HP Anda**. Pesan tidak
pernah dikirim ke internet.

> File: `TantularGuard.apk` (±1 MB) · Android 8.0 ke atas · versi uji coba
> (belum dari Play Store)

---

## 1. Cara memasang (install)

1. Terima file `TantularGuard.apk` (via WhatsApp/email/Drive) dan **ketuk
   filenya**.
2. Android akan bilang *"Demi keamanan, ponsel Anda tidak diizinkan memasang
   aplikasi tidak dikenal dari sumber ini"* → ketuk **Setelan / Settings** →
   nyalakan **Izinkan dari sumber ini** → kembali.
3. Ketuk **Instal / Install**.
4. Jika muncul peringatan **Play Protect** ("aplikasi dari developer tidak
   dikenal") → pilih **Instal saja / Install anyway**. Ini normal untuk versi
   uji coba yang belum masuk Play Store.

Selesai — buka aplikasinya. Panduan 5 langkah akan muncul otomatis saat
pertama kali dibuka. Akhiri dengan tombol hijau **🚀 Coba dengan contoh
penipuan** untuk melihat cara kerjanya.

## 2. Cara pakai inti (tanpa izin apa pun)

- **Salin** pesan yang mencurigakan → buka Tantular → ketuk **📋 Tempel &
  Periksa**.
- Atau dari WhatsApp: **tekan lama** pesan → **Bagikan** → pilih **Tantular
  Guard**.
- Hasilnya: 🛑 **BAHAYA** / ⚠️ **HATI-HATI** / ✅ **AMAN**, lengkap dengan tanda
  bahaya yang ditemukan (mis. "Meminta kode OTP").
- Belum punya pesan? Ketuk salah satu tombol **Contoh** di halaman utama.

Mode ini tidak butuh izin apa pun dan tidak menyentuh jaringan.

## 3. Mengaktifkan perlindungan otomatis (opsional)

Aplikasi akan selalu **menjelaskan dulu** sebelum meminta izin. Yang perlu
Anda setujui:

### 📩 Pemeriksaan SMS masuk
1. Di halaman utama, nyalakan **Aktifkan pemeriksaan SMS masuk**.
2. Baca dialog penjelasan → **Lanjut**.
3. Android menanyakan izin **SMS** → **Izinkan**. (Android 13+: juga izin
   **Notifikasi** → **Izinkan**, agar peringatan bisa muncul.)

### 💬 Periksa notifikasi WhatsApp & medsos
1. Nyalakan **Periksa notifikasi WhatsApp & medsos**.
2. Baca dialog → **Buka pengaturan**.
3. Di layar *Akses notifikasi*, **aktifkan Tantular Guard** → konfirmasi
   **Izinkan**.

> Tantular hanya membaca teks notifikasi yang tampil dari aplikasi yang
> dipantau — bukan seluruh isi chat.

### 🧪 Karantina SMS (eksperimental — boleh dilewati)
Memisahkan SMS penipuan dari kotak masuk. Perlu menjadikan Tantular sebagai
**aplikasi SMS utama** (tombolnya di *Pengaturan lanjutan*). Untuk kembali:
**Setelan → Aplikasi → Aplikasi default → Aplikasi SMS** → pilih aplikasi SMS
lama Anda. Di beberapa HP Samsung, dialognya tidak muncul — aplikasi akan
membuka layar *Aplikasi default* dan Anda memilih **Tantular Guard** manual di
**Aplikasi SMS**.

## 4. Agar berjalan normal di latar belakang

Beberapa merek HP (Samsung/Xiaomi/Oppo/Huawei) "menidurkan" aplikasi sehingga
peringatan tidak muncul. Bila peringatan SMS/notifikasi tidak keluar:

- **Samsung:** Setelan → Pemeliharaan perangkat → Baterai → *Background usage
  limits* → pastikan Tantular Guard **tidak** ada di "Sleeping apps" / "Deep
  sleeping apps".
- **Xiaomi:** Setelan → Aplikasi → Kelola aplikasi → Tantular Guard →
  *Hemat baterai* → **Tanpa batasan**; aktifkan juga *Autostart*.
- **Umum:** jangan **Force stop**; pastikan notifikasi Tantular tidak
  disenyapkan (Setelan → Notifikasi).

## 5. Privasi — apa yang TIDAK dilakukan aplikasi ini

- ❌ Tidak mengirim pesan/data Anda ke internet (tidak ada server).
- ❌ Tidak membaca chat WhatsApp — hanya teks yang Anda tempel/bagikan, atau
  teks notifikasi bila fitur itu Anda nyalakan sendiri.
- ❌ Tidak menghapus/mengubah SMS Anda (kecuali karantina yang Anda aktifkan).
- ✅ Semua riwayat tersimpan hanya di HP dan bisa dihapus kapan saja.

## 6. Masalah umum

| Gejala | Solusi |
|---|---|
| "Aplikasi tidak terpasang" saat install | Izinkan *sumber tidak dikenal* untuk aplikasi tempat Anda membuka APK (WhatsApp/File Manager), lalu coba lagi |
| Play Protect memblokir | Pilih **Instal saja**; ini build uji coba tanpa tanda tangan Play Store |
| Tombol share dari WhatsApp tidak menampilkan Tantular | Tutup & buka ulang WhatsApp, atau restart HP sekali |
| Peringatan tidak muncul | Cek izin Notifikasi + keluarkan dari "Sleeping apps" (bagian 4) |
| Ingin lepas dari SMS utama | Setelan → Aplikasi default → Aplikasi SMS → pilih aplikasi lama |

## 7. Yang kami ingin Anda coba (checklist penguji)

1. ✅ Selesaikan panduan 5 langkah + **Coba dengan contoh penipuan**.
2. ✅ Tempel pesan penipuan sungguhan yang pernah Anda terima → cek hasilnya.
3. ✅ Bagikan pesan dari WhatsApp ke Tantular.
4. ✅ Naikkan skor **🏆 Misi Keamanan** sampai 100.
5. ✅ Ketuk ikon **ℹ️** di tiap bagian — apakah penjelasannya masuk akal?
6. 💬 Catat: di mana Anda bingung? Kirim masukan ke pemilik proyek.

---
*Tantular Guard v0.2 (uji coba) · pemeriksaan 100% di perangkat · dibangun
dengan model SLM Tantular*
