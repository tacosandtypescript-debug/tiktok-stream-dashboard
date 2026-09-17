# scripts/setup.ps1 — prepara el entorno reproducible de desarrollo/build
#
# Crea un único venv dentro de .tooling y sincroniza las dependencias fijadas
# por services/tts-provider/requirements.lock. No instala nada en AppData ni
# modifica el Python global.

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$tooling = Join-Path $root '.tooling'
$venv = Join-Path $tooling 'venv'
$requirements = Join-Path $root 'services\tts-provider\requirements.lock'

if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
    throw 'No se encontro uv. Instala uv y vuelve a ejecutar scripts/setup.ps1.'
}
if (-not (Test-Path $requirements)) {
    throw "Falta $requirements. Regenera el lock con: uv pip compile services/tts-provider/pyproject.toml -o services/tts-provider/requirements.lock"
}

New-Item -ItemType Directory -Force -Path $tooling | Out-Null
if (-not (Test-Path (Join-Path $venv 'Scripts\python.exe'))) {
    Write-Host 'Creando .tooling\venv con Python 3.12...' -ForegroundColor Cyan
    uv venv --python 3.12 $venv
}

Write-Host 'Sincronizando dependencias fijadas de edge-tts y PyInstaller...' -ForegroundColor Cyan
uv pip sync --python (Join-Path $venv 'Scripts\python.exe') $requirements

Write-Host "Entorno listo: $venv" -ForegroundColor Green
