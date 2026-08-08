$ErrorActionPreference = "Stop"
$Dest = Join-Path $env:USERPROFILE "TantularWorkshop"
Write-Host "Mengunduh paket workshop Tantular ke $Dest ..."
New-Item -ItemType Directory -Force -Path $Dest | Out-Null
Invoke-WebRequest -Uri "https://workshop-web-gamma.vercel.app/downloads/tantular-workshop.zip" -OutFile (Join-Path $Dest "tantular-workshop.zip")
Expand-Archive -Force (Join-Path $Dest "tantular-workshop.zip") $Dest
Set-Location $Dest
cmd /c install-tantular-workshop.bat
