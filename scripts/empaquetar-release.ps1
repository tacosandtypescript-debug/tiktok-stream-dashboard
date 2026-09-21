# scripts/empaquetar-release.ps1 — el ZIP que se publica en la release
#
# Los dos ejecutables tienen que viajar **juntos**. La aplicacion busca el motor
# de voz en su propia carpeta, asi que si el navegador deja uno en `Descargas` y
# el otro acaba en el Escritorio —o lo renombra a «… (1).exe» porque ya habia uno
# descargado—, el arranque termina en «falta el motor de voz». Un ZIP con los dos
# dentro no se puede descomprimir a medias por descuido, y ademas lleva las
# licencias que hay que redistribuir con el binario.
#
#   .\scripts\empaquetar-release.ps1
#   -> dist-release\TikTokLiveDashboard-v0.4.1-win-x64.zip
#
# Requiere haber compilado antes: lo hacen `scripts/build.ps1` o la CI.

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

$ejecutables = @(
    (Join-Path $release 'tiktok-stream-dashboard.exe'),
    (Join-Path $release 'tiktok-tts-provider-x86_64-pc-windows-msvc.exe')
)
foreach ($fichero in $ejecutables) {
    if (-not (Test-Path $fichero)) {
        throw "Falta $fichero. Compila antes con scripts/build.ps1."
    }
}

$nombre = "TikTokLiveDashboard-v$Version-win-x64"
$salida = Join-Path $root 'dist-release'
$stage = Join-Path $salida $nombre

if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
New-Item -ItemType Directory -Force -Path $stage | Out-Null

foreach ($fichero in $ejecutables) { Copy-Item $fichero $stage }
# Las licencias viajan en el ZIP: es lo que se redistribuye, no solo el .exe.
foreach ($extra in @('LICENSE', 'THIRD_PARTY_NOTICES.md')) {
    $ruta = Join-Path $root $extra
    if (Test-Path $ruta) { Copy-Item $ruta $stage }
}

$zip = Join-Path $salida "$nombre.zip"
if (Test-Path $zip) { Remove-Item -Force $zip }
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -CompressionLevel Optimal

Write-Host ''
Get-ChildItem $stage | Select-Object Name, @{ n = 'MB'; e = { [math]::Round($_.Length / 1MB, 2) } } |
    Format-Table -AutoSize
Write-Host "Listo: $zip" -ForegroundColor Green
Write-Host "SHA-256: $((Get-FileHash $zip -Algorithm SHA256).Hash)"
