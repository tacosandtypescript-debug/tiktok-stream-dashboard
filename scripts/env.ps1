# scripts/env.ps1 — entorno de desarrollo del TikTok LIVE Stream Dashboard
#
# Dot-sourcear, no ejecutar:
#   . .\scripts\env.ps1
#
# Por qué existe: en este equipo el TLS de Windows (schannel) no está disponible
# para procesos hijos confinados, y el sandbox deniega la escritura a los
# subprocesos de build. La solución verificada (ver docs/decisions.md D6/D7) es
# mantener CARGO_HOME y las cachés de uv DENTRO del workspace, descargar las
# dependencias una sola vez con permiso ampliado, y compilar después con
# `cargo build --offline`, que sí funciona en modo confinado.

$ErrorActionPreference = 'Stop'

$script:ProjectRoot = Split-Path -Parent $PSScriptRoot

function Set-ProjectEnv {
    param([string]$Root = $script:ProjectRoot)

    $tooling = Join-Path $Root '.tooling'

    # Rust: registro de crates dentro del workspace -> builds offline permitidos.
    $env:CARGO_HOME = Join-Path $tooling 'cargo'

    # Python: intérprete gestionado por uv dentro del workspace.
    $env:UV_PYTHON_INSTALL_DIR = Join-Path $tooling 'python'
    $env:UV_CACHE_DIR = Join-Path $env:TEMP 'ttdash-build'

    # No empaquetar un venv activo por accidente.
    Remove-Item Env:\VIRTUAL_ENV -ErrorAction SilentlyContinue

    New-Item -ItemType Directory -Force -Path $tooling, $env:UV_CACHE_DIR | Out-Null

    Write-Host "CARGO_HOME              = $env:CARGO_HOME"
    Write-Host "UV_PYTHON_INSTALL_DIR   = $env:UV_PYTHON_INSTALL_DIR"
    Write-Host "UV_CACHE_DIR            = $env:UV_CACHE_DIR"
}

function Get-ProviderPython {
    $py = Join-Path $script:ProjectRoot '.tooling\venv\Scripts\python.exe'
    if (-not (Test-Path $py)) {
        throw "No existe $py. Ejecuta scripts/setup.ps1 primero."
    }
    return $py
}

# Compila sin tocar la red. Falla rápido si alguien añadió una dependencia nueva
# y no ha ejecutado la descarga inicial (scripts/setup.ps1).
function Invoke-CargoOffline {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$CargoArgs = @('build'))
    Set-ProjectEnv
    cargo @CargoArgs '--offline'
}

function Invoke-CargoFetch {
    param([string]$ProjectPath = (Join-Path $script:ProjectRoot 'spikes\tiktok-rust-provider'))
    Set-ProjectEnv
    Push-Location $ProjectPath
    try {
        Write-Host 'Descargando crates (requiere permiso ampliado en el sandbox)...' -ForegroundColor Yellow
        cargo fetch
    }
    finally { Pop-Location }
}

Set-ProjectEnv
