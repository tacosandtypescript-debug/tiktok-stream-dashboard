# scripts/web.ps1 — panel por HTTP para el navegador
#
# Compila la interfaz y levanta el motor sirviendola por HTTP, para trabajar
# desde el navegador en lugar de la ventana de escritorio.
#
#   .\scripts\web.ps1                  # compila lo que falte y arranca
#   .\scripts\web.ps1 -SinCompilar     # arranca lo que ya hay compilado
#   .\scripts\web.ps1 -Puerto 9000     # otro puerto
#
# La interfaz compilada se sirve desde `apps\desktop\dist`. Para tocar React con
# recarga en caliente y datos reales, deja este servidor levantado y arranca
# aparte `npm run dev` en `apps\desktop`: Vite hace de proxy de `/api` hacia
# aqui (ver vite.config.ts).
#
# Requisitos: `scripts\setup.ps1` una vez, y las dependencias del frontend.

param(
    [int]$Puerto = 8790,
    [switch]$SinCompilar
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'env.ps1')

$desktop = Join-Path $root 'apps\desktop'

# El motor lee el puerto de aqui; Vite lee el mismo nombre para su proxy.
$env:TTSDASH_WEB_PORT = "$Puerto"

if (-not $SinCompilar) {
    if (-not (Test-Path (Join-Path $desktop 'node_modules'))) {
        throw "Faltan las dependencias del frontend. Ejecuta: cd apps\desktop ; npm install"
    }
    Write-Host 'Compilando la interfaz...' -ForegroundColor Cyan
    Push-Location $desktop
    try { npm run build } finally { Pop-Location }
}

$indice = Join-Path $desktop 'dist\index.html'
if (-not (Test-Path $indice)) {
    throw "No hay interfaz compilada en $indice. Ejecuta .\scripts\web.ps1 sin -SinCompilar."
}

Write-Host "Levantando el panel en http://127.0.0.1:$Puerto" -ForegroundColor Cyan
Write-Host 'Ctrl+C para detenerlo.' -ForegroundColor DarkGray

Push-Location (Join-Path $desktop 'src-tauri')
try {
    # Sin la feature `desktop`: este binario no lleva Tauri ni abre ninguna
    # ventana. Es el mismo motor, por otro canal.
    cargo run --offline --no-default-features -- --web
}
finally { Pop-Location }
