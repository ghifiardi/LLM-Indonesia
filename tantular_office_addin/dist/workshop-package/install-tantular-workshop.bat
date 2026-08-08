@echo off
setlocal
cd /d "%~dp0"

echo Instalasi Workshop Tantular Office (Windows)
echo ============================================

call :ensure_tool node "Node.js LTS" OpenJS.NodeJS.LTS https://nodejs.org || exit /b 1
call :ensure_tool ollama "Ollama" Ollama.Ollama https://ollama.com/download || exit /b 1
where npm >nul 2>nul || (echo npm belum tersedia. Tutup jendela ini dan jalankan installer lagi. & pause & exit /b 1)

echo Memasang sertifikat localhost tepercaya untuk Office...
call npm run cert:office

echo Menyiapkan model Tantular Office (unduhan bisa beberapa GB)...
powershell -ExecutionPolicy Bypass -File tools\install-office-model.ps1
if errorlevel 1 (echo Penyiapan model gagal. Periksa Ollama lalu jalankan lagi. & pause & exit /b 1)

echo Mendaftarkan manifest workshop ke Office...
call npx --yes office-addin-dev-settings sideload "%cd%\tantular-workshop-manifest.xml" desktop
if errorlevel 1 (
  echo.
  echo Sideload otomatis gagal. Alternatif manual:
  echo   Buka Word di web ^(office.com^), Insert - Add-ins - Upload My Add-in,
  echo   lalu pilih file tantular-workshop-manifest.xml di folder ini.
)

echo.
echo Instalasi selesai.
echo 1. Tutup penuh Word, Excel, dan PowerPoint.
echo 2. Jalankan start-tantular-companion.bat dan biarkan jendelanya tetap terbuka.
echo 3. Buka kembali Office - Home - Tantular - Open Tantular.
pause
goto :eof

:ensure_tool
where %1 >nul 2>nul && exit /b 0
echo.
echo %~2 belum terpasang.
where winget >nul 2>nul
if errorlevel 1 (
  echo Unduh dari %4 , pasang, lalu jalankan installer ini lagi.
  pause
  exit /b 1
)
set /p JAWAB=Pasang %~2 otomatis lewat winget? [Y/n]
if /i "%JAWAB%"=="n" (
  echo Unduh dari %4 , pasang, lalu jalankan installer ini lagi.
  pause
  exit /b 1
)
winget install --id %3 -e --accept-package-agreements --accept-source-agreements
echo.
echo %~2 selesai dipasang. TUTUP jendela ini, lalu jalankan
echo install-tantular-workshop.bat SEKALI LAGI agar PATH baru terbaca.
pause
exit /b 1
