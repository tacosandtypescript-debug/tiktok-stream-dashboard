# scripts/build.ps1 — compilar la aplicacion utilizable
#
# Genera la interfaz y compila el binario de release, que lleva la interfaz
# EMBEBIDA: se puede ejecutar sin servidor de desarrollo.
#
#   .\scripts\build.ps1                 # gates completos + ejecutable + sidecar
#   .\scripts\build.ps1 -Bundle         # además intenta crear el instalador NSIS
#   .\apps\desktop\src-tauri\target\release\tiktok-stream-dashboard.exe

[CmdletBinding()]
param(
    [switch]$Bundle
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'env.ps1')

$desktop = Join-Path $root 'apps\desktop'
$tauri = Join-Path $desktop 'src-tauri'

if (-not (Test-Path (Join-Path $desktop 'node_modules'))) {
    throw "Faltan las dependencias del frontend. Ejecuta: cd apps\desktop ; npm ci"
}
if (-not (Test-Path (Join-Path $desktop 'package-lock.json'))) {
    throw 'Falta apps\desktop\package-lock.json; el build reproducible requiere npm ci.'
}

Write-Host '1/9  Formato Rust...' -ForegroundColor Cyan
Push-Location $tauri
try { cargo fmt --all -- --check }
finally { Pop-Location }

Write-Host '2/9  TypeScript...' -ForegroundColor Cyan
Push-Location $desktop
try {
    & node 'node_modules\typescript\bin\tsc' --noEmit
    if ($LASTEXITCODE -ne 0) { throw 'el typecheck fallo.' }
}
finally { Pop-Location }

Write-Host '3/9  Vite...' -ForegroundColor Cyan
Push-Location $desktop
try {
    & node 'node_modules\vite\bin\vite.js' build
    if ($LASTEXITCODE -ne 0) { throw 'el build de la interfaz fallo.' }
}
finally { Pop-Location }

Write-Host '4/9  Sidecar TTS autocontenido...' -ForegroundColor Cyan
& (Join-Path $PSScriptRoot 'build-tts-sidecar.ps1') -Configuration Release
if ($LASTEXITCODE -ne 0) { throw 'La construccion del sidecar fallo.' }

Write-Host '5/9  Clippy Rust (-D warnings)...' -ForegroundColor Cyan
Push-Location $tauri
try {
    cargo clippy --workspace --all-targets --all-features --offline -- -D warnings
    if ($LASTEXITCODE -ne 0) { throw 'clippy encontro avisos o errores.' }
}
finally { Pop-Location }

Write-Host '6/9  Cargo check offline...' -ForegroundColor Cyan
Push-Location $tauri
try {
    cargo check --workspace --all-targets --all-features --offline
    if ($LASTEXITCODE -ne 0) { throw 'cargo check fallo.' }
}
finally { Pop-Location }

Write-Host '7/9  Suite Rust completa offline...' -ForegroundColor Cyan
Push-Location $tauri
try {
    cargo test --workspace --all-features --offline
    if ($LASTEXITCODE -ne 0) { throw 'la suite completa de cargo test fallo.' }
}
finally { Pop-Location }

Write-Host '8/9  Validacion Tauri y release...' -ForegroundColor Cyan
Push-Location $desktop
try {
    # --no-bundle sigue validando la configuracion, externalBin y frontendDist
    # y deja el ejecutable release; el instalador NSIS es un gate separado.
    & node 'node_modules\@tauri-apps\cli\tauri.js' build --no-bundle --ci
    if ($LASTEXITCODE -ne 0) { throw 'Tauri no pudo validar o compilar el release.' }
}
finally { Pop-Location }

Write-Host '9/9  Autoverificacion del release...' -ForegroundColor Cyan
Push-Location $tauri
try { & '.\target\release\tiktok-stream-dashboard.exe' --self-test --seconds 4 }
finally { Pop-Location }

$exe = Join-Path $tauri 'target\release\tiktok-stream-dashboard.exe'
Write-Host ''
Write-Host "Listo: $exe" -ForegroundColor Green
Write-Host 'Ejecutalo directamente: la interfaz va dentro del binario.'

if ($Bundle) {
    $tauriCli = Join-Path $desktop 'node_modules\@tauri-apps\cli\tauri.js'
    if (-not (Test-Path $tauriCli)) {
        throw "No se encontro el CLI de Tauri en $tauriCli"
    }
    Write-Host 'Creando instalador NSIS y validando externalBin...' -ForegroundColor Cyan
    Push-Location $desktop
    try {
        & node $tauriCli build --bundles nsis --ci
        if ($LASTEXITCODE -ne 0) { throw 'Tauri/NSIS no pudo generar el instalador.' }
    }
    finally { Pop-Location }
}
