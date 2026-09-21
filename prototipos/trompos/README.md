# Arena de trompos · prototipo visual y físico

Prototipo **independiente** de un overlay de batallas de trompos para directos.
Valida dos cosas y sólo dos: **cómo se ven los trompos** y **cómo se comporta la
física**. No toca la aplicación, no habla con TikTok, no hay regalos, ni base de
datos, ni configuración, ni API nueva.

* Lienzo exacto de **1080 × 1920 px** con **fondo transparente**.
* **Canvas 2D** con `requestAnimationFrame`. HTML, JavaScript y CSS. Nada más.
* Cero compilación: se editan los archivos y se recarga el navegador.
* **Ningún sprite**: el cuerpo de cada trompo son círculos, arcos, polígonos, líneas,
  anillos, degradados, sombras y transparencias calculados en el momento.
* Sonidos **sintetizados** con WebAudio: no hay ni un archivo de audio.

| Orden | Qué añadió |
| --- | --- |
| **01** | Diez trompos generados por código, física, colisiones, vida, efectos, tabla y simulación por fases |
| **02** | Escala a la mitad y adaptable a 10/20/30/40 participantes, zonas reservadas, clasificación dentro del lienzo, etiquetas compactas, daño visible y sonido |
| **03** | Identidad de los participantes: ficha de datos, foto o inicial en el núcleo, color propio, variantes de diseño, identidad en la tabla y en los carteles, entradas y salidas y casos límite |
| **04** | Diez poderes **de ataque** (uno por diseño) que **puede usar cualquiera**, con carga, activación, efecto y finalización, enfriamiento por poder, límites físicos, sonidos propios, panel de pruebas y demostración reproducible |
| **05** | **Configuración de regalos**: tabla editable (regalo, cantidad, recompensa, vida, poder, objetivo, enfriamiento, activo), motor de recompensas sobre el donador, cola cuando el poder está enfriando, acumulación con excedente, historial de eventos, panel de regalos simulados y persistencia en `datos/regalos.json` |
| **06** | **Regalos reales de TikTok**: puente con el bus de eventos del motor, evento normalizado, identidad por `userId`, idempotencia, rachas, cola de espera con el cupo de 40, reconexión sin duplicar y taller de conexión |

---

## Verlo

```bash
cd prototipos/trompos
node servidor.mjs          # http://127.0.0.1:8123/
```

| Dirección | Qué es |
| --- | --- |
| <http://127.0.0.1:8123/> | El taller: arena, controles de desarrollo, lecturas y tabla completa |
| <http://127.0.0.1:8123/disenos.html> | La lámina de los diez diseños, quieta y con su geometría escrita |
| <http://127.0.0.1:8123/identidad.html> | La lámina de identidades: las caras grandes, para juzgar el medallón (`?participantes=40`) |
| <http://127.0.0.1:8123/?limpio=1> | Sólo el lienzo, a pantalla completa (así se pondría en OBS) |
| `?verLimites=1&verRadios=1&calidad=0.6` | Capas de depuración y menos partículas |

Cualquier parámetro se puede forzar por URL usando su nombre:
`?velocidadCrucero=700&inicial=900&semilla=1234`.

Atajos de teclado: `espacio` pausa · `r` reinicia · `i` crea un impacto · `a` añade
participante · `n` nombres · `t` tabla · `s` sonido · `d` datos en el lienzo ·
`1` `2` `3` `4` ponen 10, 20, 30 y 40 participantes.

En el panel, la sección **Identidad** permite elegir un participante y cambiarle el
nombre, la foto, el diseño y la variante, quitarlo de la arena o añadir uno nuevo; trae
botones para probar los casos raros (nombre largo, nombre repetido, foto que falta, sin
foto, foto panorámica) y un contador de fotos cargadas y fallidas. Las fotos se generan
con `node generar-fotos.mjs`.

---

## Qué hay dentro

```
prototipos/trompos/
  index.html          el taller
  disenos.html        la lámina de los diez diseños
  identidad.html      la lámina de identidades (caras grandes)
  css/prototipo.css   estilos de las páginas (el lienzo no lleva fondo)
  servidor.mjs        servidor de desarrollo sin dependencias
  generar-fotos.mjs   genera las fotos simuladas (PNG escritos a mano, sin dependencias)
  banco.mjs           comprobación en navegador (117 comprobaciones + capturas)
  banco-fisica.mjs    comprobación y ajuste de la física en Node, sin navegador
  fotos/              44 retratos de 96×96 y una panorámica de 240×96 (datos de prueba)
  js/
    parametros.js     TODOS los números ajustables, en un solo sitio
    azar.js           azar con semilla (mulberry32)
    util.js           números, color y ayudas de dibujo
    participantes.js  identidad: plantilla, variantes de diseño, reparto y sitio libre
    fotos.js          carga de fotos, caché de medallones y respaldo con la inicial
    poderes.js        catálogo de los diez poderes, máquina de estados, objetivos y efectos
    regalos.js        configuración de regalos, recompensas, cola, acumuladores e historial
    tiktok.js         puente con el bus del motor: normalizador, deduplicador, rachas y conexión
    usuarios.js       identidad por userId, cupo de 40 y cola de espera
    trompo.js         qué es un trompo: vida, giro, daño, muerte, prioridad de etiqueta
    fisica.js         movimiento, rebotes, choques, impulso y daño
    efectos.js        partículas, ondas, destellos, explosiones, cortes y números
    sonido.js         efectos sintetizados, volumen, silencio y limitador
    mensajes.js       carteles de eliminación, de líder y de poder
    tabla.js          tabla completa (la que va fuera del lienzo, en el taller)
    simulacion.js     fases, bucle, reglas de la ronda y clasificación
    hud.js            controles de desarrollo, identidad, poderes y lecturas
    principal.js      arranque y ayudas de comprobación
    dibujo/
      geometria.js    polígonos, palas, anillos, espirales, degradados
      disenos.js      los diez diseños y sus capas
      trompo.js       composición de un trompo en pantalla
      poderes.js      dibujo de los poderes: fondo, frente e indicadores
      etiquetas.js    medallón de identidad, arco de vida, nombre y anti-solape
      clasificacion.js la tabla de clasificación dentro del lienzo
      capas.js        espera, cuenta atrás, victoria y límites
    lamina.js         la lámina de diseños
    lamina-identidad.js la lámina de identidades
  capturas/           capturas de demostración (las genera `banco.mjs`)
```

---

## Los regalos reales de TikTok (orden 06)

**No se abre ninguna conexión nueva con TikTok.** El motor de la aplicación ya tiene su
proveedor nativo y publica los eventos normalizados por WebSocket en
`ws://127.0.0.1:8790/api/eventos` —el mismo bus que alimentan los overlays—. El prototipo
**se suscribe a ese bus**: si cambia el proveedor, aquí no se toca nada. Tampoco pide
credenciales, ni cookies, ni tokens, y no envía nada a TikTok: sólo escucha.

```
regalo en TikTok
  → proveedor nativo del motor (Rust, ya existente)
  → bus de eventos por WebSocket  ws://127.0.0.1:8790/api/eventos
  → ConexionTikTok (js/tiktok.js): normaliza · deduplica · resuelve la racha
  → Usuarios (js/usuarios.js): identidad por userId → participante (o cola de espera)
  → Regalos (js/regalos.js): busca en la tabla → vida / poder / evento
  → el trompo del donador: vida, poder con su objetivo, ranking, historial
  → overlay: cartel con donador, regalo y poder
```

### El evento normalizado

El motor publica el sobre del **protocolo 1** (`core/event.rs`); de ahí sale el evento
interno, que es lo único que conoce el juego:

```json
{
  "protocol_version": 1,
  "event_id": "…", "seq": 42, "timestamp_ms": 1789953000000, "room_id": "…",
  "type": "gift.received",
  "user": { "id": "1234", "unique_id": "mariana", "nickname": "Mariana", "avatar_url": "…" },
  "gift": { "id": "5658", "name": "Dona", "diamond_count": 1, "streakable": false,
            "repeat_count": 1, "is_final": true, "group_id": "" }
}
```

```json
{
  "eventId": "…", "protocolo": 1,
  "userId": "1234", "userName": "mariana", "displayName": "Mariana", "avatarUrl": "…",
  "giftId": "5658", "giftName": "Dona",
  "quantity": 1, "repeatCount": 1, "isFinal": true,
  "diamantes": 1, "acumulable": false, "grupoId": "", "salaId": "…", "seq": 42,
  "recibidoEn": 1789953014146, "marca": 1789953000000, "origen": "app"
}
```

Reglas del normalizador (`js/tiktok.js`, **módulo compartido** por el navegador y el
servidor, para que no haya dos normalizadores):

* lo que no es `gift.*` se descarta y se cuenta (`noRegalo`);
* un regalo **sin `userId`** se descarta y se cuenta (`sinUsuario`): no se inventa donador;
* si el emisor no manda `event_id`, se compone una clave segura con
  `userId|giftId|grupoId|repeatCount|marca`.

### Identidad del espectador

La clave es el **`userId`**, nunca el nombre: TikTok deja cambiar el mote y el apodo, y con
el nombre como clave el mismo espectador acabaría con dos participantes. Se guarda:

```json
{ "userId": "1234", "userName": "mariana", "displayName": "Mariana", "avatarUrl": "…",
  "firstSeenAt": 1789953014146, "lastSeenAt": 1789953020000,
  "participantId": "p12", "active": true }
```

* si no hay avatar (o falla la carga), queda **la inicial** sobre su color;
* el registro se conserva entre reinicios en `datos/usuarios.json` (misma API aprobada
  que la tabla de regalos, no la base de datos de la aplicación).

### Idempotencia y rachas

* **Deduplicador** (`Deduplicador`): recuerda los `eventId` vistos 10 minutos (hasta
  4000). Un evento repetido no da vida, no lanza poderes y no vuelve a contar: queda en
  el registro como «duplicado ignorado».
* **Rachas** (`Rachas`): TikTok manda actualizaciones parciales de la misma racha con el
  total acumulado en `repeat_count`. Sólo cuenta la **diferencia nueva**: una racha
  `1 → 3 → 5` aporta 1 + 2 + 2 = **5** unidades, no 9. El cierre (`is_final`) no suma nada.

### Cupo de 40 y cola de espera

Con 40 participantes activos **no se crea el 41 dentro de la arena**: el espectador queda
**EN ESPERA** (se ve en el taller con su posición en la cola y en el overlay con un
cartel), y **no pierde ni un regalo**: lo que le llega se apunta y se le aplica al entrar,
que ocurre en cuanto se libera un sitio (cada segundo se comprueba) o al empezar la ronda
siguiente. Los que ya estaban registrados **conservan su nombre, su foto y su sitio** de
ronda en ronda.

### Estados de la conexión

| Estado | Cuándo |
| --- | --- |
| **Desconectado** | Al arrancar, o al pulsar Desconectar |
| **Conectando** | Abriendo el WebSocket con el bus |
| **Conectado** | Recibiendo eventos del motor (o del puente HTTP) |
| **Reconectando** | Se perdió la conexión: se reintenta con espera progresiva (1 s, 2, 4… hasta 15 s) |
| **Error** | El navegador no puede abrir WebSocket |

La reconexión **no** reinicia la batalla, **no** borra participantes, **no** pierde la
configuración y **no** duplica eventos: el deduplicador sigue vivo.

### Dos fuentes reales y una simulada, todas por el mismo camino

| Fuente | Cómo |
| --- | --- |
| **Bus del motor** | `Conectar al bus` → WebSocket `ws://127.0.0.1:8790/api/eventos` |
| **Puente del servidor** | `Escuchar puente del servidor` → `GET /api/tiktok/eventos` (lo que un listener autorizado deja con `POST /api/tiktok/evento`) |
| **Simulado** | Los doce botones de «Eventos de prueba» |

Los tres llaman a `enviarCrudo()`, el **único** punto de entrada: no existe ninguna ruta
de prueba que se salte el normalizador, la tabla, la acumulación o el enfriamiento. Y si
el mismo evento llega por dos caminos a la vez (p. ej. bus y puente), el segundo se
descarta como duplicado.

### Eventos de prueba

Usuario nuevo · Rosa (vida) · Dona (poder) · Estrella ×3 (acumulación) · Universo (poder
en enfriamiento) · Regalo Raro (no configurado) · Galaxia 1/3/5 (racha parcial) · Rosa
repetida (usuario ya conocido) · Evento duplicado · Eliminado · En espera · Fuego (evento
especial).

### Endpoints del prototipo

| Ruta | Para qué |
| --- | --- |
| `POST /api/tiktok/evento` | Ingesta: normaliza y encola lo que empuje cualquier listener autorizado. Idempotente |
| `GET /api/tiktok/eventos?desde=N` | La cola de ingesta que consume el prototipo |
| `GET /api/tiktok/estado` | Estado del puente y contadores de ingesta |
| `GET`/`POST /api/usuarios` | Registro de identidades (`datos/usuarios.json`) |
| `GET /api/avatar?u=…` | Avatar de TikTok servido desde el mismo origen (el lienzo no se ensucia). Sólo hosts de TikTok, 2 MB de tope, caché por hash y **la URL no se registra** |

### Seguridad y datos

* El prototipo **no** pide ni guarda contraseñas, cookies, tokens ni claves; el estado, el
  historial y el registro técnico se revisan en el banco buscando justo eso (0 hallazgos).
* No se escribe nada en la base de datos de la aplicación ni se toca `apps/desktop`.
* Los nombres y las fotos se usan sólo dentro del prototipo.
* No se envía ningún mensaje ni acción a TikTok.

### Cómo se prueba

| Qué quieres ver | Cómo |
| --- | --- |
| La conexión de verdad | `Conectar al bus` con el motor en marcha (escucha, no interviene) y envía un regalo desde una cuenta autorizada |
| Sin conexión | Modo **Simulado** + los doce botones de eventos de prueba |
| Sin depender del motor | `Escuchar puente del servidor` y empujar un evento con `curl -X POST http://127.0.0.1:8123/api/tiktok/evento -d @evento.json` |
| Quién es quién | «Espectadores reconocidos»: nombre, `@usuario`, regalos y estado (dentro / **EN ESPERA** con su posición) |
| Un regalo que no está | «Regalos sin configurar»: se lista con su id para poder añadirlo a la tabla |
| Duplicados | «Registro técnico»: cada evento repetido sale como «duplicado ignorado» |
| La cola de poderes | Contador «En cola» del panel de regalos + el aviso del evento |
| El cupo de 40 | Pon 40 participantes y lanza el evento «En espera»: queda EN ESPERA y entra al liberar un sitio (`Promover de la cola`) |

---

## Los regalos (orden 05)

Todavía **sin TikTok**: los regalos se simulan desde el taller, pero todo el camino
—configuración, recompensa, poder del donador, objetivos, cola de enfriamiento,
acumulación, historial y guardado— es el de verdad. Cuando llegue la fase siguiente sólo
habrá que cambiar de dónde sale el evento.

### Estructura de cada regalo

```json
{
  "id": "dona",
  "regalo": "Dona",
  "regaloId": "5658",
  "cantidad": 1,
  "recompensa": "poder",
  "vida": 0,
  "poder": "balance",
  "objetivo": "cercano",
  "enfriamiento": 0,
  "acumulacion": "inmediata",
  "activo": true
}
```

| Campo | Qué es |
| --- | --- |
| `id` | Clave interna de la fila (la usan el motor y el historial) |
| `regalo` | Nombre visible |
| `regaloId` | Identificador del regalo (el de TikTok cuando llegue) |
| `cantidad` | Unidades necesarias para que dé la recompensa |
| `recompensa` | `vida` · `poder` · `vida_poder` · `evento` |
| `vida` | Cuánta vida da (0 si no da vida) |
| `poder` | Clave del poder que activa (`null` si no activa ninguno) |
| `objetivo` | A quién apunta: `cercano`, `mas_vida`, `lider`, `aleatorio`, `area`, `propio`, `todos` |
| `enfriamiento` | Segundos mínimos entre dos veces del mismo regalo (0 = sin límite) |
| `acumulacion` | `inmediata` · `ronda` · `participante` |
| `activo` | Si está encendido |

Y dos reglas globales:

```json
"reglas": { "siEnfriando": "cola", "excedente": "conservar" }
```

* `siEnfriando`: `cola` (espera y lo lanza al quedar libre) · `ignorar` · `primer_disponible`.
* `excedente`: `conservar` (el sobrante sigue contando) · `reiniciar`.

### Ejemplo de configuración exportada

`Exportar` descarga exactamente esto (2755 bytes con los nueve regalos de ejemplo):

```json
{
  "version": 1,
  "exportado": "2026-09-20T17:52:44.108Z",
  "reglas": { "siEnfriando": "cola", "excedente": "conservar" },
  "regalos": [
    { "id": "rosa", "regalo": "Rosa", "regaloId": "5655", "cantidad": 1, "recompensa": "vida", "vida": 500, "poder": null, "objetivo": "propio", "enfriamiento": 0, "acumulacion": "inmediata", "activo": true },
    { "id": "dona", "regalo": "Dona", "regaloId": "5658", "cantidad": 1, "recompensa": "poder", "vida": 0, "poder": "balance", "objetivo": "cercano", "enfriamiento": 0, "acumulacion": "inmediata", "activo": true },
    { "id": "leon", "regalo": "León", "regaloId": "5659", "cantidad": 1, "recompensa": "poder", "vida": 0, "poder": "cosmico", "objetivo": "area", "enfriamiento": 0, "acumulacion": "inmediata", "activo": true },
    { "id": "universo", "regalo": "Universo", "regaloId": "5660", "cantidad": 1, "recompensa": "vida_poder", "vida": 800, "poder": "volcanico", "objetivo": "cercano", "enfriamiento": 0, "acumulacion": "inmediata", "activo": true },
    { "id": "estrella", "regalo": "Estrella", "regaloId": "5661", "cantidad": 3, "recompensa": "poder", "vida": 0, "poder": "electrico", "objetivo": "mas_vida", "enfriamiento": 0, "acumulacion": "participante", "activo": true },
    { "id": "corona", "regalo": "Corona", "regaloId": "5662", "cantidad": 2, "recompensa": "vida_poder", "vida": 1200, "poder": "ataque", "objetivo": "lider", "enfriamiento": 6, "acumulacion": "participante", "activo": true },
    { "id": "manita", "regalo": "Manita", "regaloId": "5663", "cantidad": 1, "recompensa": "poder", "vida": 0, "poder": "defensa", "objetivo": "todos", "enfriamiento": 5, "acumulacion": "inmediata", "activo": true },
    { "id": "galaxia", "regalo": "Galaxia", "regaloId": "5664", "cantidad": 5, "recompensa": "vida", "vida": 1500, "poder": null, "objetivo": "propio", "enfriamiento": 0, "acumulacion": "ronda", "activo": true },
    { "id": "fuego", "regalo": "Fuego", "regaloId": "5665", "cantidad": 4, "recompensa": "evento", "vida": 0, "poder": null, "objetivo": "todos", "enfriamiento": 10, "acumulacion": "inmediata", "activo": false }
  ]
}
```

### El poder sale del trompo del donador

Un regalo de poder **no mira el diseño** del que lo manda: se lanza desde su trompo, con
el objetivo configurado y respetando su enfriamiento individual. Comprobado con Carlos
(diseño de ataque, firma *Filo Radial*): al recibir una *Dona* lanzó *Onda de Rebote* —el
poder del regalo— y su firma siguió siendo *Filo Radial*.

### Objetivos

| Objetivo | A quién apunta |
| --- | --- |
| **Rival más cercano** | El más próximo dentro del alcance del poder |
| **Rival con más vida** | El que va primero por vida |
| **Líder actual** | El primero de la clasificación |
| **Participante aleatorio** | Uno al azar del flujo de la física (misma semilla, mismo elegido) |
| **Todos los rivales del área** | Todos los que estén dentro del radio del poder |
| **El propio donador** | Él mismo (sirve para poderes de contacto y para pruebas) |
| **Todos los participantes** | Todos los vivos, sin límite de distancia |

Reglas que se cumplen: los poderes de ataque **no** tocan al donador salvo que el
objetivo sea «el propio donador»; los de área **siempre** respetan su radio (con
objetivo «líder», si el líder está fuera del radio, no alcanza a nadie); las cadenas
siguen con **tres saltos** como mucho; los eliminados **nunca** reciben daño; y un poder
de contacto (Filo Radial, Golpe Umbrío) apunta al objetivo elegido pero **sólo pega si
llega a tocarlo**.

### Vida, cola y cantidades

* **Vida**: sube la vida del donador sin pasar del máximo, con número flotante verde,
  destello y chispas doradas, y se ve en el anillo y en la tabla. Si el donador está
  eliminado **no se le revive**: el evento se registra como rechazado.
* **Cola**: si el poder está en enfriamiento, con la regla inicial el evento **no se
  pierde**: queda apuntado en la cola (se ve cuántos hay pendientes) y se lanza en cuanto
  la clave queda libre. También se puede configurar «ignorar» (el rechazo queda
  registrado) o «lanzar el primer poder disponible».
* **Cantidades**: se acumulan por ronda o por participante, se enseña el progreso
  (`2/3`), y el sobrante se conserva (`3/3` dispara y 2 unidades vuelven a contar desde
  `2/3`) o se reinicia, según la regla.
* **Un golpe, un daño**: un poder no lo anula la protección de un choque (un regalo no
  puede quedarse en nada por un roce de hace 0,1 s), pero dos poderes no pueden pegarle al
  mismo trompo en el mismo instante: para eso está la ventana `proteccionPoder` (0,25 s).

### Persistencia

El taller guarda con `Guardar` en **`datos/regalos.json`** a través de `/api/regalos`
(servidor del prototipo, no la base de datos de la aplicación). Al recargar la página o
reiniciar `node servidor.mjs` la configuración vuelve tal cual, incluidos los valores
editados. `Restaurar ejemplos` repone los nueve regalos de arriba y `Exportar` /
`Importar` mueven la configuración como archivo JSON.

### Cómo se prueba

| Qué quieres ver | Cómo |
| --- | --- |
| La tabla | Panel **Regalos**: cada fila lleva activo, regalo, cantidad, recompensa, vida, poder, objetivo, enfriamiento, editar y eliminar |
| Editar | **Editar** carga la fila en el formulario; **Guardar fila** / **Cancelar**. **+ Añadir regalo** crea una nueva |
| Eliminar | La **×** convierte la fila en «¿Eliminar «Rosa»? Sí / No» (confirmación de la aplicación, sin diálogos del navegador) |
| Un regalo concreto | «Enviar regalo simulado»: participante, regalo, cantidad y **Enviar regalo** (o **Repetir**, o **×5 rápido**) |
| El resultado | Debajo: contadores, progreso de los acumulados y el historial con donador, regalo, recompensa, poder, objetivo, daño, vida y enfriamiento |
| La cola | Ponle enfriamiento a `Corona`, envía dos veces y mira «En cola» y el aviso del evento |
| Guardar de verdad | **Guardar**, recarga la página (`F5`) y comprueba que sigue |

---

## Los diez poderes (orden 04)

**Diez poderes de ataque**, uno por diseño, atados al `disenoId` como *firma* del
participante. **Los puede usar cualquiera**: cada participante lleva los diez, cada uno
con su propio enfriamiento, así que se puede lanzar cualquiera sobre cualquiera. Eso es
justo lo que hará falta en la fase siguiente, cuando un regalo tenga que disparar un
poder sobre el espectador que lo manda.

Todos se dibujan con Canvas 2D —gradientes, líneas, polígonos, espirales, rayos, ondas,
campos y deformaciones— y lo único que sigue siendo una imagen es la foto del
participante.

| # | Diseño | Poder | Clase | Duración | Enfr. | Alcance | Daño | Qué hace |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 01 | Ataque radial | **Filo Radial** | golpe | 2,6 s (carga 0,6) | 8 s | 200 | 34 por golpe | Seis filos de energía, embestida corta, +50 % de crucero y ×1,7 de daño de contacto, cortes luminosos al impactar |
| 02 | Defensa orbital | **Martillo Orbital** | área | 1,3 s (carga 0,7) | 9 s | 230 | 32 por martillo | Cuatro martillos que salen en cruz; cada uno golpea su abanico de 70° y empuja |
| 03 | Balance doble | **Onda de Rebote** | cadena | 0,9 s (carga 0,55) | 8 s | 340 | 40 / 25 / 15 | Una onda morada que salta de un rival a otro, perdiendo fuerza en cada salto |
| 04 | Velocidad espiral | **Espiral Cortante** | movimiento | 4,5 s (carga 0,4) | 9 s | a su paso | 14 cada 0,35 s | Corre con el crucero a ×1,5 y **corta a todo el que pasa cerca**, dejando estela cian |
| 05 | Eléctrico | **Descarga Eléctrica** | cadena | 0,9 s (carga 0,55) | 8,5 s | 520 | 70 / 43 / 27 | Rayo al rival más cercano que salta hasta tres veces, con chispas y fogonazo |
| 06 | Volcánico | **Explosión Volcánica** | área | 0,5 s (carga **1,4**) | 11 s | 260 | 55 en el centro | Aviso largo con grietas encendidas y el radio marcado, explosión de área y empuje radial |
| 07 | Cristal | **Cristal de Impacto** | proyectil | 1,15 s (carga 0,65) | 9 s | 330 | 38 + 6 × 7 | Carga un **cristal grande** (1,5 × el radio del trompo, facetado y con estela), lo lanza como proyectil y **al impactar** —contra un rival o contra la pared— revienta en 6 esquirlas en abanico |
| 08 | Sombra | **Golpe Umbrío** | embestida | 1,4 s (carga 0,5) | 8,5 s | 300 | 46 + ×2,4 al contacto | Se desliza hacia el rival más cercano con el cuerpo oscurecido y **pega el doble** al chocar |
| 09 | Viento | **Ráfaga Cortante** | área | 3 s (carga 0,5) | 9 s | 280 | 11 cada 0,3 s | Corriente circular que **arrastra hacia dentro** y corta con pulsos, con la dirección marcada |
| 10 | Cósmico | **Colapso Estelar** | área | 4 s (carga 0,6) | 12 s | 340 | 9 cada 0,3 s | Gravedad dorada que atrae, frena y aprieta a quien esté dentro del radio; se disipa al final |

> **Sin poderes defensivos.** La primera versión tenía escudo, armadura y contragolpe;
> se cambiaron por martillos, esquirlas y onda de rebote: ahora los diez pegan, cambian
> lo que cambian.
>
> **Ajuste del rosa (aprobado).** La Lluvia de Esquirlas se sustituyó por el **Cristal
> de Impacto**: un proyectil grande y facetado que se rompe **sólo al chocar**. El
> presupuesto de daño no sube (antes 3 × 26 = 78; ahora 38 + 6 × 7 = 80, con tope de 80
> por activación y sin que dos fragmentos puedan golpear al mismo rival). El azul
> (Martillo Orbital) y el morado (Onda de Rebote) se conservan: sólo se les mejoró la
> lectura —los martillos salen en cruz fija con destello en cada punta, y los tres saltos
> morados van 40 → 25 → 15 con el trayecto y el pulso cada vez más finos.

### Los cuatro momentos

1. **Carga** — chapa con el nombre del poder, aro que se llena, aura que sube, sonido de
   aviso. Todos los poderes de daño avisan antes de pegar: el volcánico, 1,4 s.
2. **Activación** — el efecto principal: filos, escudos, espiral, rayo, explosión,
   facetas, velo, corriente, campo.
3. **Efecto** — lo que le pasa a los demás: daño (con número flotante del color del
   poder), empuje, absorción, desvío o velocidad.
4. **Finalización** — las partículas se disipan, el aura baja, el aro se apaga, suena el
   final y empieza el **enfriamiento** (con la cuenta atrás en la chapa).

### Cómo se prueba cada poder

| Qué quieres ver | Cómo |
| --- | --- |
| Cada poder por separado | Panel **Poderes** → botón del poder (o **Mayús + 1…0**). Se lanza en el participante elegido en «Identidad» |
| Un poder en un participante concreto | Elige el participante en «Identidad» y pulsa el poder; o `PROTOTIPO.activarPoder(id, "electrico")` desde la consola |
| Que cualquiera pueda usar cualquiera | Elige un participante y lanza los diez seguidos: `PROTOTIPO.reiniciarPoderes()` entre uno y otro. El banco lo comprueba con los diez en el mismo |
| El del que va primero | Botón **Poder del líder** (o la tecla **z**) |
| Preparación, activación, efecto y final | Se ve en el lienzo: aro de carga → efecto → disipación → aro de enfriamiento. En el panel, la lista dice el estado y los segundos que quedan, y cada participante lleva sus diez enfriamientos |
| Encadenar todos | Botón **Demostración automática** (o **x**): un poder cada 1,7 s, rotando el catálogo y respetando enfriamientos. La misma semilla repite la misma secuencia (comprobado por el banco) |
| Que no se rompa la física | Casilla **Hitboxes y límites** mientras lanzas poderes: nadie sale de la arena y la velocidad no pasa del tope |
| Sin música ni saturación | Los doce sonidos de poder entran por el limitador: 12 sonidos por segundo como mucho y cada uno con su tiempo mínimo |

### Límites que respeta

* **Nada de velocidad infinita**: el multiplicador se acota a ×1,6 y el tope de la arena
  (1500 px/s) sigue mandando; el empujón de la embestida también se recorta.
* **Nada de daño infinito**: el daño de un poder se limita al **22 % de la vida máxima**
  por golpe, y lleva la protección de poderes (0,25 s).
* **Nadie sale de la arena**: todo empuje o arrastre pasa por `empujar()`, que acota la
  fuerza y recorta la velocidad; la física encajona a los trompos cada paso. Comprobado
  con la demostración en las cuatro cantidades: 0 saltos, 0 fuera.
* **Nada de cadenas infinitas**: el rayo y la onda de rebote saltan como mucho tres veces.
* **Nada de acumularse**: un poder por trompo a la vez, con **un enfriamiento por poder**
  (los otros nueve siguen disponibles); si el dueño cae, el poder se corta y su clave
  entra en enfriamiento (nada queda congelado en «activo»).
* **Nada tapa la información**: los efectos grandes van **detrás** de los cuerpos y los
  del frente justo después, pero **siempre por debajo de las etiquetas**, así que el
  medallón, el arco de vida y el nombre no se tocan. El banco lo comprueba dibujando el
  mismo fotograma con y sin efectos y comparando el recorte del medallón: sale idéntico.

---

## La identidad (orden 03)

Cada trompo representa a una persona, y la persona es un dato:

```js
{
  id, nombre, foto, inicial, color, disenoId, variante,
  vidaMaxima, vidaActual, estado, posicion, eliminaciones, danioRealizado
}
```

La ficha la lleva `Participante` (`js/participantes.js`) y el trompo apunta a ella:
`trompo.participante`. La pieza física guarda posición, velocidad y vida; la identidad
guarda quién es, cómo se llama, su foto y su estado de batalla, que se sincroniza en
cada refresco de la clasificación (30 veces por segundo).

### Cómo se asignan los nombres, las fotos y los diseños

* **Nombres**: de una plantilla simulada de **44 identidades** (`PLANTILLA`). Los diez
  primeros son los de la orden 01. Se juega con los `N` primeros: con 10, esos diez;
  con 40, los cuarenta primeros. **No hay trompos de relleno**: si hay menos
  participantes, la arena tiene menos trompos.
  Hay casos metidos a propósito: **un nombre largo** (María de los Ángeles Fernández),
  **dos personas con el mismo nombre** (dos Carlos, con identidad distinta), **uno sin
  foto**, **uno con la foto rota** (`fotos/falta-99.png`, que da 404) y **uno con foto
  panorámica** (240×96).
* **Fotos**: `generar-fotos.mjs` escribe 44 retratos de 96×96 y una panorámica con un
  codificador PNG propio (sin dependencias). Son caras geométricas originales, no
  assets de terceros. El prototipo las carga con un `<img>` de verdad desde `fotos/`,
  así que el camino de carga, el de error y el de recorte son los reales.
* **Colores**: uno por participante, repartidos por el círculo cromático
  (`hsl(i × 137,508°, 62 %, 52 %)`), el mismo que usa el generador de fotos, así que el
  fondo y el borde de la foto coinciden con el color del jugador.
* **Diseños**: `ORDEN_DISENOS[i % 10]`, fijo para cada identidad. Con 10 participantes
  salen los diez una vez; con 40, cada diseño sale cuatro veces.
* **Variantes**: la repetición del mismo modelo se ve como **variante**: el mismo
  nombre de diseño y la misma geometría base, con un tinte hacia el color del jugador
  (16 %, 32 %, 48 %) y **una órbita de más** por variante. Cuatro copias del mismo
  diseño no parecen cuatro trompos iguales, y en la tabla se lee «· variante 2».

### La foto, en el núcleo

* Va en un **medallón dentro del núcleo**, con **máscara circular**, recorte *cover*
  centrado (no se deforma y el centro —la cara— siempre se ve, sea cuadrada o
  panorámica) y **borde del color del jugador**, con un aro oscuro fino que lo despega
  del cuerpo.
* Radio = **0,48 × radio del trompo** (mínimo 15 px): **40 px de diámetro con diez
  participantes y 33 px con cuarenta**. Queda justo por dentro del anillo interior del
  diseño (0,53–0,65), así que por fuera siguen viéndose el patrón, las palas y las
  grietas de daño, que van del 0,83 al 1,13 del radio.
  *Empezó en 0,36 y se subió al comprobar en pantalla que las caras se veían pequeñas.*
* Se dibuja **sin girar** con el trompo: una cara dando vueltas no se reconoce. Por eso
  la identidad se pinta en la pasada de etiquetas, después de los cuerpos.
* El medallón **no es un sprite del trompo**: el cuerpo se sigue generando por código.
  Lo único que se guarda es la foto ya recortada en un lienzo aparte (caché por foto,
  tamaño y estado: recortar 40 fotos por fotograma costaba la mitad del rendimiento).
* **Si la foto no carga** (404, formato roto, sin red) o **no hay foto**: se pinta la
  **inicial** en blanco sobre el **color del jugador**, dentro del mismo aro. Nunca
  queda un hueco vacío ni se rompe el dibujo. Lo mismo hace la tabla del taller con su
  `<img>`: si falla, se esconde y se ve la inicial.
* Para juzgar el tamaño sin ampliar capturas está **`identidad.html`**: la lámina con
  todos los participantes y el medallón a 43 px de radio.

### Nombres

* **Pocos jugadores** (≤ 14): placa de 44 px de alto con el nombre completo.
* **Muchos** (> 14): etiqueta compacta (32 px) y el nombre acortado con puntos
  suspensivos si no cabe en 155 px. **El nombre completo no se pierde**: sigue en los
  datos, en la tabla del taller (fila completa) y en el `title` de cada fila.
* Se mantienen la prioridad y el anti-solape de la orden 02 (líder → golpeado →
  muriendo → atacante → resto).

### Entradas y salidas (simuladas)

* **Añadir**: entra un participante nuevo por un **sitio libre** (se prueban 60
  posiciones y se elige la más lejana al vecino más próximo), con su aparición breve,
  sin reiniciar la batalla (los choques siguen contando) y con la tabla recalculada.
* **Quitar**: sale con el mismo fade que una eliminación, pero **no cuenta como baja de
  nadie**: se registra el motivo («retirado a mano desde el taller») en un historial
  aparte y el cartel dice «X SALE DE LA ARENA».
* **Cambiar** nombre, foto, diseño o variante: se aplica en caliente, sin reiniciar. El
  radio y la masa se recalculan (cada diseño tiene los suyos); el ataque y la defensa se
  quedan como estaban para no alterar la pelea en curso.

### Casos límite

| Caso | Qué pasa |
| --- | --- |
| 0 participantes | La ronda se queda en «ESPERANDO PARTICIPANTES · 0 en la arena», sin ganador y sin errores; la tabla se vacía |
| 1 participante | Igual: no se declara ganador a quien está solo (hacen falta dos) |
| 2 participantes | La ronda funciona con normalidad |
| Nombre larguísimo | Se acorta en pantalla, entero en los datos |
| Dos con el mismo nombre | Conviven: distinto `id`, distinto color, misma etiqueta |
| Foto con otra proporción | Recorte centrado, sin deformar |
| Diseño repetido | Variante: tinte distinto y una órbita más |
| Sin foto / foto rota | Inicial sobre el color del jugador |

---

## La escala (orden 02)

El radio de un trompo es `radioBase × escala(participantes) × radio del diseño`.
`radioBase` es 84 px (el tamaño de la orden 01) y la escala sale de una tabla con
interpolación lineal:

| Participantes | Escala | Radio resultante | Modo de etiqueta |
| --- | --- | --- | --- |
| 10 | 0,50 | **42 px** (la mitad) | completa (inicial + nombre + vida) |
| 20 | 0,46 | 38,6 px | compacta |
| 30 | 0,43 | 36,1 px | compacta |
| 40 | 0,41 | 34,4 px | compacta |

La escala se aplica a **todo** lo que depende del tamaño: radio físico y de colisión
(son el mismo), plato, palas, anillos, patrón, núcleo, aura, órbitas, rastro, grietas
y sombra. Los **efectos** llevan su propia escala (`escalaEfectos` = escala / 0,5 con
suelo 0,7: chispas, ondas y fogonazos) y las **etiquetas** la suya
(`escalaEtiqueta` = escala / 0,5 con suelo 0,62, ×0,88 en modo completo y ×0,78 en
compacto), porque a la mitad de tamaño un nombre de 30 px se comería el doble de ancho
que su trompo.

Los **trazos** (grosor de líneas y anillos) no se encogen con el radio a propósito: a
tamaño pequeño una línea de 1 px desaparece y la orden pide que las formas sigan
reconociéndose.

### Calibración del daño

Dos ajustes, medidos con `node banco-fisica.mjs`:

1. **Orden 02**: con los trompos a la mitad, la sección de choque baja y con diez
   participantes hay la mitad de impactos por segundo; la ronda se iba a 73 s.
   `danio.factorPorParticipantes` compensa eso para que la ronda dure parecido con diez
   que con cuarenta.
2. **Orden 05**: la arena se puso **más pausada** (`velocidadCrucero` 480 → 400 px/s,
   salida 430/680 → 350/560) y los golpes **más suaves** (`danio.escala` 0,12 → 0,085,
   `umbral` 80 → 100, `minimo` 14 → 11), y la presión que cierra las rondas pasa a
   empezar a los 55 s (34 s con cuarenta) con el reloj de seguridad en 180 s. Las rondas
   pasaron de ~45 s a ~78 s de mediana.

| Participantes | Radio | Batalla (mediana) | Velocidad media | Choques por ronda | Bajas |
| --- | --- | --- | --- | --- | --- |
| 10 | 42 px | 86,2 s (69,3–144,6) | 368 px/s | 155 | 9 de 9 |
| 20 | 38,6 px | 74,2 s (59,7–99,8) | 362 px/s | 386 | 19 de 19 |
| 30 | 36,1 px | 72,8 s (46,3–107,6) | 360 px/s | 666 | 29 de 29 |
| 40 | 34,4 px | 80,2 s (64,4–96,5) | 358 px/s | 1035 | 39 de 39 |

Ocho rondas por cantidad, 0 decididas por el reloj, 0 trompos fuera de la arena,
0 solapes al nacer, velocidad media 358–368 px/s (crucero 400) y menos del 0,2 % de
trompo-muestras casi paradas.

---

## Zonas reservadas

Los trompos rebotan contra **la arena**, no contra el lienzo, así que ni la tabla ni
los carteles tapan la pelea:

```
   y=16   ┌───────────────────────────────────────────┐
          │ CLASIFICACIÓN (5 filas + resumen)         │  238 px
   y=254  └───────────────────────────────────────────┘
   y=258  ┌───────────────────────────────────────────┐
          │                                           │
          │              ARENA Y COMBATE              │  1432 px
          │              928 × 1432 px                │
   y=1690 └───────────────────────────────────────────┘
          │ carteles de eliminación · avisos · victoria│  230 px
   y=1920 └───────────────────────────────────────────┘
```

* **Arriba**: `clasificacion` (posición, inicial, nombre, barra y % de vida, estado).
  El primero va con fondo dorado, borde y «1.º»; las cinco primeras filas enteras y el
  resto resumido en «+N participantes más». Se refresca 30 veces por segundo.
* **En medio**: la arena, con 76 px de margen lateral, 258 por arriba y 230 por abajo.
* **Abajo**: carteles de eliminación (hasta dos, apilados desde abajo), avisos de
  nuevo líder (franja alta, pegados al borde de la arena) y el cartel de victoria.

El orden de la clasificación es: **vida actual → daño hecho → eliminaciones →
identificador** (para desempatar). Todo el azar sale de la semilla, así que el orden
también es reproducible.

---

## Etiquetas

* **Pocos participantes** (≤ 14): placa con el hueco punteado de la inicial o foto
  futura, el nombre completo, el arco de vida y las eliminaciones a la derecha.
* **Muchos** (> 14): etiqueta compacta —sólo el nombre, más pequeña— y la **inicial
  dentro del núcleo** del trompo. El nombre completo sigue estando siempre.
* **Prioridad y anti-solape**: primero el líder, después el que acaba de recibir un
  golpe (1,3 s), el que se está muriendo, el que pegó (1 s) y por último el resto. Una
  etiqueta que pisaría a otra ya colocada no se dibuja, salvo que tenga prioridad. Con
  cuarenta participantes se dibujan las 40 etiquetas porque el modo compacto las hace
  caber; cuando el amontonamiento aprieta, el banco informa de cuántas se omitieron.
* El **arco de vida** se dibuja siempre, para todos: es el indicador principal.

---

## El daño se lee

Cada choque hace cinco cosas a la vez, para que se entienda sin mirar la tabla:

1. separa e impulsa los trompos (física, siempre);
2. **resta vida** con la fórmula de siempre y reduce el **arco de vida**;
3. saca un **número flotante** con el daño en el punto de impacto (a partir de 9);
4. crea **chispa en el punto de contacto** y un **destello** corto;
5. **registra quién a quién**: cada trompo guarda su daño hecho, su daño recibido, a
   quién golpeó y quién le golpeó, y la tabla se reordena.

Estados de vida: **alta** (anillo completo, aura estable, pocas partículas), **media**
(anillo a media asta, parpadeo ligero, grietas y más chispas), **baja** (anillo muy
reducido, grietas visibles, aura inestable, bamboleo, chispas de avería y parpadeo
controlado) y **cero** (se rompe el aura, sale despedido, explota en partículas y se
desvanece en 0,9 s).

---

## Sonido

Ocho efectos sintetizados con osciladores y ruido filtrado, sin archivos:
`inicio`, `cuenta`, `choqueLeve`, `choqueFuerte`, `dano`, `eliminacion`, `lider` y
`victoria`.

* **Cómo se activa**: el navegador no deja sonar nada hasta que el usuario toca la
  página, así que el `AudioContext` se crea con el **primer clic o la primera tecla**
  (el panel lo dice: «audio sin desbloquear · toca la página»).
* **Silencio**: la casilla «Sonido» o el botón «Silenciar» (la tecla `s`). Silenciado
  no se crea ni un nodo.
* **Volumen**: el deslizador, de 0 a 100 %, sobre un `GainNode` maestro.
* **Limitador**: cada sonido tiene su tiempo mínimo entre repeticiones y hay un tope
  global de 12 por segundo; los importantes (eliminación, victoria, líder, inicio,
  cuenta) se saltan el tope global. Medido: de 60 choques seguidos suenan 1 y se
  descartan 59.
* Las intensidades cambian según el golpe: un roce suena leve; a partir de 26 de daño
  suena fuerte y, por encima del doble, se añade el golpe de «daño importante».

---

## La física, en corto

Cada paso (paso fijo de **1/120 s**) hace, en este orden:

1. **Empuje de crucero.** Cada trompo tiende a su velocidad de crucero (480 px/s) por
   un control proporcional, con el rumbo paseando solo y algo de ruido. Es lo que
   mantiene la pelea en marcha.
2. **Roce exponencial** (`v *= e^(-roce·dt)`), independiente del tamaño del paso.
3. **Integración** y **rebote contra las paredes de la arena**. Al rebotar, el rumbo se
   apunta hacia dentro para que nadie se quede pegado al borde.
4. **Choques por parejas** (una pasada que resuelve todo, más una segunda que sólo
   desenreda, para que con cuarenta trompos no queden solapes):
   separar por masa inversa → medir la velocidad relativa *antes* de separar → impulso
   con restitución 0,94 → roce tangencial que se vuelve giro → daño:
   `(mínimo + exceso × escala × presión × calibración) × ataque ÷ defensa × √masa`.
5. **Límite de velocidad** (1500 px/s) y **encajonado** en la arena.
6. **Averías**: desgaste continuo y **protección** de 0,17 s por golpe, para que un
   amontonamiento no cuente como cinco choques en el mismo instante.
7. **Presión de tiempo**: el daño sube hasta ×2 para que ninguna ronda se eternice; si
   el choque final matase a los dos, se queda en pie el que recibió menos daño en
   proporción (y le queda un 1 % de vida).

**Estabilidad.** Paso fijo con acumulador (misma batalla a 30 que a 144 fps), `dt`
limitado a 0,25 s y 8 pasos por fotograma: si el navegador se atrasa se pierde tiempo
de simulación, nunca se da un salto.

**Reproducibilidad.** Todo el azar sale de la semilla (mulberry32). La física y los
efectos llevan **flujos separados**: se puede cambiar el dibujo sin que la pelea se
mueva ni un choque.

**Rendimiento.** Medido con 40 participantes, todas las capas encendidas, las fotos
cargadas y ~470 partículas: **35 fps** en la ventana del banco —con el panel y la tabla
de 40 filas con foto al lado— y **58 fps** midiendo sólo el lienzo; 7,1 ms por fotograma
de dibujo. En el peor caso posible (SwiftShader, sin GPU) baja a ~20 fps. Con 10–30
participantes va a 60 fps. Tres optimizaciones que costaron medidas: los rastros se
dibujan agrupados por diseño (30 trazos en vez de 120), con el trompo pequeño se ahorran
la sombra de apoyo y los gajos del plato, y **los medallones de foto se recortan una vez
y se guardan** (recortar 40 fotos por fotograma se llevaba la mitad del rendimiento).

> **Aviso para quien mida**: `getImageData` (leer píxeles del lienzo) desactiva la
> aceleración del canvas en Chrome y a partir de ahí los fps caen a la mitad. El banco
> mide el rendimiento en una pestaña **recién cargada**, después de todas las lecturas
> de píxeles.

---

## Los diez diseños

Cada uno cambia la **geometría**, no el color: número y forma de palas, lados y
estilo del anillo, patrón, núcleo, número de anillos orbitando y adorno propio.

| # | Diseño | Palas | Anillo | Patrón / núcleo | Ataque | Defensa | Masa |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 01 | Ataque radial (rojo) | 6 filos | 12 lados con muescas | radial / círculo | 1,35 | 0,88 | 0,98 |
| 02 | Defensa orbital (azul) | 4 escudos | 8 placas | orbital / hexágono | 0,86 | 1,42 | 1,22 |
| 03 | Balance doble (morado) | 2 hojas dobles | 8 lados doble | espejo / estrella | 1,10 | 1,12 | 1,02 |
| 04 | Velocidad espiral (cian) | 5 aletas barridas | 24 lados discontinuo | espiral / espiral | 1,18 | 0,84 | 0,82 |
| 05 | Eléctrico (amarillo) | 3 rayos | 9 lados cortado | zigzag / rayo | 1,28 | 0,92 | 0,94 |
| 06 | Volcánico (naranja) | 8 rocas | 7 lados roca | grietas / lava | 1,24 | 1,05 | 1,16 |
| 07 | Cristal (rosa) | 6 facetas | 5 lados facetas | facetas / cristal | 1,14 | 0,98 | 0,90 |
| 08 | Sombra (violeta oscuro) | 4 guadañas | 10 lados difuso | humo / ojo | 1,30 | 0,95 | 0,96 |
| 09 | Viento (verde) | 3 crecientes | 16 lados segmentos | plumas / aspas | 1,06 | 0,90 | 0,86 |
| 10 | Cósmico (blanco y dorado) | 5 brazos de estrella | 12 lados doble | orbes / astro | 1,20 | 1,18 | 1,08 |

---

## Parámetros ajustables

Todos en `js/parametros.js`, agrupados. Los que de verdad mueven la aguja:

| Grupo | Parámetro | De fábrica | Qué hace |
| --- | --- | --- | --- |
| `lienzo` | `margenLados` / `margenArriba` / `margenAbajo` | 76 / 258 / 230 | Zonas reservadas: tabla, arena y carteles |
| `fisica` | `velocidadCrucero` | 400 px/s | **El parámetro de la acción**: a más crucero, más choques y rondas más cortas (480 antes del ajuste de la orden 05) |
| | `empujeCrucero` / `giroRumbo` / `jitter` | 1,3 / 0,55 / 60 | Cómo recupera el crucero, cuánto pasea el rumbo, cuánto ruido |
| | `roce` / `rebotePared` / `reboteChoque` | 0,05 / 0,92 / 0,94 | Roce y restitución |
| | `correccion` / `holgura` / `pasadasChoques` | 0,85 / 0,4 / 2 | Separación de solapes (la segunda pasada desenreda) |
| `trompo` | `radioBase` | 84 px | Radio de referencia del dibujo |
| | `escalaPorParticipantes` | 10→0,50 … 40→0,41 | **La escala de la orden 02** |
| | `rapidezMinima` / `rapidezMaxima` | 430 / 680 | Velocidad de salida |
| | `giroMinimo` / `giroMaximo` / `desvio` | 12 / 18 / 0,08 | Giro y variación por participante |
| `danio` | `umbral` / `minimo` / `escala` | 100 / 11 / 0,085 | Daño por velocidad de cierre (antes 80 / 14 / 0,12) |
| | `proteccion` / `desgaste` | 0,17 s / 3 | Invulnerabilidad y desgaste |
| | `presionDesde` / `presionMaxima` | 55 s / ×2 | Subida de daño para cerrar rondas (40 s antes del ajuste) |
| | `factorPorParticipantes` | 1,45 … 1,5 | Calibración para que la ronda dure parecido con 10 que con 40 |
| `vida` | `inicial` / `alta` / `baja` | 1800 / 0,66 / 0,33 | Vida y umbrales de aspecto |
| `etiquetas` | `umbralCompactas` | 14 | Cuándo se pasa a etiqueta compacta |
| | `escalaNormal` / `escalaCompacta` / `escalaMinima` | 0,88 / 0,78 / 0,62 | Tamaño del texto |
| | `anchoMaximo` / `anchoMaximoCompacta` | 260 / 155 px | Ancho máximo de la placa: si el nombre no cabe, se acorta |
| | `prioridadGolpe` / `prioridadAtaque` / `evitarSolapes` | 1,3 / 1 / sí | Prioridad y anti-solape |
| `fotos` | `medallon` / `medallonMinimo` | 0,48 / 15 px | Tamaño del medallón de identidad en el núcleo (40 px de diámetro con diez, 33 con cuarenta) |
| | `grosorAro` / `separacion` | 3 / 1,6 px | Aro del color del jugador y aro oscuro de separación |
| `poderes` | `activo` | sí | Enciende o apaga todos los poderes |
| | `verIndicadores` / `verEfectos` | sí / sí | Chapas y aros · efectos grandes (apagarlos deja el lienzo como si no hubiera poderes) |
| | `empujeMaximo` | 560 px/s | Tope del empujón que puede dar un poder |
| | `aceleracionMaxima` | 420 px/s² | Tope de los campos (atracción del cósmico, viento) |
| | `velocidadMaximaFactor` | 1,6 | Tope del multiplicador de crucero |
| | `danioMaximoPorGolpe` | 0,22 | Fracción de la vida máxima que puede quitar un poder de una vez |
| | `proteccionPoder` | 0,25 s | Invulnerabilidad tras un daño causado por poder |
| | `cadenaMaxima` | 3 | Saltos máximos del rayo |
| | `enfriamientoGlobal` | 0,45 s | Freno entre dos activaciones distintas |
| | `demo.activa` / `demo.intervalo` | no / 1,7 s | Demostración automática y su cadencia |
| `poderes.*` (por poder, en `js/poderes.js`) | `carga` / `duracion` / `final` | 0,4–1,4 / 0,5–6 / 0,6–1,2 s | Los cuatro momentos |
| | `enfriamiento` | 7–12 s | Cuánto tarda en volver a estar listo |
| | `alcance` / `danio` | 0–520 / 0–70 | Área y daño base |
| | `modificadores` | velocidad, danioContacto, defensa, esquiva | Lo que cambia mientras está activo |
| `clasificacion` | `filas` / `altoFila` / `altoResumen` | 5 / 36 / 22 | Geometría de la tabla del lienzo |
| `efectos` | `particulasMaximas` / `ondasMaximas` | 1200 / 48 | Topes (lo viejo se descarta) |
| | `chispasChoque` / `chispasExplosion` / `energiaPorSegundo` | 22 / 90 / 12 | Partículas |
| | `numerosDanio` / `numeroMinimo` / `numerosMaximos` | sí / 9 / 26 | Números de daño |
| | `escalaAuraMuchos` / `umbralAuraMuchos` | 0,78 / 22 | Recorte del aura con mucha gente |
| `sonido` | `activo` / `volumen` | sí / 0,6 | Sonido y volumen maestro |
| | `maxPorSegundo` / `umbralFuerte` | 12 / 26 | Limitador global y umbral de «choque fuerte» |
| `simulacion` | `participantes` | 10 | Cuántos saltan a la arena (10, 20, 30 o 40) |
| | `semilla` | 20260214 | Todo el azar depende de aquí |
| | `espera` / `aparicion` / `cuenta` / `batallaMaxima` | 1,2 / 1,1 / 3 / 180 | Fases (el tope de batalla subió de 90 a 180 al alargar las rondas) |
| | `liderAvisoDesde` / `liderVentaja` | 6 s / 1,06 | Cuándo se anuncia un nuevo líder |
| `aspecto` | `verNombres` / `verTabla` / `verParticulas` / `verOrbitas` / `verRastro` | — | Capas encendibles |
| | `verRadios` / `verLimites` | — | Hitboxes |
| | `calidad` | 1 | 0,6 = menos partículas |

---

## Cómo se comprueba

```bash
node banco-fisica.mjs                       # 10, 20, 30 y 40 en Node, sin navegador
node banco-fisica.mjs --rondas 12           # más rondas por cantidad
node banco-fisica.mjs --participantes 40    # sólo una cantidad
node banco-fisica.mjs --variantes           # compara juegos de parámetros
node banco.mjs                              # abre Chrome, mide, captura y cierra
```

`banco.mjs`: **117 de 117 comprobaciones**, entre ellas

* el lienzo mide 1080 × 1920, el alfa de las cuatro esquinas es 0 y las tres zonas
  reservadas están donde deben;
* con diez participantes el radio es **42 px** (la mitad de la orden 01) y con 40 baja a
  **34,4 px**, sin que los diseños dejen de reconocerse;
* en las cuatro cantidades: nadie fuera de la arena, todos chocando, ninguno pegado a
  una esquina y **las 40 etiquetas dibujadas** (modo compacto a partir de 20);
* **el sobre del motor se normaliza** al evento interno con todos sus campos, y lo que no
  es un regalo atribuible se descarta y se cuenta (sin inventar donador);
* **un regalo de vida real va al donador correcto** (400 → 900) y a nadie más;
* **un regalo de poder real se lanza desde el trompo del donador** sea cual sea su diseño
  (diseño de ataque, firma *Filo Radial*, lanzó *Onda de Rebote* y golpeó a Juan);
* **tres Estrellas y luego dos** disparan la recompensa de cinco y no se pierde ninguna;
* **el mismo evento dos veces** no vuelve a dar vida (500, no 1500) y se cuentan los
  duplicados ignorados;
* **una racha 1 → 3 → 5** aporta 5 unidades, no 9, y el cierre no suma;
* **un poder en enfriamiento** desde un evento espera en la cola y sale al quedar libre;
* **un regalo no configurado** se registra, se lista para configurarlo y, al añadirlo a la
  tabla, el siguiente evento ya se aplica;
* **un usuario nuevo** entra con su identidad, su diseño, 1800 de vida y a más de dos
  radios del más cercano, y **cambiar de nombre no crea otro participante**;
* **con 40 dentro el siguiente queda EN ESPERA** sin perder su regalo y entra al liberarse
  un sitio (39 dentro + 40 eventos → 1 dentro y 39 en espera);
* **la reconexión** no reinicia la batalla, no pierde nada y no duplica eventos;
* **el modo simulado y el real no procesan dos veces el mismo evento**;
* **el puente del servidor** acepta el evento por HTTP, lo normaliza, no encola duplicados
  y el juego lo aplica;
* **ningún secreto** (cookie, token, clave) en el estado, las identidades ni el historial;
* con 10, 20, 30 y 40 participantes los regalos reales llegan a su donador sin romper la
  física (0 fuera, 0 saltos) y **la misma semilla sigue dando la misma batalla**;
* hay **diez poderes de ataque**, uno por diseño, con nombre, color, icono, tiempos,
  alcance, daño, modificación y sonido propios; los diez son distintos entre sí y
  ninguno se limita a defender;
* **los diez se pueden lanzar en el mismo participante** (Mariana lanzó los diez), cada
  poder con su propio enfriamiento, y después de esperar vuelve a tener 10/10 listos;
* un poder recorre **carga → activo → finalizando → enfriando**, y no se puede repetir
  mientras está en marcha;
* ningún poder rompe los topes (velocidad vista 754 px/s con tope 1500; daño por golpe
  acotado al 22 % de la vida) y **nadie sale de la arena** con la demostración en las
  cuatro cantidades;
* los diez se activan a mano y llegan a estar activos, la **demostración automática es
  reproducible** (misma secuencia en dos pasadas, 8 jugadores distintos) y un poder
  puede **eliminar** a alguien, con el poder en el cartel;
* los poderes **no tapan la foto ni los nombres**: el medallón sale con el mismo hash
  con el poder activo que con los efectos apagados, y las 10/10 etiquetas se dibujan;
* con 10, 20, 30 y 40 participantes la demostración no acumula partículas (de ~160 en
  plena tormenta a menos de 35 en reposo) y los enfriamientos vuelven solos a «listo»;
* cada participante tiene la **ficha completa de 12 campos**, color propio y diseño;
  20 participantes dan 20 colores y 10 diseños;
* **38 fotos cargan de verdad** desde `fotos/`, hay 1 con fallo (404) y 1 sin foto, y
  los tres casos se ven en pantalla: medallón con foto, con inicial de respaldo y con
  inicial sobre el color;
* la lámina `identidad.html` pinta a los participantes con el medallón a **43 px de
  radio**, para poder juzgar las caras sin ampliar capturas;
* quitar la foto **cambia el núcleo dibujado** (dos huellas de píxeles distintas): la
  foto se pinta, no se queda en los datos;
* un **nombre largo** se dibuja como «María de los Ángele…» en una placa de 237 px, con
  el nombre entero guardado; **dos Carlos** conviven con identidad distinta;
* los **diseños repetidos** son variantes (mismo modelo, otro tinte y una órbita más);
* un participante **entra** en mitad de la ronda con 195 px de holgura al más cercano y
  sin reiniciar la batalla; **sale** con fade, motivo e historial;
* con **0 y 1 participantes** no se rompe nada y no se declara ganador;
* la tabla ordena por vida, marca al primero con «1.º» y no invade la arena;
* el daño se lee: número en pantalla y registro de quién golpeó a quién;
* hay eliminación con culpable, aviso de nuevo líder (con la cara del líder) y final con
  **un solo trompo en pie**;
* el audio se desbloquea con un clic, suenan los ocho efectos y el limitador descarta
  59 de 60 choques seguidos;
* reiniciar deja los trompos a vida completa y la misma semilla da la misma batalla;
* los controles del taller existen y hacen lo que dicen.

Las capturas se regeneran en `capturas/`:

| Archivo | Qué enseña |
| --- | --- |
| `01-10-participantes.png` … `04-40-participantes.png` | La arena con cada cantidad |
| `05-tabla-posiciones.png` | La clasificación ampliada (5 filas + resumen) |
| `06-dano-visible.png` | Números de daño y quién a quién, ampliado |
| `07-eliminacion.png` | Cartel de eliminación con la cara de quien cae |
| `08-cambio-lider.png` / `08b-…-lienzo.png` | Aviso de nuevo líder (recorte y lienzo) |
| `09-victoria.png` | Cartel de ganador y tabla final |
| `10-taller.png` / `15-taller-40.png` | El taller entero |
| `11-zoom-40-participantes.png` | Ampliación con 40 para juzgar la legibilidad |
| `12-limpio.png` | El modo `?limpio=1` (como iría a OBS) |
| `13-disenos.png` / `14-disenos-pagina.png` | La lámina de los diez diseños |
| `16-identidad-10.png` / `18-identidad-40.png` | El lienzo con las fotos cargadas |
| `17-zoom-medallones.png` | Los medallones ampliados (10 participantes) |
| `19-zoom-fotos-40.png` | Los medallones con 40 participantes |
| `20-nombre-largo.png` | Un nombre largo acortado en su etiqueta |
| `21-foto-faltante.png` | El respaldo de inicial (sin foto) en el núcleo |
| `22-tabla-identidad.png` | La clasificación con fotos y variantes |
| `64-conexion-tiktok.png` | La tarjeta de conexión: estado, contadores y eventos de prueba |
| `65-regalo-real-aplicado.png` | Un regalo llegado del bus, aplicado en la arena |
| `66-espectadores.png` | Espectadores reconocidos por `userId` |
| `67-espera-40.png` / `68-espera-panel.png` | La arena llena y la cola EN ESPERA |
| `56-tabla-de-regalos.png` | La tabla de regalos con sus diez campos por fila |
| `57-regalo-de-vida.png` | Un regalo de vida, con el `+500` y las chispas |
| `58-regalo-de-poder.png` | Un regalo que activa un poder sobre el donador |
| `59-historial-de-regalos.png` | El historial de eventos, con donador, poder, objetivo y daño |
| `60-regalo-enfriamiento.png` | El enfriamiento del poder que llegó con el regalo |
| `61-regalo-acumulado.png` | Un regalo acumulado (2/3 en el marcador de progreso) |
| `62-regalos-40-participantes.png` / `63-regalos-40-panel.png` | Regalos con 40 participantes: el lienzo y el panel |
| `23-lamina-identidad-10.png` / `24-lamina-identidad-40.png` | La lámina de identidades con la cara grande |
| `25-identidad-pagina.png` | La página `identidad.html` entera |
| `26-poder-ataque.png` … `35-poder-cosmico.png` | Los diez poderes, uno por captura, con el lienzo entero |
| `36-poder-martillo-orbital.png` | Los cuatro martillos en cruz |
| `37-poder-ataque-filo.png` | Los filos radiales |
| `38-rayo.png` | La descarga eléctrica con sus saltos |
| `39-explosion.png` | La explosión volcánica |
| `40-lluvia-de-esquirlas.png` | **Historial**: la versión anterior del poder rosa (muchas esquirlas pequeñas) |
| `cristal-de-impacto.png` | El cristal grande en vuelo, con su silueta facetada |
| `49-cristal-impacto-10.png` … `52-cristal-impacto-40.png` | El cristal con 10, 20, 30 y 40 participantes |
| `53-cristal-choque-participante.png` | El impacto contra un rival y su onda |
| `54-cristal-choque-pared.png` | El impacto contra la pared, sin nadie a tiro |
| `55-cristal-fragmentacion.png` | La fragmentación, con las esquirlas saliendo en abanico |
| `41-rafaga-cortante.png` | La corriente de viento, que arrastra hacia dentro |
| `42-colapso-estelar.png` | El colapso estelar con sus órbitas |
| `43-enfriamiento.png` | El enfriamiento con la cuenta atrás |
| `44-tabla-durante-poder.png` | La clasificación durante un poder |
| `45-eliminacion-por-poder.png` | Una eliminación causada por un poder |
| `46-golpe-umbrio.png` / `47-onda-de-rebote.png` / `48-espiral-cortante.png` | Los tres poderes que faltaban en detalle |

---

## Criterios de aceptación

### Orden 01

| Criterio | Estado | Medida |
| --- | --- | --- |
| Se abre desde un servidor local | ✔ | `node servidor.mjs` → <http://127.0.0.1:8123/> |
| El lienzo tiene 1080 × 1920 | ✔ | 1080 × 1920 (atributo y píxeles) |
| El fondo es transparente | ✔ | alfa 0 en las cuatro esquinas |
| Aparecen los trompos de la ronda | ✔ | 10, 20, 30 o 40 |
| Los diez diseños son distintos | ✔ | 10 huellas de píxeles únicas |
| Generados por código, sin sprites | ✔ | sólo arcos, polígonos, líneas y degradados |
| Giran, se desplazan y chocan | ✔ | 80–801 choques por ronda según cuántos haya |
| Los impactos restan vida | ✔ | daño proporcional a la velocidad de cierre |
| La vida cambia el aspecto | ✔ | aura, brillo, parpadeo, bamboleo, chispas y grietas |
| Eliminaciones con fade | ✔ | 0,9 s, con explosión y salida despedido |
| Hay ganador y se puede reiniciar | ✔ | 32 de 32 rondas con ganador · misma semilla, misma batalla |

### Orden 02

| Criterio | Estado | Medida |
| --- | --- | --- |
| El tamaño baja a la mitad con 10 | ✔ | radio 42 px (antes 84) |
| Escala adaptable a 20, 30 y 40 | ✔ | 38,6 / 36,1 / 34,4 px, aplicada a radio, aura, efectos y etiquetas |
| Zonas: tabla arriba, arena en medio, mensajes abajo | ✔ | arena de 928 × 1432 en y 258–1690 |
| Se reparten por la arena, no amontonados | ✔ | 0 px de solape al nacer, en las cuatro cantidades |
| Con 30 y 40 no se salen, no se atascan ni se quedan parados | ✔ | 0 saltos · <0,35 % de trompo-muestras paradas · ≤30 % en los bordes |
| Siguen moviéndose y chocando | ✔ | 417–440 px/s de media · hasta 801 choques por ronda |
| La pantalla sigue siendo legible | ✔ | 40 etiquetas dibujadas y diseños reconocibles a 34 px |
| Tabla compacta arriba con posición, inicial, nombre, vida y estado | ✔ | 5 filas + «+N participantes más» |
| La primera posición se destaca | ✔ | fondo y borde dorados, «1.º» y estado LÍDER |
| La tabla no tapa la arena | ✔ | el trompo más alto está 61 px por debajo |
| El daño se ve sin mirar la tabla | ✔ | número flotante, chispa, destello, anillo y registro de culpables |
| Eliminación: termina el movimiento, sale del ranking, fade | ✔ | estado KO, 0,9 s de desvanecido, cartel con culpable |
| Sonidos de inicio, cuenta, choques, daño, eliminación, líder y victoria | ✔ | los ocho suenan y se distinguen |
| Silencio, volumen y desbloqueo tras la primera interacción | ✔ | casilla, deslizador y `AudioContext` «running» tras un clic |
| Sin saturación con muchos trompos | ✔ | 59 de 60 choques seguidos descartados por el limitador |
| La física no se reescribe y sigue siendo determinista | ✔ | paso fijo, acumulador, choques, rebotes, daño y protección intactos |
| Controles del taller completos | ✔ | 10/20/30/40, nombres, tabla, partículas, hitboxes, sonido, reiniciar, hasta el final |

### Orden 03

| Criterio | Estado | Medida |
| --- | --- | --- |
| Cada participante tiene su ficha de datos | ✔ | 12 campos: id, nombre, foto, inicial, color, disenoId, vidaMaxima, vidaActual, estado, posicion, eliminaciones, danioRealizado |
| 10, 20, 30 y 40 participantes con nombre, avatar, diseño, color, vida y posición | ✔ | 20 → 20 colores propios, 10 diseños, 20 posiciones calculadas |
| Foto con máscara circular, sin deformar y con el centro visible | ✔ | recorte *cover* centrado; la panorámica de 240×96 se recorta por el centro |
| Borde del color del jugador | ✔ | el medallón y la placa llevan el color identificador |
| La foto no es el cuerpo del trompo | ✔ | el cuerpo se sigue generando por código; el medallón es 0,36 del radio |
| No tapa el núcleo ni los efectos de daño | ✔ | queda dentro del anillo del núcleo (0,41) y las grietas van en el anillo exterior |
| Si la foto falla: inicial, color y sin hueco | ✔ | 2 fotos con fallo (404) y 3 medallones con inicial pintados en pantalla |
| Nombres visibles y compactos | ✔ | 44 px con pocos, 32 px con muchos; 40 de 40 etiquetas dibujadas |
| Nombres largos acortados sin perder el completo | ✔ | «María de los Ángele…» en 237 px, el nombre entero en los datos y el `title` |
| Prioridad al que recibe daño, ataca o cae | ✔ | líder 6 · golpeado 5 · muriendo 4 · atacante 3 · resto 1 |
| Los diez diseños repartidos; repetidos como variantes | ✔ | mismo nombre y geometría, tinte distinto y una órbita más |
| Con menos de diez, sólo los activos | ✔ | no hay trompos de relleno: con 3 participantes hay 3 trompos |
| La tabla usa los datos reales (foto, nombre, vida, KOs, estado) | ✔ | 5 filas + resumen, con medallón y «· variante N» |
| El primero destaca | ✔ | fondo y borde dorados, «1.º» y estado LÍDER |
| Al recibir daño: vida, posición y tabla | ✔ | la clasificación se recalcula 30 veces por segundo |
| Al ser eliminado: marcado, fuera de activos, con foto en el cartel e historial | ✔ | estado KO, cartel con la cara de quien cae, entrada en `eliminaciones` |
| Controles: añadir, quitar, cantidad, nombre, foto, diseño, reiniciar y misma semilla | ✔ | sección «Identidad» del taller, más los botones de 10/20/30/40 |
| Entrada en mitad de la ronda sin reiniciar y sin caer encima | ✔ | sitio libre con 195 px de holgura, choques y fase intactos |
| Salida con fade, tabla, motivo e historial | ✔ | «retirado a mano desde el taller», historial aparte de las bajas |
| Escala y legibilidad con 40 | ✔ | medallones de 12,9 px, 40 nombres, 35 fps con 473 partículas |
| 0, 1, 2… 40 participantes sin romperse | ✔ | con 0 y 1 se queda esperando y no declara ganador |

### Orden 04

| Criterio | Estado | Medida |
| --- | --- | --- |
| Diez poderes distintos | ✔ | 10 nombres, 10 colores y 10 iconos distintos |
| **Los diez son de ataque** | ✔ | `tipo: ataque` en los diez · clases: golpe, área, cadena, movimiento, proyectil, embestida · daño entre 9 y 70 |
| **El rosa es un cristal grande que se fragmenta al impactar** | ✔ | 0 fragmentos y 0 de daño durante el vuelo; 6 fragmentos tras el impacto |
| **Su daño total no sube** | ✔ | 38 + 6 × 7 = 80 con tope 80 por activación (la Lluvia hacía 78) |
| **Revienta también contra la pared** | ✔ | sin nadie a tiro, el cristal va a la pared y suelta los 6 fragmentos |
| **No mata de un golpe con la vida llena** | ✔ | el golpe más fuerte quita 38 (tope por golpe 396) y no cae ninguno de los 39; con 40 de vida, sí cae |
| **El azul conserva el Martillo Orbital** | ✔ | 4 martillos en rumbos 0, 90, 180 y 270° (cruz fija) con destello en cada punta |
| **El morado conserva la Onda de Rebote** | ✔ | 3 saltos como mucho, a rivales distintos, con daños 40 → 25 → 15 |
| **Los puede usar cualquiera** | ✔ | los diez lanzados por el mismo participante (Mariana, cuya firma es «Onda de Rebote») |
| Cada poder corresponde a un diseño | ✔ | atado al `disenoId` como firma, comprobado contra el catálogo de diseños |
| Cada poder lleva su propio enfriamiento | ✔ | 10 enfriamientos por participante; tras esperar, 10/10 listos |
| Preparación, activación, efecto y finalización | ✔ | un poder recorre `cargando → activo → finalizando → enfriando` |
| Se pueden activar manualmente | ✔ | panel, botón por poder, tecla Mayús+1…0 en el elegido, poder del líder (z) |
| Se pueden probar con una secuencia reproducible | ✔ | demostración automática: misma secuencia en dos pasadas con la misma semilla |
| No ocultan nombres ni fotos | ✔ | el medallón sale con el mismo hash con el poder activo que con los efectos apagados; 10/10 etiquetas |
| No rompen la física | ✔ | paso fijo, acumulador, colisiones, rebotes, protección, semilla y fórmula base intactos |
| No sacan a nadie de la arena | ✔ | empujes y arrastres acotados + encajonado; 0 saltos y 0 fuera con la demostración en las cuatro cantidades |
| Los enfriamientos funcionan | ✔ | no se repite mientras está en marcha y cada clave vuelve a «listo» sola (40/40 con 40 participantes) |
| La misma semilla es reproducible | ✔ | demostración idéntica en dos pasadas y batalla idéntica con la misma semilla |
| Funcionan con 10, 20, 30 y 40 | ✔ | sin fugas de partículas (≤35 en reposo) y ≤0,31 ms por paso de simulación |
| El modo limpio sigue funcionando | ✔ | `?limpio=1` oculta el panel entero: el taller de poderes no aparece |
| No se modifica la aplicación principal | ✔ | `git status` sólo muestra `prototipos/` |

---

## Lo que queda para la siguiente fase

1. **Aprobación visual** de los diez poderes: tiempos, tamaños y si el aviso se entiende.
2. **La tabla regalo → efecto** (la fase siguiente, ya sin TikTok todavía): qué regalo da
   vida, cuál da daño, cuál da defensa y cuál lanza un poder.
3. **Entrada de regalos reales** de TikTok y diamantes, y el reparto entre espectadores.
4. **Fotos reales de TikTok** en el medallón (caché, URL firmadas y recorte de avatares).
5. **Sonido de ambiente y música** (ahora sólo hay efectos) y mezcla con la voz del directo.
6. **Rondas encadenadas** con marcador acumulado entre rondas.
7. **Integración con OBS**: servir el lienzo desde el motor, como las alertas.
8. **Medir en el equipo real** con la cámara emitiendo a la vez (aquí, 32 fps con 40
   participantes y el panel abierto).
