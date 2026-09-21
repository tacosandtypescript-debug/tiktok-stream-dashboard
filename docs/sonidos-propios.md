# Poner tus propios sonidos en las alertas

La aplicación viene con **siete sonidos propios** —campanas, un redoble, una subida— que
suenan sin configurar nada. Esto es para cuando quieras los tuyos: un meme, un latigazo,
la voz de un personaje.

## Lo corto

1. Bájate los ficheros que quieras, donde quieras. Vale `.mp3`, `.ogg`, `.wav` y `.m4a`
   (y para las alertas con imagen, `.png`, `.jpg`, `.gif`, `.webp`, `.apng`, `.mp4` y
   `.webm`).
2. **Arrástralos a la ventana** de la aplicación, en la pestaña **Alertas**. Si sueltas
   la **carpeta entera**, entran todos de golpe.
3. En cada aviso, elige el fichero en **Sonido** y dale a **Oír** para comprobarlo antes
   de que salga en directo.

Los ficheros se **copian** a `%LOCALAPPDATA%\TikTokStreamDashboard\alertas\`. A partir de
ahí puedes mover o borrar los originales: en OBS no se rompe nada, porque lo que se sirve
es la copia.

## Pack de fábrica y medios personales

Los siete sonidos propios y el catálogo actual autorizado para publicar viven en el
repositorio dentro de:

```text
apps/desktop/src-tauri/alertas-pack/
├── imagenes/
└── audio/
```

Ese directorio es un **pack versionado de instalación**, no el almacén que la
aplicación consulta durante el directo. Tauri lo incluye como recurso en la release;
al primer arranque la aplicación lo siembra en AppData de forma no destructiva:

- copia solo los ficheros que todavía no existan;
- no reemplaza un fichero local, aunque tenga el mismo nombre;
- rechaza nombres, extensiones, ficheros vacíos o tamaños fuera de las reglas de
  importación y deja el motivo en el log sin frenar las demás copias;
- puede ejecutarse en cada arranque porque la segunda pasada es idempotente.

La configuración de Alertas sigue guardando **nombres de archivo**, no rutas absolutas.
Por eso los nombres del pack no se renombran al sembrarlos y las referencias existentes
continúan resolviendo la misma biblioteca. El manifiesto `alertas-pack/manifest.json`
registra la ruta relativa, extensión, tamaño y SHA-256 de cada archivo para revisar que
una migración no alteró bytes.

Los medios que importes después desde la pestaña Alertas siguen viviendo únicamente en
AppData. Arrastrar un fichero no escribe en el checkout ni genera cambios Git: el
repositorio es el origen de instalación y AppData es el almacén de uso.

El catálogo actual de imágenes y audios fue autorizado expresamente para publicarse en
este repositorio público. No se borra la copia existente de AppData durante la
migración.

## De dónde sacarlos

- **[myinstants.com](https://www.myinstants.com/)** — el banco de memes más conocido.
  **Bájatelos tú desde el navegador**: la web bloquea el acceso automático, así que la
  aplicación no puede traerlos sola, y sus clips son en su mayoría material con dueño.
  Para tu directo vale; lo que no se puede es repartirlos dentro de la aplicación.
- **[freesound.org](https://freesound.org/)** — busca filtrando por licencia **CC0**: son
  de dominio público y puedes hacer lo que quieras con ellos.
- **Tu propio móvil**: una grabación de tres segundos de algo que suene bien en tu
  directo funciona mejor que cualquier meme prestado.

## Qué buscar, según el aviso

| Aviso | Lo que funciona |
|---|---|
| Regalos (normal) | Corto y discreto, menos de un segundo. Es el que más suena: a la décima vez cansa cualquier cosa |
| Regalos grandes | Algo que se note más que el normal, pero que no pare el directo |
| Regalos enormes | Aquí sí: el momento. Un golpe, una fanfarria, algo que dure |
| Seguidores | Seco y corto, hacia arriba. Suena a «empieza algo» |
| Suscripciones | Un «tachán» breve |
| Compartidos | Casi nada. Sale poco y no debe llamar |
| Likes | El más corto y el más agudo. Puede sonar muy seguido: **si tiene cola, se solapan y es un barullo** |

## Tres cosas que se aprenden a golpes

1. **Corto gana a largo, siempre.** Un clip de meme de ocho segundos está gracioso la
   primera vez y es un estorbo a la hora de directo. Si dudas, corta.
2. **El volumen del fichero no lo controlas tú, pero el de la alerta sí.** Si un sonido
   entra mucho más alto que los demás, bájale el **Volumen** en su aviso en vez de
   normalizar el fichero: así lo puedes cambiar sin volver a editarlo.
3. **Un sonido que dispara mucho cansa antes que un silencio.** Los likes y los regalos
   pequeños pueden dispararse decenas de veces por minuto. Si te molesta, súbele el
   **Mínimo**: por debajo de él no suena.
