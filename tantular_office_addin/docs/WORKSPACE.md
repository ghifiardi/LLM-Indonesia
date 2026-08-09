# Workspace: kirim konten & instruksi antar Word, Excel, dan PowerPoint

## Apa itu Workspace?

Workspace adalah fitur "Companion-hub" pada add-in Tantular: sebuah kotak antar-jemput
lokal dan privat yang berjalan di komputer Anda sendiri (lewat proses **Companion**
lokal), yang memungkinkan Anda mengirim teks/seleksi dari satu aplikasi Office (Word,
Excel, atau PowerPoint) dan mengambilnya kembali di aplikasi lain — tanpa copy-paste
manual, tanpa cloud, dan tanpa server pihak ketiga. Semua data disimpan sementara di
komputer Anda selama Companion berjalan.

Karena semuanya lokal, Workspace hanya berfungsi selagi proses Companion aktif di
komputer yang sama dengan Office yang Anda pakai. Jika Companion mati atau paketnya
belum diperbarui, fitur kirim/terima akan menonaktifkan diri dengan aman (lihat bagian
"Saat Companion tidak aktif" di bawah) — tidak pernah menampilkan dialog error yang
mengagetkan.

## Alur kirim & terima

1. Di kartu **"Teks / seleksi"** pada aplikasi mana pun (Word, Excel, atau
   PowerPoint), isi kotak teks (mis. dengan tombol **Ambil seleksi**), lalu klik
   **"Kirim ke aplikasi lain"**.
2. Konten tersebut langsung tersedia untuk dua aplikasi Office lainnya, dalam dua
   tempat:
   - **Banner masuk** — muncul otomatis di bagian atas kartu "Teks / seleksi" pada
     aplikasi penerima dalam ≤5 detik, dengan teks seperti
     `Konten masuk dari Word: "Bab 2" · 42 kata`.
   - **Inbox** — daftar lipat berjudul **"Ambil dari aplikasi lain (10 kiriman
     terakhir)"**, tepat di bawah kotak teks, berisi semua kiriman yang masih
     tersimpan (lihat batas 10 kiriman di bawah).
3. Setiap kiriman punya tombol "pakai" yang kata-katanya disesuaikan dengan
   aplikasi tujuan, karena tindakan "memakai" konten berarti hal yang berbeda di
   tiap aplikasi:
   - **PowerPoint** → tombol **"Pakai sebagai brief Deck Studio"**
   - **Excel** → tombol **"Pakai sebagai brief Sheet Studio"**
   - **Word** → tombol **"Tempel ke Teks/seleksi"**

Sebuah kiriman hanya muncul sebagai banner di aplikasi yang **bukan** pengirimnya —
lihat "Kirim dari aplikasi yang sama" di bagian aturan siklus hidup.

## Aturan siklus hidup kiriman (verbatim dari spesifikasi)

- **Abaikan** = sembunyikan banner di aplikasi ini saja. Kiriman itu tetap ada untuk
  aplikasi lain dan tetap muncul di inbox aplikasi ini (hanya banner-nya yang
  hilang).
- **Pakai** (mis. "Pakai sebagai brief Deck Studio" / "Pakai sebagai brief Sheet
  Studio" / "Tempel ke Teks/seleksi") = isi kotak teks + tanda ✓ pada baris inbox,
  **TIDAK menghapus** kiriman itu. Kiriman tetap tersedia untuk aplikasi lain dan
  tetap ada di inbox aplikasi ini.
- **Hapus** = hapus kiriman itu **untuk semua aplikasi** (dihapus dari server
  Companion, jadi hilang dari banner/inbox di Word, Excel, dan PowerPoint sekaligus).
- **Hanya 10 kiriman terakhir disimpan** — begitu kiriman ke-11 masuk, kiriman yang
  paling lama otomatis terhapus (FIFO). Judul inbox mencantumkan batas ini secara
  eksplisit: "Ambil dari aplikasi lain (10 kiriman terakhir)".

## Penggantian isi kotak selalu dengan konfirmasi

Jika kotak "Teks / seleksi" di aplikasi tujuan **sudah berisi teks** saat Anda klik
tombol "Pakai ...", Workspace tidak langsung menimpanya. Tombol berganti menjadi
strip konfirmasi:

> Kotak tujuan sudah berisi teks — ganti?
> **[Ganti]** **[Batal]**

- **Ganti** → kotak diisi ulang (REPLACE) dengan konten kiriman, dan tanda ✓
  muncul.
- **Batal** → kembali ke tombol "Pakai ..." semula; kotak tidak berubah.

Jika kotak tujuan kosong, konten langsung mengisi kotak tanpa perlu konfirmasi.

## Instruksi bersama (project instructions)

Selain mengirim potongan teks, Workspace juga menyinkronkan **instruksi
project/output** (style guide, format output, preferensi chart, dll.) lintas
ketiga aplikasi lewat Companion yang sama:

- Instruksi disimpan **sekali** — lewat kotak "Project / output instructions" pada
  kartu Deck Studio (PowerPoint) dan tombol **"Simpan instruksi"** — lalu **aktif di
  ketiga aplikasi** (Word, Excel, PowerPoint) karena disimpan di Companion bersama,
  bukan hanya di satu aplikasi.
- Saat aplikasi lain mengambil versi terbaru dari Companion, mereka menampilkan
  catatan provenance: **"Instruksi bersama · diperbarui dari …"** (mis. "Instruksi
  bersama · diperbarui dari Word"), sehingga Anda selalu tahu instruksi mana yang
  sedang aktif dan dari aplikasi mana asalnya.
- **Fallback lokal saat Companion mati**: jika Companion tidak terjangkau saat
  menyimpan, instruksi tetap tersimpan secara lokal (localStorage) di aplikasi itu
  dan status berubah menjadi **"tersimpan lokal; Companion tidak terjangkau"** —
  tidak ada data yang hilang, hanya belum tersebar ke aplikasi lain sampai Companion
  kembali aktif.

## Saat Companion tidak aktif

Jika Companion berhenti berjalan (atau paket Companion di komputer Anda belum
diperbarui ke versi yang mendukung Workspace), tombol **"Kirim ke aplikasi lain"**
otomatis dinonaktifkan (disabled) dan menampilkan hint kecil di bawahnya:

- **"Workspace tidak terjangkau."** — saat Companion tidak bisa dihubungi sama
  sekali.
- **"Perbarui paket Companion"** — saat Companion merespons tapi belum punya API
  Workspace (respons 404), artinya paket Companion di komputer itu perlu
  diperbarui/diunduh ulang.

Tidak ada dialog error yang muncul dalam kondisi ini — pane hanya menonaktifkan
tombol kirim dan menunjukkan hint di atas. Begitu Companion berjalan lagi (atau
paketnya diperbarui), tombol otomatis aktif kembali dan seluruh isi inbox yang
tersimpan di server Companion tetap utuh (Workspace menyimpan datanya secara
persisten di berkas lokal Companion, bukan hanya di memori).

## Checklist penerimaan manual (manual acceptance checklist)

Jalankan langkah-langkah berikut secara berurutan di Word, Excel, dan PowerPoint
pada komputer yang sama (Companion lokal harus aktif kecuali disebutkan lain).
Catat hasilnya pada baris "Hasil:" di bawah tiap langkah.

1. **Word: pilih teks lalu klik "Kirim ke aplikasi lain".**
   Hasil: ___

2. **PowerPoint: banner muncul dalam ≤5 detik; tombol "Pakai sebagai brief Deck
   Studio" mengisi kotak (muncul prompt konfirmasi bila kotak sudah berisi teks).**
   Hasil: ___

3. **PowerPoint: kirim teks outline (mis. hasil dari langkah 2) lewat "Kirim ke
   aplikasi lain".**
   Hasil: ___

4. **Excel: banner muncul; tombol "Pakai sebagai brief Sheet Studio" mengisi
   kotak.**
   Hasil: ___

5. **Same-host: kirim dari Word sendiri — Word TIDAK menampilkan banner untuk
   kiriman itu, tapi kiriman tetap tercantum di inbox Word.**
   Hasil: ___

6. **Matikan proses Companion: tombol kirim menjadi nonaktif dengan hint (bukan
   dialog error). Nyalakan kembali Companion: inbox tetap utuh (tidak ada kiriman
   yang hilang).**
   Hasil: ___

7. **Simpan instruksi bersama di Word (atau aplikasi tempat kotak instruksi
   tersedia) — dalam ≤5 detik, pane Excel dan PowerPoint menampilkan catatan
   "Instruksi bersama · diperbarui dari …".**
   Hasil: ___

> Catatan implementasi: pada versi ini, kotak "Project / output instructions" dan
> tombol "Simpan instruksi" berada di kartu Deck Studio yang hanya tampil di pane
> PowerPoint; sinkronisasi latar belakang (menerima & mengadopsi instruksi dari
> Companion) tetap berjalan di ketiga host. Saat menjalankan langkah 7, catat dari
> aplikasi mana instruksi sebenarnya disimpan.
