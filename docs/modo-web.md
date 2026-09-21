# El panel por HTTP (`--web`)

La aplicación nace como app de escritorio: el motor (Rust) es la fuente de verdad
y la interfaz (React) habla con él por el **IPC de Tauri**. Ese canal solo existe
dentro del WebView, así que un navegador no puede usarlo.

`--web` abre el mismo motor por donde sí puede: un servidor local que sirve la
interfaz ya compilada, expone los comandos por HTTP y empuja los eventos por
WebSocket.

```text
                  ┌──────────────── ventana de escritorio ────────────────┐
                  │  WebView (React)  ──invoke/listen──▶  IPC de Tauri     │
                  └───────────────────────────────────────────────────────┘
                                          │
                                    AppState (el motor)
                                          │
                  ┌───────────────────────┴───────────────────────────────┐
                  │  navegador (React)  ──HTTP + WebSocket──▶  web/       │
                  └───────────────────────────────────────────────────────┘
```

## Arranque

```powershell
# Compila la interfaz y levanta el panel
.\scripts\web.ps1

# Ya compilado
.\scripts\web.ps1 -SinCompilar

# Otro puerto
.\scripts\web.ps1 -Puerto 9000
```

A mano, sin el script:

```powershell
cd apps\desktop
npm run build                     # deja la interfaz en apps\desktop\dist

cd src-tauri
cargo run --offline --no-default-features -- --web
```

`--web` **no necesita la feature `desktop`**: ese binario no lleva Tauri ni abre
ninguna ventana, así que compila más rápido y se puede llevar a otra máquina.

El panel queda en `http://127.0.0.1:8790`.

## Configuración

| Variable | Por defecto | Para qué |
|---|---|---|
| `TTSDASH_WEB_PORT` | `8790` | Puerto del panel. Vite lee el mismo nombre para su proxy |
| `TTSDASH_WEB_BIND` | `127.0.0.1` | Interfaz de escucha |
| `TTSDASH_WEB_DIST` | `apps\desktop\dist` | De dónde se sirve la interfaz |

Las variables del motor valen igual que en escritorio: `TTSDASH_DATA_DIR`,
`TTSDASH_AUTOSTART` (`sim` o un `@usuario`) y `TTSDASH_TTS`.

## Trabajar con recarga en caliente

Para tocar React y verlo al instante **contra datos reales**, deja el servidor
levantado y arranca Vite aparte:

```powershell
# Terminal 1: el motor
.\scripts\web.ps1 -SinCompilar

# Terminal 2: la interfaz, con recarga en caliente
cd apps\desktop
npm run dev
```

`vite.config.ts` lleva un proxy de `/api` (con `ws: true`, que es lo que mantiene
vivo el WebSocket de eventos) hacia `http://127.0.0.1:8790`. La página se sirve
desde Vite en `http://localhost:1420` y los datos vienen del motor.

También se puede trabajar sin Vite: el servidor sirve `dist` él mismo, y entonces
hay que recompilar la interfaz (`npm run build`) para ver cada cambio.

## Qué expone

| Ruta | Qué es |
|---|---|
| `GET /` | La interfaz compilada. Una ruta sin extensión devuelve `index.html` |
| `GET /api/eventos` | WebSocket con los eventos del bus, en el mismo JSON que `dash://event` |
| `POST /api/cmd/{comando}` | Un comando del motor. Cuerpo: los argumentos en JSON |
| `GET /salud` | Estado: versión, esquema, si hay interfaz compilada y las direcciones de overlay |

Los comandos contestan siempre con el mismo sobre:

```json
{ "ok": true,  "data": { } }
{ "ok": false, "error": "el usuario no puede estar vacío" }
```

El código HTTP se queda en 200 aunque el comando falle: un fallo de negocio («ese
medio no vale») no es un fallo de transporte. Solo un cuerpo JSON ilegible
devuelve 400.

Comprobar que está vivo sin abrir el panel:

```powershell
Invoke-RestMethod http://127.0.0.1:8790/salud
Invoke-RestMethod -Method Post http://127.0.0.1:8790/api/cmd/app_snapshot `
  -ContentType application/json -Body '{}'
```

## Cómo está montado

- **Una sola implementación de cada comando.** La lógica que tiene decisión propia
  —validar el handle del perfil, recorrer carpetas al importar medios, aplicar los
  ajustes de voz— vive en `src-tauri/src/ipc.rs`, y la llaman **los dos**
  transportes: `desktop.rs` desde sus comandos de Tauri y `web/mod.rs` desde su
  despachador. No hay dos copias de una regla que se puedan separar con el tiempo.
- **Una sola interfaz.** `src/api.ts` elige transporte al arrancar:

  ```ts
  const enEscritorio = "__TAURI_INTERNALS__" in window;
  ```

  Es lo que mira la propia API de Tauri para saber si el puente existe, y por eso
  **el mismo bundle** vale para la ventana y para el navegador. Todo lo demás del
  fichero no sabe por dónde va.
- **El servidor de overlays se levanta también**, porque el panel lo necesita para
  dos cosas que se ven en pantalla: la dirección que se pega en OBS y las
  miniaturas y la previa de los medios de Alertas, que las sirve ese mismo
  servidor.

## Lo que cambia respecto a la ventana

- **Abrir un perfil.** El servidor *no* abre el navegador de su máquina: el comando
  `perfil_url` valida el handle y devuelve la URL, y la pestaña la abre el
  navegador de quien está mirando. Exponer `abrir_perfil` tal cual permitiría
  lanzar un navegador en el servidor a quien diera con el puerto.
- **El canal de eventos se reconecta.** El IPC de Tauri es local y no se cae; un
  WebSocket sí. `api.ts` reintenta con espera creciente y, al volver, avisa a la
  interfaz (`onDashReconnect`) para que pida otra foto del motor: los eventos que
  pasaron con el canal caído no se reproducen, y un hueco que nadie ve es peor que
  un error.
- **La voz sale por el equipo del servidor**, no por el del navegador: la sintetiza
  y la reproduce Rust, como siempre.
- **La instancia única sigue valiendo.** El panel web y la aplicación de escritorio
  son dos instancias del mismo motor, así que no pueden convivir: si la ventana
  está abierta, `--web` lo dice y no arranca. Es lo que protege la cuota de firma
  (5/min, 30/h, 100/día) y la base de datos.

## Seguridad

El panel escucha en `127.0.0.1` por defecto. **Por aquí se puede encender el lector
de voz y leer el chat de una sala**, así que la puerta empieza cerrada.

`TTSDASH_WEB_BIND=0.0.0.0` lo abre a la red y **no hay autenticación**: cualquiera
que llegue al puerto puede mandar comandos. Úsalo solo en una red de confianza, y
mejor con un proxy delante que ponga la autenticación.

El servido de ficheros rechaza cualquier segmento `..`, cualquier barra invertida y
cualquier ruta con `:` antes de tocar el disco (hay tests en `web/mod.rs`), así que
una ruta pedida no puede salirse de la carpeta de la interfaz.

## Qué no cubre

- **No hay autenticación ni TLS.** Para trabajar en local; para exponerlo hace
  falta un proxy delante.
- **No sustituye a la ventana.** El empaquetado NSIS, el arranque con Windows y el
  icono de bandeja siguen siendo cosa de la aplicación de escritorio.
