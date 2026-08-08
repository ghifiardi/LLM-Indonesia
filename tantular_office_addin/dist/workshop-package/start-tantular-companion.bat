@echo off
cd /d "%~dp0"
echo Menjalankan Tantular Companion di https://localhost:3000
echo Biarkan jendela ini tetap terbuka selama workshop.
set TANTULAR_ALLOWED_ORIGINS=https://workshop-web-gamma.vercel.app
call npm run dev
pause
