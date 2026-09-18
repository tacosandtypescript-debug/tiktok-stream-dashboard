# Matriz reproducible de calidad

Este documento define qué significa que el checkout esté en verde. Los comandos
son los mismos en local y en el job bloqueante de Windows/MSVC; solo cambia el
paso de preparación de dependencias: CI descarga primero los artefactos fijados y
después todos los gates de Rust se ejecutan con `--offline`.

## Matriz

| Gate | Comando / evidencia | Red durante el gate | Qué demuestra | Estado requerido |
|---|---|---:|---|---|
| Rust formatter | `cargo fmt --all -- --check` | No | Formato estable de todo el crate | Bloqueante |
| Rust lint | `cargo clippy --workspace --all-targets --all-features --offline -- -D warnings` | No | Compilación de targets y ausencia de warnings | Bloqueante |
| Rust check | `cargo check --workspace --all-targets --all-features --offline` | No | Resolución y compilación de todos los targets | Bloqueante |
| Rust tests | `cargo test --workspace --all-features --offline` | No | Suite unitaria, integración y límites; incluye fixtures grabados | Bloqueante |
| Frontend dependencies | `npm ci` | Sí, solo instalación | `package-lock.json` reproduce `node_modules` | Bloqueante |
| TypeScript | `node node_modules/typescript/bin/tsc --noEmit` | No | Tipos estrictos y contrato de la interfaz | Bloqueante |
| Vite | `node node_modules/vite/bin/vite.js build` | No | Bundle frontend reproducible en `dist/` | Bloqueante |
| Python sidecar dependencies | `scripts/setup.ps1` + `requirements.lock` con hashes | Sí, solo instalación | Python 3.12, PyInstaller y edge-tts fijados | Bloqueante para release |
| Sidecar | `scripts/build-tts-sidecar.ps1 -Configuration Release` | No | Ejecutable PyInstaller x64, triple Tauri, SHA-256 y manifest | Bloqueante para release |
| Tauri validation/release | `tauri.js build --no-bundle --ci` | No | `frontendDist`, `externalBin`, configuración y exe release | Bloqueante |
| Runtime smoke test | `target/release/tiktok-stream-dashboard.exe --self-test --seconds 4` | No | Arranque del motor, simulador, persistencia y cierre | Bloqueante |

Los gates de Rust consumen el `Cargo.lock` y solo son offline después de que el
checkout tenga el registro/cache de crates disponible. En CI, `cargo fetch
--locked` es el único paso de red para Rust. En local, la preparación equivalente
es `. .\scripts\env.ps1` y `cargo fetch --locked --manifest-path
apps\desktop\src-tauri\Cargo.toml`; si el cache ya existe, no se vuelve a
descargar nada.

## Preparación local limpia

Desde la raíz del repositorio, en PowerShell:

```powershell
. .\scripts\env.ps1
cargo fetch --locked --manifest-path apps\desktop\src-tauri\Cargo.toml
cd apps\desktop
npm ci
cd ..\..
.\scripts\setup.ps1
.\scripts\build.ps1
```

`setup.ps1` mantiene el Python administrado, el venv y Cargo dentro de
`.tooling`; el directorio temporal de uv se mantiene fuera del checkout para no
mezclar caches con fuentes ni artefactos. `.gitignore` excluye `node_modules`,
`dist`, `target`, `.tooling`, `data`, `logs`, `cache`, el sidecar generado y los
artefactos de Tauri.

## Límites de evidencia

Una ejecución verde prueba el código y el empaquetado indicados en la matriz; no
convierte automáticamente las siguientes comprobaciones en hechos demostrados:

- `scripts/build.ps1 -Bundle` / NSIS no forma parte del job bloqueante actual.
  Requiere ejecutar el empaquetado en un runner que tenga el toolchain NSIS y
  conservar el instalador como artefacto verificable.
- `--self-test` usa el proveedor simulado y no abre una ventana WebView2. No
  demuestra por sí solo que la interfaz se haya renderizado ni que el IPC llegue
  a React.
- Las pruebas de `rodio` usan sinks controlados cuando corresponde. El smoke
  test no prueba que una tarjeta de sonido concreta emita audio audible, ni la
  selección de un dispositivo físico.
- Ningún gate offline valida una sala TikTok real, firma anónima, reconexión real,
  cuotas del servidor, follows/regalos en tráfico actual o cambios del protocolo.
  Esas comprobaciones requieren una sesión manual autorizada y consumen cuota.

Por eso la documentación usa «probado por tests», «empaquetado» y «verificado en
vivo» como estados distintos. No se debe usar el verde de CI para afirmar NSIS,
TTS audible o tráfico TikTok real.
