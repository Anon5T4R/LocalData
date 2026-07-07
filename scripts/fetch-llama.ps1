# Downloads the llama.cpp Vulkan Windows build and installs it under
# src-tauri/binaries/llama (llama-server.exe + ggml DLLs).
# Windows assets are .zip; the Linux/AppImage build uses the .tar.gz handled by
# fetch-llama.sh (the AppImage runtime never deals with a zip).
# Usage: powershell -ExecutionPolicy Bypass -File scripts/fetch-llama.ps1
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$root = Split-Path -Parent $PSScriptRoot
$llamaDir = Join-Path $root "src-tauri\binaries\llama"
New-Item -ItemType Directory -Force -Path $llamaDir | Out-Null

if (Test-Path (Join-Path $llamaDir "llama-server.exe")) {
    Write-Host "llama runtime já existe em $llamaDir"
    exit 0
}

Write-Host "Consultando release mais recente do llama.cpp..."
$headers = @{ "User-Agent" = "localdata-app" }
if ($env:GH_TOKEN) { $headers["Authorization"] = "Bearer $env:GH_TOKEN" }
$rel = Invoke-RestMethod -Uri "https://api.github.com/repos/ggml-org/llama.cpp/releases/latest" -Headers $headers
# Vulkan build: GPU em qualquer placa + fallback CPU (-ngl 0), sem CUDA externo.
$asset = $rel.assets | Where-Object { $_.name -match "win-vulkan-x64\.zip$" } | Select-Object -First 1
if (-not $asset) { throw "asset win-vulkan-x64 não encontrado no release $($rel.tag_name)" }

Write-Host "Baixando $($asset.name) ($([math]::Round($asset.size/1MB,1)) MB)..."
$zip = Join-Path $env:TEMP $asset.name
Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zip
Expand-Archive -Path $zip -DestinationPath $llamaDir -Force
Remove-Item $zip -Force

Write-Host "Instalado em $llamaDir ($($rel.tag_name))"
