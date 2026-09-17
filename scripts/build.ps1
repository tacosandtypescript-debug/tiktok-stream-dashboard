# scripts/build.ps1 — compilar la aplicacion utilizable
#
# Genera la interfaz y compila el binario de release, que lleva la interfaz
# EMBEBIDA: se puede ejecutar sin servidor de desarrollo.
#
#   .\scripts\build.ps1                 # ejecutable + sidecar
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
    throw "Faltan las dependencias del frontend. Ejecuta: cd apps\desktop ; npm install"
}

Write-Host '1/5  Sidecar TTS autocontenido...' -ForegroundColor Cyan
& (Join-Path $PSScriptRoot 'build-tts-sidecar.ps1') -Configuration Release
if ($LASTEXITCODE -ne 0) { throw 'La construccion del sidecar fallo.' }

Write-Host '2/5  Tests del nucleo...' -ForegroundColor Cyan
Push-Location $tauri
try { cargo test --no-default-features --lib --offline }
finally { Pop-Location }

Write-Host '3/5  Comprobacion de tipos e interfaz...' -ForegroundColor Cyan
# Se invoca node directamente en lugar de `npm run`: el sandbox de desarrollo
# deniega el spawn con stdio por tuberia (EPERM) que usa npm.
Push-Location $desktop
try {
    & node 'node_modules\typescript\bin\tsc' --noEmit
    if ($LASTEXITCODE -ne 0) { throw 'el typecheck fallo' }
    & node 'node_modules\vite\bin\vite.js' build
    if ($LASTEXITCODE -ne 0) { throw 'el build de la interfaz fallo' }
}
finally { Pop-Location }

Write-Host '4/5  Binario de release...' -ForegroundColor Cyan
Push-Location $tauri
# Las features por defecto ya incluyen `custom-protocol`, que es lo que embebe
# la interfaz en el ejecutable.
try { cargo build --release --offline }
finally { Pop-Location }

Write-Host '5/5  Autoverificacion...' -ForegroundColor Cyan
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
