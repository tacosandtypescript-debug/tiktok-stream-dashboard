# scripts/dev.ps1 — modo desarrollo
#
# Levanta el servidor de Vite y arranca Tauri contra el.
#
# En Tauri, un binario de *debug* carga `devUrl` (http://localhost:1420) en lugar
# de la interfaz empaquetada. Por eso, ejecutar el binario de debug sin Vite
# levantado da ERR_CONNECTION_REFUSED. Este script evita ese error.
#
# Para usar la aplicacion SIN servidor de desarrollo, compila en release:
#   .\scripts\build.ps1

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'env.ps1')

$desktop = Join-Path $root 'apps\desktop'
if (-not (Test-Path (Join-Path $desktop 'node_modules'))) {
    throw "Faltan las dependencias del frontend. Ejecuta: cd apps\desktop ; npm install"
}

Write-Host 'Arrancando Vite (servidor de desarrollo)...' -ForegroundColor Cyan
$vite = Start-Process -FilePath 'node' `
    -ArgumentList 'node_modules\vite\bin\vite.js' `
    -WorkingDirectory $desktop -PassThru -WindowStyle Minimized

try {
    # Se espera a que el puerto 1420 responda antes de abrir la ventana.
    $listo = $false
    foreach ($intento in 1..30) {
        Start-Sleep -Milliseconds 500
        if (Get-NetTCPConnection -LocalPort 1420 -State Listen -ErrorAction SilentlyContinue) {
            $listo = $true
            break
        }
    }
    if (-not $listo) { throw 'Vite no abrio el puerto 1420' }

    Write-Host 'Arrancando la aplicacion...' -ForegroundColor Cyan
    Push-Location (Join-Path $desktop 'src-tauri')
    try {
        # Sin `custom-protocol`: es lo que hace que Tauri use el servidor de
        # desarrollo (devUrl) en lugar de la interfaz embebida.
        cargo run --offline --no-default-features --features desktop
    }
    finally { Pop-Location }
}
finally {
    if ($vite -and -not $vite.HasExited) {
        Write-Host 'Deteniendo Vite...' -ForegroundColor DarkGray
        Stop-Process -Id $vite.Id -Force -ErrorAction SilentlyContinue
    }
}
