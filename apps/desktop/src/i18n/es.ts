//! Textos de la interfaz. Todo en un solo modulo para poder anadir ingles sin
//! refactor (docs/decisions.md D4).

export const t = {
  appName: "TikTok LIVE Dashboard",
  nav: {
    /* «Inicio» y no «Chat»: la pagina dejo de ser solo el chat cuando recibio la
       ficha de perfil y la franja de emision. El nombre tiene que decir lo que hay
       dentro, no lo que habia al principio. */
    chat: "Inicio",
    aportaciones: "Aportaciones",
    alertas: "Alertas",
    overlays: "Overlays",
    tts: "Voz",
  },
  /**
   * Aportaciones: **una sola página** para quién aporta y qué ha caído.
   *
   * Antes eran dos —Regalos y Rankings— y la misma pregunta («quién ha dado más
   * diamantes») se contestaba en tres sitios con dos componentes distintos. Aquí
   * vive una vez: las tablas por persona primero, y el detalle de los regalos
   * debajo.
   */
  aportaciones: {
    title: "Quién aporta",
    hint: "Pulsa un nombre para abrir su perfil de TikTok. Todo lo que se ve son cifras de esta sesión.",
    tap: "Tap tap",
    tapHint: "Puntos que cada persona ha dado tocando la pantalla (likes).",
    gifts: "Regalos",
    giftsHint: "Diamantes aportados con regalos.",
    follows: "Seguidores",
    followsHint: "Quién ha empezado a seguirte en esta sesión.",
    lifetime: "Histórico",
    lifetimeHint: "Totales sumando todos los directos.",
    lifetimeEmpty:
      "El histórico está apagado. Actívalo en la página de Voz para empezar a guardar los totales de quien aporta.",
    empty: "Todavía no hay aportaciones en esta sesión.",
    value: {
      taps: "Taps",
      diamonds: "Diamantes",
      follows: "Follows",
      lifetime: "Diamantes",
    },
    events: (count: number) => (count === 1 ? "1 vez" : `${count} veces`),
    /** El detalle: los regalos que han caído, con su racha. */
    recientes: "Últimos regalos",
    porTipo: "Por tipo de regalo",
    total: (gifts: number, diamonds: number) =>
      `${gifts} regalos · ${diamonds} diamantes`,
    streak: "racha",
    streakFinal: "racha completada",
    none: "—",
    toggle: "Guardar el histórico de quien aporta",
    toggleHint:
      "Suma los totales de cada persona entre directos. Se guarda en tu base de datos local; apagado no se escribe nada.",
  },
  overlay: {
    title: "Overlays para OBS",
    hint: "Cada vista es una fuente de OBS aparte: así colocas cada marcador donde quieras sobre el vídeo. Pega la dirección en un Browser Source (Fuente de navegador). Lleva tu token: no la compartas.",
    unavailable:
      "El servidor de overlays no arrancó (puede que el puerto esté ocupado). Mira el registro para ver el motivo.",
    size: "En OBS se recomiendan 420×620 para los marcadores y fondo transparente; los diseños de pantalla completa van a 1080×1920.",
    views: {
      tap: {
        title: "Tap tap",
        hint: "Los likes que da el público tocando la pantalla. Los minijuegos solo se pueden elegir aquí: se mueven con el ritmo de los taps.",
      },
      gifts: {
        title: "Regalos",
        hint: "Diamantes aportados con regalos. La cifra de la cabecera es la suma, no el número de personas.",
      },
      follows: {
        title: "Seguidores",
        hint: "Quién ha empezado a seguirte en esta sesión.",
      },
    } as Record<string, { title: string; hint: string }>,
    designs: "Diseños",
    inUse: "En antena",
    use: "Usar este",
    preview: "Vista previa",
    previewHint:
      "La previa va con el simulador: se mueve sola con taps inventados, sin tocar el directo. Lo que ves es el mismo fichero que carga OBS.",
    simulator: "Simulador",
    address: "Dirección para OBS",
    copy: "Copiar",
    copied: "Copiada",
    copyFail: "No se pudo",
    copyHint:
      "Si el portapapeles no responde, selecciona la dirección con el ratón y cópiala a mano.",
    noServer: "Sin servidor de overlays",
    empty: "Todavía no hay ningún diseño disponible.",
    /**
     * Rótulos del catálogo, por identificador.
     *
     * Rust publica **solo** los identificadores y las vistas donde valen; cómo se
     * llaman se decide aquí (docs/decisions.md D4). Un diseño sin rótulo enseña su
     * identificador en vez de un hueco en blanco.
     */
    catalogo: {
      marcador: {
        nombre: "Marcador",
        resumen: "El líder en grande y el resto en una lista corta debajo.",
      },
      carriles: {
        nombre: "Carriles",
        resumen: "Una fila por persona, con barra proporcional al líder.",
      },
      cintas: {
        nombre: "Cintas",
        resumen: "Solo caras y cifras; el nombre del primero, en el pie.",
      },
      anillos: {
        nombre: "Anillos",
        resumen: "El progreso de cada persona rodea su cara.",
      },
      columnas: {
        nombre: "Columnas",
        resumen: "Barras verticales, como un gráfico.",
      },
      fichas: {
        nombre: "Fichas",
        resumen: "Tarjetas con la cifra grande y la del líder destacada.",
      },
      "sin-fondo": {
        nombre: "Sin fondo",
        resumen: "Texto con sombra, sin ninguna tarjeta que tape el vídeo.",
      },
      franja: {
        nombre: "Franja",
        resumen: "Estilo «lower third» de informativo, con la cara a la izquierda.",
      },
      /* Minijuegos: solo valen para tap tap, porque se mueven con el ritmo de los
         taps y en regalos o seguidores no hay ninguno. */
      pelotas: {
        nombre: "Pelotas",
        resumen: "Las fotos rebotan en el cuarto de abajo y crecen con los taps.",
      },
      duelo: {
        nombre: "Duelo",
        resumen: "El nº1 y su perseguidor se empujan; el destronamiento se avisa.",
      },
      esgrima: {
        nombre: "Esgrima",
        resumen: "El nº1 defiende la corona con espada; gana quien tenga más ritmo.",
      },
    } as Record<string, { nombre: string; resumen: string }>,
  },
  status: {
    stopped: "Desconectado",
    starting: "Iniciando",
    waiting_for_live: "Esperando directo",
    connecting: "Conectando",
    connected: "En directo",
    reconnecting: "Reconectando",
    error: "Error",
  } as Record<string, string>,
  connect: {
    placeholder: "@usuario",
    button: "Conectar",
    disconnect: "Desconectar",
    connecting: "Conectando…",
    activeHint:
      "Ya hay una sesión en curso. Desconecta antes de conectar a otro usuario: el motor ya está reconectando solo si hace falta.",
  },
  session: {
    /**
     * Lo único que queda del Panel. Es la guía de arranque, así que vive donde
     * ahora empieza todo: el estado vacío del chat.
     */
    hint: "Escribe el @usuario de TikTok y pulsa Conectar. Si aún no está en directo, la aplicación espera sin gastar cuota.",
    duration: "Duración",
    room: "Sala",
  },
  /**
   * La ficha del streamer de la cabecera.
   *
   * Se arma con lo que TikTok mande: un contador que no llegue no se pinta, y el
   * respaldo explica por qué no hay ficha en vez de dejar la cabecera muda sin
   * decir nada.
   */
  perfil: {
    seguidos: "seguidos",
    seguidores: "seguidores",
    likes: "likes",
    /** Une los contadores que sí existen: «33 seguidos · 1.702 seguidores». */
    separador: " · ",
    sinDatos: "Sin datos del perfil",
  },
  stats: {
    viewers: "Espectadores",
    likes: "Likes",
    gifts: "Regalos",
    diamonds: "Diamantes",
    comments: "Comentarios",
    follows: "Seguidores",
    joined: "Entradas",
  },
  /**
   * Inicio: cuatro paneles.
   *
   * El chat, los follows, los seguidores y la actividad. El chat y la actividad
   * ya tenian sus textos; los follows se han ido a un panel propio —son el suceso
   * mas numeroso y enterraban los regalos— y el panel de seguidores **reutiliza**
   * el rotulo y la columna de la tabla de Aportaciones (`aportaciones.follows` y
   * `aportaciones.value.follows`): es la misma tabla con el mismo dato, y dos
   * palabras distintas para lo mismo acabarian discrepando.
   */
  chat: {
    title: "Chat en vivo",
    empty: "Todavía no hay mensajes.",
    /** Panel de follows: los seguimientos nuevos, uno por linea. */
    followTitle: "Follow",
    followEmpty: "Todavía no ha empezado a seguirte nadie.",
    /** Seguidores nuevos por persona. Su vacio es propio porque el de
        Aportaciones habla de «aportaciones», y un follow no es una aportacion. */
    followersEmpty: "Todavía no hay seguidores nuevos en esta sesión.",
    search: "Buscar en el chat",
    clear: "Vaciar",
    showing: (visibles: number, total: number) =>
      `${visibles} de ${total} mensajes en memoria`,
    stick: "Ir al final",
    /** Rotulo de un comentario que TikTok borro. No se quita de la lista. */
    deleted: "mensaje borrado",
    deletedHint:
      "TikTok borró este comentario. Se deja a la vista, atenuado, para no perder el hilo de la conversación.",
    /** Mensajes que llegan sin texto porque son solo emotes del fans club. */
    emotes: (count: number) => `😀×${count}`,
    emotesHint: "Comentario sin texto: solo emotes del fans club.",
    noText: "(sin texto)",
    /** Silenciar o volver a leer a un usuario en la voz. */
    mute: "🔇",
    muteHint: "Silenciar a este usuario en la voz",
    unmute: "🔊",
    unmuteHint: "Ya silenciado: volver a leerlo en la voz",
  },
  feed: {
    title: "Actividad",
    /* Los follows ya no caen aqui: tienen su panel en Inicio. Nombrarlos en el
       vacio mandaba a buscar en la lista algo que nunca iba a aparecer. */
    empty:
      "Aquí aparecerán los regalos, los compartidos, las suscripciones y las ráfagas grandes de likes.",
    clear: "Limpiar",
    unknown: "Alguien",
    giftOne: (who: string, name: string) => `${who} envió «${name}»`,
    giftMany: (who: string, name: string, count: number) =>
      `${who} envió «${name}» ×${count}`,
    giftStreak: (who: string, name: string, count: number) =>
      `${who} va por ${count} de «${name}»`,
    follow: (who: string) => `${who} te sigue`,
    share: (who: string) => `${who} compartió el directo`,
    subscribe: (who: string, months: number) =>
      months > 1
        ? `${who} se suscribió por ${months} meses`
        : `${who} se suscribió`,
    likes: (who: string, count: number, total: number) =>
      `${who} +${count} likes (total ${total.toLocaleString("es-CO")})`,
    genericGift: (id: string) => `regalo ${id}`,
  },
  /**
   * Alertas para OBS.
   *
   * Los rótulos de los cinco tipos viven aquí, pero **las plantillas de fábrica
   * no**: esas las compone Rust (`alerts/mod.rs`), porque son contenido que el
   * streamer edita y que tiene que llegar ya relleno al overlay. Mismo criterio
   * que las frases del lector de voz.
   */
  alertas: {
    title: "Alertas para OBS",
    hint: "Cada evento dispara un aviso que sale de uno en uno en pantalla, con su medio y su sonido. Es una fuente de OBS propia: pégala en un Browser Source y colócala donde quieras.",
    direccion: "Dirección para OBS",
    direccionHint:
      "Es la fuente de las alertas. Si OBS no la tiene cargada, los avisos esperan en cola y salen al volver; si se acumulan más de veinte, se descartan los viejos.",
    descartados: (cuantos: number) =>
      cuantos === 1
        ? "1 aviso descartado por cola llena."
        : `${cuantos} avisos descartados por cola llena.`,
    /**
     * La lista de la izquierda.
     *
     * `lista` **no se pinta**: los encabezados de grupo dicen más —y más concreto—
     * que un «Avisos» encima, y con el mismo tratamiento serían dos rótulos
     * iguales seguidos. Se queda como nombre accesible del bloque, que es lo que un
     * encabezado de grupo no puede dar.
     *
     * `listaHint` sí se lee: explica que el interruptor enciende sin abrir el aviso
     * y que se edita el elegido.
     */
    lista: "Avisos",
    listaHint:
      "Elige un aviso para configurarlo. El interruptor lo enciende o lo apaga sin abrirlo.",
    /**
     * Los dos grupos de la lista.
     *
     * Son palabras del streamer, no identificadores: qué avisos caen en cada grupo
     * lo decide la página, aquí solo se llaman así.
     */
    grupoRegalos: "Regalos y seguidores",
    grupoActividad: "Actividad",
    tipos: {
      gift: {
        nombre: "Regalos",
        descripcion:
          "Sale al cerrarse la racha, no con cada rosa: si no, el aviso del regalo grande se perdería entre veinte iguales.",
      },
      follow: { nombre: "Seguidores", descripcion: "Quién empieza a seguirte." },
      subscribe: {
        nombre: "Suscripciones",
        descripcion: "Con los meses, si los pones en el texto.",
      },
      share: { nombre: "Compartidos", descripcion: "Quién comparte el directo." },
      like: {
        nombre: "Ráfagas de likes",
        descripcion: "Solo cuando alguien suelta una ráfaga grande.",
      },
    } as Record<string, { nombre: string; descripcion: string }>,
    activo: "Activo",
    apagado: "Apagado",
    texto: "Texto",
    variables: "Variables que puedes usar",
    medio: "Imagen, GIF o vídeo",
    sonido: "Sonido",
    sinMedio: "Sin medio",
    sinSonido: "Sin sonido y el vídeo suena con su propio audio",
    duracion: "Duración",
    volumen: "Volumen",
    minimo: "Mínimo",
    minimoGift: "Solo a partir de estos diamantes",
    minimoLike: "Solo a partir de estos likes",
    probar: "Probar",
    probarHint:
      "Encola un aviso de mentira con el texto y el medio de arriba. No pasa por el mínimo a propósito: si lo tienes alto, la prueba se quedaría muda y parecería roto.",
    medios: "Medios cargados",
    mediosHint:
      "Arrastra un fichero a la ventana, o pulsa para elegirlo. Se copian a la carpeta de datos y los sirve la propia aplicación, así que no se rompen si mueves el original.",
    soltar: "Suelta el fichero aquí",
    elegir: "Elegir fichero",
    borrar: "Borrar",
    borrarHint:
      "Si algún aviso lo estaba usando, se queda sin medio: no se puede apuntar a un fichero que ya no está.",
    vacio: "Todavía no has cargado ningún medio.",
    formatos:
      "Se aceptan PNG, JPG, GIF, WEBP, APNG, MP4, WEBM, MP3, OGG, WAV y M4A, hasta 48 MB.",
    demasiadoGrande: (mb: number) =>
      `Ese fichero pasa de ${mb} MB. Para algo tan grande, arrástralo a la ventana en vez de elegirlo.`,
    guardado: "Guardado",
    salida: "Salida de audio",
    salidaHint:
      "Por dónde oyes las alertas tú. A la audiencia le llegan por la fuente de OBS, no por aquí: esto es para que las escuches al probar y, si quieres, también durante el directo.",
    salidaDispositivo: "Dispositivo",
    salidaSistema: "El del sistema",
    salidaVolumen: "Volumen aquí",
    salidaEnDirecto: "Escucharlas también en directo",
    salidaEnDirectoHint:
      "Apagado viene bien: en directo ya las oyes por OBS, y sonar dos veces suena peor que no sonarlas.",
    salidaActiva: (dispositivo: string) => `Sonando por ${dispositivo}.`,
    salidaSistemaActivo: "Sonando por el dispositivo del sistema.",
    salidaMuda: (motivo: string) => `Sin sonido: ${motivo}`,
    salidaNoDisponible: (nombre: string) => `${nombre} (no disponible)`,
  },
  tts: {
    title: "Lectura del chat en voz alta",
    enabled: "Leer el chat",
    disabledHint: "Actívalo para que los mensajes nuevos se lean en voz alta.",
    nowPlaying: "Leyendo ahora",
    idle: "En silencio",
    paused: "En pausa",
    queue: "Cola",
    queueEmpty: "La cola está vacía.",
    clear: "Vaciar cola",
    skip: "Saltar",
    pause: "Pausar",
    resume: "Reanudar",
    volume: "Volumen",
    rate: "Velocidad",
    pitch: "Tono",
    device: "Dispositivo de audio",
    deviceDefault: "Dispositivo predeterminado",
    deviceActive: (name: string) => `Activo: ${name}`,
    deviceUnavailable: "No hay una salida de audio activa",
    deviceLoadError: "No se pudieron cargar los dispositivos de audio.",
    deviceSelectError: "No se pudo cambiar el dispositivo de audio.",
    sources: "Qué se lee",
    sourcesHint:
      "Además del chat. Un regalo se lee una sola vez, al cerrar su racha, para no repetir la misma ráfaga.",
    readGifts: "Regalos",
    readFollows: "Seguidores nuevos",
    voiceEs: "Voz en español",
    voiceEn: "Voz en inglés",
    sayAuthor: "Decir quién lo escribió",
    rejected: "Descartados por los filtros",
    rejectedEmpty: "Ningún mensaje descartado.",
    counters: "Actividad",
    played: "Leídos",
    synthesized: "Sintetizados",
    fromCache: "Desde caché",
    failures: "Fallos de síntesis",
    dropped: "Descartados por cola llena",
    muted: "Usuarios silenciados",
    degraded: (reason: string) => `Sin audio: ${reason}`,
    hint: "El motor decide qué se lee; Python solo convierte el texto en audio. La voz se elige por idioma del mensaje.",
  },
  developer: {
    title: "Diagnóstico",
    /**
     * El botón de la cabecera. Desarrollador **no es una pestaña**: es una
     * herramienta, y en la barra competía con las páginas del directo.
     */
    open: "Desarrollador",
    warned:
      "El servidor de firma limita a 5 conexiones por minuto, 30 por hora y 100 por día sin API key.",
    paths: "Rutas",
    metrics: "Métricas",
    database: "Base de datos",
    logs: "Logs",
    schemaVersion: "Versión de esquema",
    instancePort: "Puerto de instancia única",
    dbWritten: "Filas escritas",
    dbDropped: "Trabajos descartados",
    protocolVersion: "Versión del protocolo",
    provider: "Proveedor",
    streamId: "Sesión",
    tools: "Herramientas de desarrollo",
    uiEvents: "Eventos vistos por la interfaz",
    uiEventsHint:
      "Lo que la interfaz reconoce y pinta, por tipo. Si aparece algo con «sin_manejar», hay un evento llegando que no se está mostrando.",
    uiEventsEmpty: "Todavía no ha llegado ningún evento.",
    chatTrace: "Chat en vivo, eslabón a eslabón",
    chatTraceHint:
      "Comentarios que la interfaz ha recibido y listas que ha vuelto a pintar. Si «recibidos» sube y «pintados» no, el fallo está en el estado o el render, no en la conexión.",
    chatTraceCounts: (recibidos: number, pintados: number) =>
      `recibidos ${recibidos} · pintados ${pintados}`,
    chatTraceSeq: (recibido: number, pintado: number) => `seq ${recibido} → ${pintado}`,
    chatTraceDomEmpty: "Sin medidas del DOM.",
    chatTraceEmpty: "Todavía no ha llegado ningún comentario.",
    simulator: "Arrancar el simulador",
    simulatorHint:
      "Genera eventos falsos (comentarios, regalos con racha, likes, viewers y follows) sin conexión a TikTok. Es el mismo proveedor que usan los tests: no aparece en el flujo normal a propósito.",
    backToNative: "Volver al proveedor real",
  },
} as const;
