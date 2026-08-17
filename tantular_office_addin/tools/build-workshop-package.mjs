import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const baseUrl = valueFor("--base-url").replace(/\/+$/, "");
const out = path.join(root, "dist", "workshop-package");
const webDownloads = path.join(root, "dist", "workshop-web", "downloads");

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, "tools"), { recursive: true });
fs.mkdirSync(path.join(out, "models"), { recursive: true });

execFileSync(process.execPath, [
  path.join(root, "tools", "build-production-manifest.mjs"),
  "--base-url", baseUrl,
  "--out", path.join(out, "tantular-workshop-manifest.xml")
], { stdio: "inherit" });

copy("tools/dev-server.mjs");
copy("tools/doctor.mjs");
copy("tools/doc-setup.mjs");
copy("tools/start.mjs");
// dev-server.mjs imports ./workspace.mjs. Shipping one without the other makes
// the packaged dev server die at startup with ERR_MODULE_NOT_FOUND — and since
// companionUrl() points a published task pane at https://localhost:3000, that
// dev server is the attendee's only bridge to the local companion, so the model
// stops answering entirely.
copy("tools/workspace.mjs");
copy("tools/install-office-model.sh");
copy("tools/document-extractor.py");
copy("models/Modelfile.office-9b");
copy("docs/OFFICE_PERPETUAL_COMPAT.md");

fs.writeFileSync(path.join(out, "package.json"), JSON.stringify({
  name: "tantular-workshop-companion",
  version: "1.0.0",
  private: true,
  type: "module",
  scripts: {
    start: "node tools/start.mjs",
    dev: "node tools/dev-server.mjs",
    doctor: "node tools/doctor.mjs",
    "cert:office": "npx office-addin-dev-certs install",
    "cert:office:verify": "npx office-addin-dev-certs verify",
    "model:office": "./tools/install-office-model.sh",
    "doc-server": "./.venv-doc/bin/python tools/document-extractor.py",
    "doc-setup": "node tools/doc-setup.mjs"
  }
}, null, 2));

fs.writeFileSync(path.join(out, "install-tantular-workshop.command"), installerScript());
fs.writeFileSync(path.join(out, "start-tantular-companion.command"), launcherScript());
fs.writeFileSync(path.join(out, "install-tantular-workshop.bat"), windowsInstallerScript());
fs.writeFileSync(path.join(out, "start-tantular-companion.bat"), windowsLauncherScript());
fs.writeFileSync(path.join(out, "tools", "install-office-model.ps1"), windowsModelScript());
// Build record. The question this answers is "which artifact are you actually
// running?", which was unanswerable when two zips with the same name and
// different contents were in circulation during a workshop.
//
// git runs HERE, at build time in the repo. The attendee zip must never need
// it — a packaged machine has no repo and often no git at all.
function buildRecord() {
  const git = (args, fallback) => {
    try {
      return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
    } catch {
      return fallback;
    }
  };
  const sha = git(["rev-parse", "HEAD"], "unknown");
  // A build from uncommitted changes is NOT that commit, and labelling it so
  // would make the id lie in exactly the situation where it matters most.
  const dirty = git(["status", "--porcelain"], "") !== "";
  const builtAt = new Date().toISOString();
  const shortSha = sha === "unknown" ? "nogit" : sha.slice(0, 7);
  return {
    buildId: `${builtAt.slice(0, 10)}.${shortSha}${dirty ? "+dirty" : ""}`,
    sourceSha: sha,
    sourceDirty: dirty,
    builtAt,
    packageFormat: 1,
    baseUrl,
  };
}
const build = buildRecord();
fs.writeFileSync(path.join(out, "workshop-build.json"),
                 JSON.stringify(build, null, 2) + "\n");

fs.writeFileSync(path.join(out, "README-WORKSHOP.txt"), readmeText(build));
fs.chmodSync(path.join(out, "install-tantular-workshop.command"), 0o755);
fs.chmodSync(path.join(out, "start-tantular-companion.command"), 0o755);
fs.chmodSync(path.join(out, "tools", "install-office-model.sh"), 0o755);

fs.mkdirSync(webDownloads, { recursive: true });
fs.copyFileSync(
  path.join(out, "tantular-workshop-manifest.xml"),
  path.join(webDownloads, "tantular-workshop-manifest.xml")
);

// Verify the package can actually start BEFORE zipping it.
//
// The copy list above is hand-maintained, and shipping a module without its
// imports has already broken a workshop once: dev-server.mjs imports
// ./workspace.mjs, that copy line was missing, and the packaged companion died
// at startup with ERR_MODULE_NOT_FOUND (fixed in a916adb). Attendees who
// downloaded before the fix and after it followed identical instructions and
// got different results, which is exactly what "some worked, some didn't"
// looks like from the room.
//
// A comment cannot prevent the next one. These checks can: the build now fails
// rather than shipping a package that cannot run.
function verifyPackage(dir) {
  const problems = [];

  // 1. Every relative import of every shipped .mjs must also be shipped.
  const mjs = fs.readdirSync(path.join(dir, "tools")).filter((f) => f.endsWith(".mjs"));
  for (const file of mjs) {
    const source = fs.readFileSync(path.join(dir, "tools", file), "utf8");
    const imports = [...source.matchAll(/(?:from|import\()\s*"(\.\/[^"]+)"/g)]
      .map((m) => m[1].replace(/^\.\//, ""));
    for (const dep of new Set(imports)) {
      if (!fs.existsSync(path.join(dir, "tools", dep))) {
        problems.push(`tools/${file} imports ./${dep}, which is NOT in the package`);
      }
    }
  }

  // 2. Every `npm run X` the launchers and installer invoke must exist as a
  //    script. A missing one fails with npm's "Missing script", mid-install.
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  const scripts = new Set(Object.keys(pkg.scripts || {}));
  for (const entry of fs.readdirSync(dir)) {
    if (!/\.(command|bat)$/.test(entry)) continue;
    const text = fs.readFileSync(path.join(dir, entry), "utf8");
    for (const [, name] of text.matchAll(/npm run ([a-zA-Z0-9:_-]+)/g)) {
      if (!scripts.has(name)) problems.push(`${entry} calls \`npm run ${name}\`, not defined`);
    }
    if (/npm start/.test(text) && !scripts.has("start")) {
      problems.push(`${entry} calls \`npm start\`, but no "start" script is defined`);
    }
  }

  // 3. Scripts must point at files that exist.
  for (const [name, command] of Object.entries(pkg.scripts || {})) {
    const match = String(command).match(/(?:node|python3?|\.\/)\s*([\w./-]+\.(?:mjs|py|sh))/);
    if (match && !fs.existsSync(path.join(dir, match[1]))) {
      problems.push(`script "${name}" runs ${match[1]}, which is NOT in the package`);
    }
  }

  if (problems.length) {
    console.error("\nPAKET TIDAK LENGKAP — build dihentikan sebelum membuat ZIP:\n");
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error("\nTambahkan copy() yang hilang di tools/build-workshop-package.mjs.\n");
    process.exit(1);
  }
  console.log(`Verifikasi paket OK: ${mjs.length} modul, impor lengkap, skrip cocok.`);
}
verifyPackage(out);

const zipPath = path.join(webDownloads, "tantular-workshop.zip");
try { fs.rmSync(zipPath); } catch {}
execFileSync("zip", ["-qr", zipPath, "."], { cwd: out });
// Legacy filename: earlier support pages linked the Mac-named zip.
fs.copyFileSync(zipPath, path.join(webDownloads, "tantular-workshop-mac.zip"));

// One-command bootstrap: participants paste a single line in Terminal /
// PowerShell; it downloads the package, extracts it, and runs the installer
// (which in turn auto-installs Node.js and Ollama when missing).
fs.writeFileSync(path.join(webDownloads, "setup.sh"), `#!/bin/bash
set -euo pipefail
DEST="$HOME/TantularWorkshop"
echo "Mengunduh paket workshop Tantular ke $DEST ..."
mkdir -p "$DEST"
curl -fsSL "${baseUrl}/downloads/tantular-workshop.zip" -o "$DEST/tantular-workshop.zip"
cd "$DEST"
unzip -oq tantular-workshop.zip
# Reattach the terminal: under "curl | bash" stdin is the pipe, and the
# installer has interactive prompts (sudo, pertanyaan tenant, Enter penutup).
bash install-tantular-workshop.command < /dev/tty
`);
fs.writeFileSync(path.join(webDownloads, "setup.ps1"), `$ErrorActionPreference = "Stop"
$Dest = Join-Path $env:USERPROFILE "TantularWorkshop"
Write-Host "Mengunduh paket workshop Tantular ke $Dest ..."
New-Item -ItemType Directory -Force -Path $Dest | Out-Null
Invoke-WebRequest -Uri "${baseUrl}/downloads/tantular-workshop.zip" -OutFile (Join-Path $Dest "tantular-workshop.zip")
Expand-Archive -Force (Join-Path $Dest "tantular-workshop.zip") $Dest
Set-Location $Dest
cmd /c install-tantular-workshop.bat
`);

console.log(`Workshop package: ${out}`);
console.log(`Download ZIP: ${zipPath}`);

function copy(relative) {
  const target = path.join(out, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(root, relative), target);
}

function installerScript() {
  return `#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"

echo "Instalasi Workshop Tantular Office"
echo "=================================="

find_ollama() {
  command -v ollama >/dev/null 2>&1 && return 0
  for candidate in /usr/local/bin/ollama /opt/homebrew/bin/ollama "/Applications/Ollama.app/Contents/Resources/ollama"; do
    [ -x "$candidate" ] && return 0
  done
  return 1
}

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js belum terpasang."
  if command -v brew >/dev/null 2>&1; then
    echo "Memasang Node.js lewat Homebrew..."
    brew install node
  else
    echo "Mengunduh installer resmi Node.js (butuh password admin Mac ini)..."
    curl -fsSL "https://nodejs.org/dist/v22.17.0/node-v22.17.0.pkg" -o /tmp/node-lts.pkg
    sudo installer -pkg /tmp/node-lts.pkg -target /
    export PATH="/usr/local/bin:$PATH"
  fi
fi
command -v node >/dev/null 2>&1 || { echo "Node.js masih belum terdeteksi. Pasang manual dari https://nodejs.org lalu jalankan installer ini lagi."; exit 1; }

if ! find_ollama; then
  echo "Ollama belum terpasang. Mengunduh aplikasi Ollama..."
  curl -fsSL "https://ollama.com/download/Ollama-darwin.zip" -o /tmp/Ollama.zip
  ditto -xk /tmp/Ollama.zip /Applications
  open -a Ollama || true
  echo "Aplikasi Ollama dibuka. Jika muncul dialog, izinkan pemasangan command line tool."
  sleep 5
fi
find_ollama || { echo "Ollama masih belum terdeteksi. Pasang manual dari https://ollama.com/download lalu jalankan installer ini lagi."; exit 1; }

echo "Memasang sertifikat localhost tepercaya untuk Office..."
npm run cert:office

echo "Menyiapkan model Tantular Office (unduhan bisa beberapa GB)..."
npm run model:office

MANIFEST="$PWD/tantular-workshop-manifest.xml"
read -r -p "Apakah admin Microsoft 365 Anda sudah memasang Tantular ke akun Anda? [y/N] " TENANT_DEPLOYED
if [[ "$TENANT_DEPLOYED" =~ ^[Yy]$ ]]; then
  echo "Melewati penyalinan manifest lokal; tombol Tantular akan muncul lewat deployment tenant."
else
  for app in Word Excel Powerpoint; do
    DIR="$HOME/Library/Containers/com.microsoft.$app/Data/Documents/wef"
    mkdir -p "$DIR"
    cp "$MANIFEST" "$DIR/tantular-workshop-manifest.xml"
  done
  echo "Manifest workshop lokal terpasang untuk Word, Excel, dan PowerPoint."
fi

echo
echo "Instalasi selesai."
echo "1. Tutup penuh Word, Excel, dan PowerPoint dengan Cmd+Q."
echo "2. Jalankan start-tantular-companion.command dan biarkan terminalnya tetap terbuka."
echo "3. Buka kembali Office → Home → Tantular → Open Tantular."
read -r -p "Tekan Enter untuk menutup..."
`;
}

function launcherScript() {
  return `#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
# Sertifikat HTTPS dev kedaluwarsa tiap ~30 hari dan membuat Office memblokir
# panel. Periksa dulu; perbarui otomatis bila tidak valid (mungkin diminta
# password Mac).
if ! npx office-addin-dev-certs verify >/dev/null 2>&1; then
  echo "Sertifikat HTTPS tidak valid atau kedaluwarsa. Memperbarui..."
  npm run cert:office
fi
echo "Menjalankan Tantular Companion di https://localhost:3000"
echo "Biarkan jendela ini tetap terbuka selama workshop."
TANTULAR_ALLOWED_ORIGINS="${baseUrl}" npm start
`;
}

function windowsInstallerScript() {
  return `@echo off
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
powershell -ExecutionPolicy Bypass -File tools\\install-office-model.ps1
if errorlevel 1 (echo Penyiapan model gagal. Periksa Ollama lalu jalankan lagi. & pause & exit /b 1)

echo Mendaftarkan manifest workshop ke Office...
call npx --yes office-addin-dev-settings sideload "%cd%\\tantular-workshop-manifest.xml" desktop
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
`;
}

function windowsLauncherScript() {
  return `@echo off
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
set TANTULAR_ALLOWED_ORIGINS=${baseUrl}
call npm start
pause
`;
}

function windowsModelScript() {
  // NOTE: no $ErrorActionPreference = "Stop" — under Stop, PowerShell turns a
  // native command's redirected stderr (e.g. ollama's "model not found" probe)
  // into a fatal NativeCommandError. Flow control uses $LASTEXITCODE instead.
  return `$ErrorActionPreference = "Continue"
$Root = Split-Path -Parent $PSScriptRoot
# Build from the official Ollama base by default so the package cannot silently
# retain an older published Tantular base. A registry profile is opt-in.
$RegistryModel = if ($env:TANTULAR_OFFICE_REGISTRY_MODEL) { $env:TANTULAR_OFFICE_REGISTRY_MODEL } else { "" }
$BaseModel = if ($env:TANTULAR_OFFICE_BASE_MODEL) { $env:TANTULAR_OFFICE_BASE_MODEL } else { "qwen3.5:9b" }
$ModelName = if ($env:TANTULAR_OFFICE_MODEL_NAME) { $env:TANTULAR_OFFICE_MODEL_NAME } else { "tantular-office:0.4-9b" }
$RegistryTag = "latest"

# Machines without enough RAM for a 9B model (~6.6GB weights) swap to disk and
# time out on every Studio call. Use the lighter 4B variant there instead.
$LiteMode = $false
$RamGB = [math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB)
if (-not $env:TANTULAR_OFFICE_BASE_MODEL -and $RamGB -gt 0 -and $RamGB -lt 12) {
  $LiteMode = $true
  $BaseModel = "qwen3.5:4b"
  $ModelName = "tantular-office:lite"
  $RegistryTag = "lite"
  Write-Host "RAM terdeteksi $RamGB GB (<12GB): memakai model ringan $ModelName."
}

if (-not (Get-Command ollama -ErrorAction SilentlyContinue)) {
  Write-Host "Ollama tidak ditemukan. Instal Ollama terlebih dahulu."
  exit 1
}

# Optional registry path: pull a prebuilt profile only when explicitly set.
if ($RegistryModel) {
  Write-Host "Mengunduh $RegistryModel\`:$RegistryTag dari ollama.com (bisa beberapa GB)..."
  ollama pull "$RegistryModel\`:$RegistryTag"
  if ($LASTEXITCODE -ne 0) {
    Write-Host "Gagal mengunduh $RegistryModel\`:$RegistryTag."
    exit 1
  }
  ollama cp "$RegistryModel\`:$RegistryTag" $ModelName
  if ($LASTEXITCODE -ne 0) {
    Write-Host "Gagal membuat alias $ModelName."
    exit 1
  }
} else {
  # Default path: pull the official Qwen3.5 base and apply the local profile.
  # Probe via cmd so a missing model can never throw, only set the exit code.
  cmd /c "ollama show $BaseModel >nul 2>nul"
  if ($LASTEXITCODE -ne 0) {
    Write-Host "Base model $BaseModel belum ada. Mengunduh (bisa beberapa GB)..."
    ollama pull $BaseModel
    if ($LASTEXITCODE -ne 0) {
      Write-Host "Gagal mengunduh $BaseModel. Periksa koneksi internet dan pastikan aplikasi Ollama berjalan."
      exit 1
    }
  }
  Write-Host "Membuat $ModelName dari $BaseModel..."
  $ModelfilePath = Join-Path $Root "models/Modelfile.office-9b"
  $TmpModelfile = Join-Path $env:TEMP "Modelfile.tantular-office"
  (Get-Content $ModelfilePath) -replace '^FROM .*', "FROM $BaseModel" | Set-Content $TmpModelfile
  ollama create $ModelName -f $TmpModelfile
  if ($LASTEXITCODE -ne 0) {
    Write-Host "Gagal membuat $ModelName."
    exit 1
  }
}
if ($LiteMode) {
  Write-Host "Selesai. PENTING: di Pengaturan model lokal, isi kolom 'Model Studio' dengan: $ModelName"
} else {
  Write-Host "Selesai. Gunakan Model deck: $ModelName"
}
exit 0
`;
}

function readmeText(build) {
  return `WORKSHOP TANTULAR OFFICE (MAC & WINDOWS)
Versi paket: ${build.buildId}   (dibangun ${build.builtAt.slice(0, 16).replace("T", " ")} UTC)
Sebutkan versi ini bila melaporkan masalah — dua unduhan bisa punya nama sama
tetapi isi berbeda.

CARA PALING MUDAH — satu perintah (unduh + pasang semuanya otomatis):
- Mac (Terminal):      curl -fsSL ${baseUrl}/downloads/setup.sh | bash
- Windows (PowerShell): irm ${baseUrl}/downloads/setup.ps1 | iex

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
Tidak diperlukan untuk memakai Tantular. Jalankan \`npm run doc-setup\` HANYA bila
perlu mengunggah PDF atau gambar (perlu Python 3). Setelah itu companion
menjalankannya sendiri — tidak perlu perintah terpisah.
Periksa kondisi kapan saja dengan \`npm run doctor\`.

Task pane yang dihosting:
${baseUrl}

Privasi:
${baseUrl}/privacy.html

Dukungan:
${baseUrl}/support.html
`;
}

function valueFor(flag) {
  const index = args.indexOf(flag);
  const value = index >= 0 ? args[index + 1] : "";
  if (!value) throw new Error(`Missing ${flag}`);
  return value;
}
