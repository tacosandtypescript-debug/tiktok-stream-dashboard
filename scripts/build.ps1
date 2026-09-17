# scripts/build.ps1 — compilar la aplicacion utilizable
#
# Genera la interfaz y compila el binario de release, que lleva la interfaz
# EMBEBIDA: se puede ejecutar sin servidor de desarrollo.
#
#   .\scripts\build.ps1
#   .\apps\desktop\src-tauri\target\release\tiktok-stream-dashboard.exe

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'env.ps1')

$desktop = Join-Path $root 'apps\desktop'
$tauri = Join-Path $desktop 'src-tauri'

if (-not (Test-Path (Join-Path $desktop 'node_modules'))) {
    throw "Faltan las dependencias del frontend. Ejecuta: cd apps\desktop ; npm install"
}

Write-Host '1/4  Tests del nucleo...' -ForegroundColor Cyan
Push-Location $tauri
try { cargo test --no-default-features --lib --offline }
finally { Pop-Location }

Write-Host '2/4  Comprobacion de tipos e interfaz...' -ForegroundColor Cyan
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

Write-Host '3/4  Binario de release...' -ForegroundColor Cyan
Push-Location $tauri
# Las features por defecto ya incluyen `custom-protocol`, que es lo que embebe
# la interfaz en el ejecutable.
try { cargo build --release --offline }
finally { Pop-Location }

Write-Host '4/4  Autoverificacion...' -ForegroundColor Cyan
Push-Location $tauri
try { & '.\target\release\tiktok-stream-dashboard.exe' --self-test --seconds 4 }
finally { Pop-Location }

$exe = Join-Path $tauri 'target\release\tiktok-stream-dashboard.exe'
Write-Host ''
Write-Host "Listo: $exe" -ForegroundColor Green
Write-Host 'Ejecutalo directamente: la interfaz va dentro del binario.'
