# scripts/build-tts-sidecar.ps1 — congela el sidecar TTS para Windows x64

[CmdletBinding()]
param(
    [ValidateSet('Debug', 'Release')]
    [string]$Configuration = 'Release'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$provider = Join-Path $root 'services\tts-provider'
$venvPython = Join-Path $root '.tooling\venv\Scripts\python.exe'
$binaries = Join-Path $root 'apps\desktop\src-tauri\binaries'
$releaseDir = Join-Path $root 'apps\desktop\src-tauri\target\release'
$toolingDir = Join-Path $root '.tooling\tts-provider'
$target = 'x86_64-pc-windows-msvc'
$name = "tiktok-tts-provider-$target.exe"
$tauriConfigPath = Join-Path $root 'apps\desktop\src-tauri\tauri.conf.json'

if (-not (Test-Path $venvPython)) {
    throw "No existe $venvPython. Ejecuta scripts/setup.ps1 primero."
}
if (-not (Test-Path (Join-Path $provider 'src\main.py'))) {
    throw 'Falta services\tts-provider\src\main.py.'
}
if (-not (Test-Path (Join-Path $provider 'requirements.lock'))) {
    throw 'Falta requirements.lock; no se permite construir con dependencias flotantes.'
}
if (-not (Test-Path $tauriConfigPath)) {
    throw "Falta la configuracion Tauri: $tauriConfigPath"
}
$tauriConfig = Get-Content -Raw $tauriConfigPath | ConvertFrom-Json
if (@($tauriConfig.bundle.externalBin) -notcontains 'binaries/tiktok-tts-provider') {
    throw 'tauri.conf.json no declara externalBin binaries/tiktok-tts-provider.'
}
$rustHost = (& rustc -Vv | Select-String '^host:' | ForEach-Object { $_.Line -replace '^host:\s*', '' }).Trim()
if ($rustHost -ne $target) {
    throw "El target host de Rust es '$rustHost', pero el sidecar exige '$target'."
}

$gitCommit = (& git -C $root rev-parse HEAD).Trim()
$epoch = (& git -C $root show -s --format=%ct HEAD).Trim()
if (-not $gitCommit -or -not $epoch) { throw 'No se pudo obtener una identidad reproducible de Git.' }

$stage = Join-Path $toolingDir $Configuration.ToLowerInvariant()
$work = Join-Path $toolingDir ("build-" + $Configuration.ToLowerInvariant())
New-Item -ItemType Directory -Force -Path $stage, $work, $binaries, $releaseDir | Out-Null

$env:SOURCE_DATE_EPOCH = $epoch
$env:PYTHONHASHSEED = '0'
$env:PYINSTALLER_CONFIG_DIR = Join-Path $toolingDir 'pyinstaller-cache'

Write-Host "Construyendo $name desde $gitCommit..." -ForegroundColor Cyan
Push-Location $provider
try {
    & $venvPython -m PyInstaller `
        --clean `
        --noconfirm `
        --onefile `
        --console `
        --name 'tiktok-tts-provider' `
        --distpath $stage `
        --workpath $work `
        --specpath $work `
        'src\main.py'
    if ($LASTEXITCODE -ne 0) { throw 'PyInstaller no pudo construir el sidecar.' }
}
finally { Pop-Location }

$built = Join-Path $stage 'tiktok-tts-provider.exe'
if (-not (Test-Path $built)) { throw "PyInstaller termino sin producir $built" }

# El staging con triple es el nombre exacto que exige Tauri externalBin.
$tauriBinary = Join-Path $binaries $name
$releaseBinary = Join-Path $releaseDir $name
Copy-Item -LiteralPath $built -Destination $tauriBinary -Force
Copy-Item -LiteralPath $built -Destination $releaseBinary -Force

$hash = (Get-FileHash -Algorithm SHA256 $built).Hash.ToLowerInvariant()
$manifest = [ordered]@{
    name = $name
    target = $target
    configuration = $Configuration
    source_commit = $gitCommit
    sha256 = $hash
    bytes = (Get-Item $built).Length
}
$manifest | ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $toolingDir 'manifest.json')

Write-Host "Sidecar listo: $tauriBinary" -ForegroundColor Green
Write-Host "SHA-256: $hash"
