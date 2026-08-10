WORKSHOP TANTULAR OFFICE (MAC & WINDOWS)

CARA PALING MUDAH — satu perintah (unduh + pasang semuanya otomatis):
- Mac (Terminal):      curl -fsSL https://workshop-web-gamma.vercel.app/downloads/setup.sh | bash
- Windows (PowerShell): irm https://workshop-web-gamma.vercel.app/downloads/setup.ps1 | iex

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

Unggah dokumen + OCR Apple Vision (Mac) perlu sekali `npm run doc-setup`, lalu jalankan `npm run doc-server` berdampingan dengan companion.

Task pane yang dihosting:
https://workshop-web-gamma.vercel.app

Privasi:
https://workshop-web-gamma.vercel.app/privacy.html

Dukungan:
https://workshop-web-gamma.vercel.app/support.html
