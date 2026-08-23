WORKSHOP TANTULAR OFFICE (MAC & WINDOWS)
Versi paket: 2026-08-23.5fbd6ac   (dibangun 2026-08-23 16:29 UTC)
Sebutkan versi ini bila melaporkan masalah — dua unduhan bisa punya nama sama
tetapi isi berbeda.

CARA PALING MUDAH — satu perintah (unduh + pasang semuanya otomatis):
- Mac (Terminal):      curl -fsSL https://office.tantular.ai/downloads/setup.sh | bash
- Windows (PowerShell): irm https://office.tantular.ai/downloads/setup.ps1 | iex

Prasyarat Node.js 18+ dan Ollama dipasang OTOMATIS oleh installer bila belum ada
(Mac: Homebrew/installer resmi; Windows: winget). Unduhan manual bila perlu:
- Node.js: https://nodejs.org
- Ollama: https://ollama.com/download

=== MAC ===
1. Klik dua kali install-tantular-workshop.command.
   Jika diblokir macOS, klik kanan → Open.
2. Installer menyiapkan model lokal dan menyalin manifest Microsoft 365.
3. Tutup Word, Excel, dan PowerPoint dengan Cmd+Q.
4. Klik dua kali start-tantular-companion.command dan biarkan terminalnya terbuka.
5. Buka kembali Office lalu pilih Home → Tantular → Open Tantular.

=== WINDOWS ===
1. Klik dua kali install-tantular-workshop.bat.
   Jika SmartScreen muncul, pilih More info → Run anyway.
   Jika Node.js/Ollama belum ada, installer menawarkan pemasangan otomatis
   lewat winget — setelah itu tutup jendela dan jalankan installer sekali lagi.
2. Installer menyiapkan model lokal dan mendaftarkan manifest ke Office.
   Jika pendaftaran otomatis gagal, gunakan Word di web (office.com):
   Insert → Add-ins → Upload My Add-in → pilih tantular-workshop-manifest.xml.
3. Tutup penuh Word, Excel, dan PowerPoint.
4. Klik dua kali start-tantular-companion.bat dan biarkan jendelanya terbuka.
5. Buka kembali Office lalu pilih Home → Tantular → Open Tantular.

OPSIONAL — PDF & OCR gambar:
Tidak diperlukan untuk memakai Tantular. Jalankan `npm run doc-setup` HANYA bila
perlu mengunggah PDF atau gambar (perlu Python 3). Setelah itu companion
menjalankannya sendiri — tidak perlu perintah terpisah.
Periksa kondisi kapan saja dengan `npm run doctor`.

Task pane yang dihosting:
https://office.tantular.ai

Privasi:
https://office.tantular.ai/privacy.html

Dukungan:
https://office.tantular.ai/support.html
