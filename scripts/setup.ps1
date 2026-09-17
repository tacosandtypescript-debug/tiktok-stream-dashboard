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
$venvPython = Join-Path $venv 'Scripts\python.exe'
$requirements = Join-Path $root 'services\tts-provider\requirements.lock'

# Mantener todas las rutas administradas por uv dentro del checkout. Sin este
# dot-source, uv puede descargar Python en su instalacion de usuario aunque el
# resto del proyecto ya use .tooling.
. (Join-Path $PSScriptRoot 'env.ps1')

if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
    throw 'No se encontro uv. Instala uv y vuelve a ejecutar scripts/setup.ps1.'
}
if (-not (Test-Path $requirements)) {
    throw "Falta $requirements. Regenera el lock con: uv pip compile services/tts-provider/pyproject.toml -o services/tts-provider/requirements.lock"
}

New-Item -ItemType Directory -Force -Path $tooling | Out-Null
if (-not (Test-Path $venvPython)) {
    Write-Host 'Creando .tooling\venv con Python 3.12...' -ForegroundColor Cyan
    uv venv --managed-python --python 3.12 $venv
    if ($LASTEXITCODE -ne 0) { throw 'uv no pudo crear el venv de Python 3.12.' }
}

$pythonVersion = (& $venvPython -c 'import sys; print("%d.%d" % sys.version_info[:2])').Trim()
if ($pythonVersion -ne '3.12') {
    throw "El venv existente usa Python $pythonVersion; se esperaba Python 3.12. Borra solo .tooling\venv y vuelve a ejecutar scripts/setup.ps1."
}

Write-Host 'Sincronizando dependencias fijadas de edge-tts y PyInstaller...' -ForegroundColor Cyan
uv pip sync --strict --require-hashes --python $venvPython $requirements
if ($LASTEXITCODE -ne 0) { throw 'uv no pudo sincronizar requirements.lock.' }

Write-Host "Entorno listo: $venv" -ForegroundColor Green
