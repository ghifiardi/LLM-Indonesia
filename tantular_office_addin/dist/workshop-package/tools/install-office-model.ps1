$ErrorActionPreference = "Continue"
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
  Write-Host "Mengunduh $RegistryModel`:$RegistryTag dari ollama.com (bisa beberapa GB)..."
  ollama pull "$RegistryModel`:$RegistryTag"
  if ($LASTEXITCODE -ne 0) {
    Write-Host "Gagal mengunduh $RegistryModel`:$RegistryTag."
    exit 1
  }
  ollama cp "$RegistryModel`:$RegistryTag" $ModelName
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
