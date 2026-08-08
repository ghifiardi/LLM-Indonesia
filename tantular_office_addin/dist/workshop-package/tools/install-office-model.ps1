$ErrorActionPreference = "Continue"
$Root = Split-Path -Parent $PSScriptRoot
# The model is published on ollama.com, so the default path is a straight
# 'ollama pull' — no local Modelfile build, fewer failure modes on
# participant machines. The local build remains as an offline fallback.
$RegistryModel = if ($env:TANTULAR_OFFICE_REGISTRY_MODEL) { $env:TANTULAR_OFFICE_REGISTRY_MODEL } else { "ghifidanukusumo/tantular" }
$BaseModel = if ($env:TANTULAR_OFFICE_BASE_MODEL) { $env:TANTULAR_OFFICE_BASE_MODEL } else { "qwen3:8b" }
$ModelName = if ($env:TANTULAR_OFFICE_MODEL_NAME) { $env:TANTULAR_OFFICE_MODEL_NAME } else { "tantular-office:0.3-8b" }
$RegistryTag = "latest"

# Machines without enough RAM for an 8B model (~5GB weights) swap to disk and
# time out on every Studio call. Use the lighter 4B variant there instead.
$LiteMode = $false
$RamGB = [math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB)
if (-not $env:TANTULAR_OFFICE_BASE_MODEL -and $RamGB -gt 0 -and $RamGB -lt 12) {
  $LiteMode = $true
  $BaseModel = "qwen3:4b"
  $ModelName = "tantular-office:lite"
  $RegistryTag = "lite"
  Write-Host "RAM terdeteksi $RamGB GB (<12GB): memakai model ringan $ModelName."
}

if (-not (Get-Command ollama -ErrorAction SilentlyContinue)) {
  Write-Host "Ollama tidak ditemukan. Instal Ollama terlebih dahulu."
  exit 1
}

# Preferred path: pull the published model, then alias it to the local name
# the add-in expects in the Model Studio field.
Write-Host "Mengunduh $RegistryModel`:$RegistryTag dari ollama.com (bisa beberapa GB)..."
ollama pull "$RegistryModel`:$RegistryTag"
if ($LASTEXITCODE -eq 0) {
  ollama cp "$RegistryModel`:$RegistryTag" $ModelName
  if ($LASTEXITCODE -ne 0) {
    Write-Host "Gagal membuat alias $ModelName."
    exit 1
  }
} else {
  # Offline / registry-blocked fallback: build locally from the Modelfile.
  Write-Host "Pull dari ollama.com gagal; mencoba build lokal dari Modelfile..."
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
  $ModelfilePath = Join-Path $Root "models/Modelfile.office-8b"
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
