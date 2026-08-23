@echo off
cd /d "%~dp0"
rem Sertifikat HTTPS dev kedaluwarsa tiap ~30 hari dan membuat Office memblokir
rem panel. Periksa dulu; perbarui otomatis bila tidak valid.
call npx office-addin-dev-certs verify >nul 2>nul
if errorlevel 1 (
  echo Sertifikat HTTPS tidak valid atau kedaluwarsa. Memperbarui...
  call npm run cert:office
)
echo Menjalankan Tantular Companion di https://localhost:3000
echo Biarkan jendela ini tetap terbuka selama workshop.
set TANTULAR_ALLOWED_ORIGINS=https://office.tantular.ai
call npm start
pause
