# scripts/empaquetar-release.ps1 — el ZIP que se publica en la release
#
# El ZIP tiene que llevar **los dos ejecutables y el pack de alertas**, y esa
# carpeta no es opcional: la aplicacion resuelve el origen de fabrica con
# `resource_dir()/alertas-pack`, que en un ejecutable portatil es la carpeta donde
# esta el. Si falta, el primer arranque no siembra nada y la aplicacion se queda
# **sin los 398 medios de fabrica** —sin sonidos ni imagenes— nada mas abrirla.
#
# Paso: el primer ZIP de la v0.4.1 salio con los dos .exe sueltos y sin el pack.
# En el equipo de compilacion no se notaba, porque el binario guarda de reserva la
# ruta absoluta del checkout (`CARGO_MANIFEST_DIR`) y alli el pack si existe. En
# cualquier otro equipo, no. Por eso este script **comprueba el ZIP que acaba de
# escribir** en vez de fiarse de que las copias salieron bien.
#
#   .\scripts\empaquetar-release.ps1
#   -> dist-release\TikTokLiveDashboard-v0.4.1-win-x64.zip
#
# Requiere haber compilado antes con `scripts/build.ps1 -Bundle`, que es quien
# deja el pack y el motor de voz en `target/release`.

[CmdletBinding()]
param(
    # Por defecto, la version que declara `tauri.conf.json`.
    [string]$Version
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

$release = Join-Path $root 'apps\desktop\src-tauri\target\release'
$config = Get-Content (Join-Path $root 'apps\desktop\src-tauri\tauri.conf.json') -Raw | ConvertFrom-Json
if (-not $Version) { $Version = $config.version }

$app = Join-Path $release 'tiktok-stream-dashboard.exe'
$sidecar = Join-Path $release 'tiktok-tts-provider-x86_64-pc-windows-msvc.exe'
$pack = Join-Path $release 'alertas-pack'

foreach ($fichero in @($app, $sidecar)) {
    if (-not (Test-Path $fichero)) {
        throw "Falta $fichero. Compila antes con scripts/build.ps1 -Bundle."
    }
}
if (-not (Test-Path $pack)) {
    throw "Falta $pack. Lo deja el paso de bundle de Tauri; sin el, el ZIP sale sin medios de fabrica."
}

$nombre = "TikTokLiveDashboard-v$Version-win-x64"
$salida = Join-Path $root 'dist-release'
$stage = Join-Path $salida $nombre

if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
New-Item -ItemType Directory -Force -Path $stage | Out-Null

Copy-Item $app $stage
Copy-Item $sidecar $stage
# El pack va **dentro**, con su nombre: es la carpeta que la aplicacion busca.
Copy-Item $pack $stage -Recurse
# Las licencias viajan en el ZIP: es lo que se redistribuye, no solo el .exe.
foreach ($extra in @('LICENSE', 'THIRD_PARTY_NOTICES.md')) {
    $ruta = Join-Path $root $extra
    if (Test-Path $ruta) { Copy-Item $ruta $stage }
}

$zip = Join-Path $salida "$nombre.zip"
if (Test-Path $zip) { Remove-Item -Force $zip }
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -CompressionLevel Optimal

# La comprobacion que faltaba: se lee el ZIP recien escrito y se cuentan los
# medios. Un ZIP sin `alertas-pack/audio` es un ZIP que arranca mudo.
Add-Type -AssemblyName System.IO.Compression.FileSystem
$lector = [System.IO.Compression.ZipFile]::OpenRead($zip)
try {
    $entradas = $lector.Entries
    $medios = @($entradas | Where-Object { $_.FullName -like 'alertas-pack/audio/*' }).Count
    $imagenes = @($entradas | Where-Object { $_.FullName -like 'alertas-pack/imagenes/*' }).Count
    $exes = @($entradas | Where-Object { $_.FullName -like '*.exe' }).Count
}
finally { $lector.Dispose() }

if ($exes -lt 2) { throw "El ZIP lleva $exes ejecutables: hacen falta la aplicacion y el motor de voz." }
if ($medios -lt 1 -or $imagenes -lt 1) {
    throw "El ZIP no lleva el pack de alertas (audio: $medios, imagenes: $imagenes). Arrancaria sin medios de fabrica."
}

Write-Host ''
Write-Host "Verificado: $exes ejecutables, $medios audios y $imagenes imagenes dentro del ZIP." -ForegroundColor Cyan
Get-ChildItem $stage | Select-Object Name, @{ n = 'MB'; e = { [math]::Round($_.Length / 1MB, 2) } } |
    Format-Table -AutoSize
Write-Host "Listo: $zip" -ForegroundColor Green
Write-Host "SHA-256: $((Get-FileHash $zip -Algorithm SHA256).Hash)"
