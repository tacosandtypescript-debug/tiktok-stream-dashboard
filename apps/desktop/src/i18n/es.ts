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
      "El histórico está apagado: enciende el interruptor de arriba para empezar a guardar los totales de quien aporta entre directos.",
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
        hint: "Los likes que da el público tocando la pantalla.",
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
    designs: "Marcadores",
    games: "Juegos",
    gamesHint:
      "Se mueven con el ritmo de los taps, así que solo van en Tap tap: mientras haya uno puesto, esa vista no enseña el marcador.",
    gamesTapOnly: "Tap tap",
    gamesSoon: "Próximo paso",
    gamesSoonHint:
      "Los juegos nuevos se crean desde aquí: un diseño que se mueve con el ritmo de los taps. Los tres de arriba ya están montados y se pueden poner en antena.",
    gameCreate: "+ Crear juego",
    inUse: "En antena",
    use: "Usar este",
    /**
     * El despliegue de la configuración de un juego, dentro de la propia tarjeta de
     * Juegos. Es el mismo botón para todos: el que sepa desplegarse lo usa.
     */
    configure: "Configurar",
    collapse: "Cerrar",
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
      /* Beyblades **no** sale del catálogo de Rust: es un overlay propio (`juego.html`)
         con su servidor de comandos y su configuración. Se rotula aquí igual que los
         demás para que su tarjeta sea la misma que la de Pelotas, Duelo y Esgrima, y
         no un bloque aparte. */
      beyblades: {
        nombre: "Beyblades",
        resumen: "Batalla de trompos controlada por regalos e interacción del LIVE.",
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
    /**
     * Los dos paneles en que se parte la actividad de Inicio.
     *
     * Antes eran «Actividad» (todo menos los follows) y «Actividad reciente» (los
     * seis últimos regalos, en fila compacta). Los seis del resumen eran los
     * mismos seis de la lista de arriba: el mismo suceso, la misma frase y la
     * misma cifra. Ahora el feed se parte **por tipo y sin repetir nada**.
     */
    gifts: "Regalos",
    giftsEmpty: "Todavía no ha caído ningún regalo en esta sesión.",
    other: "Actividad",
    otherEmpty: "Aquí aparecerán los compartidos, las suscripciones y las ráfagas grandes de likes.",
    clear: "Limpiar",
    unknown: "Alguien",
    giftOne: (who: string, name: string) => `${who} envió «${name}»`,
    giftMany: (who: string, name: string, count: number) =>
      `${who} envió «${name}» ×${count}`,
    /* El combo crece en el sitio: mientras la racha sigue abierta se dice que va
       por ahi, y al cerrarse se dice lo que envio. El numero es la misma racha
       agrupada, no un incremento: si dijera «va por 1» con veinte rosas, la
       tarjeta pareceria congelada. */
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
    /**
     * Lo que vale el combo, en diamantes.
     *
     * La cifra la calcula la interfaz **con los datos del motor**: el valor
     * unitario (`diamond_count`) por las unidades de la racha, que es lo que
     * documenta D14. No se estima ningun valor de regalo.
     */
    comboValue: (diamonds: number) => `${diamonds.toLocaleString("es-CO")} 💎`,
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
    hint: "Un aviso por evento: elige el texto, el medio y el sonido, y míralo aquí antes de que salga en antena.",
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
     * Ya no hay `listaHint`: la frase de arriba explica la pantalla entera y la lista
     * se quedó sin ayuda propia para ganar una fila más de avisos a la vista.
     */
    lista: "Avisos",
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
      gift_grande: {
        nombre: "Regalos grandes",
        descripcion:
          "El tramo de en medio. Un regalo que ya se nota no puede sonar como una rosa.",
      },
      gift_enorme: {
        nombre: "Regalos enormes",
        descripcion:
          "El momento del directo. Si esto entra, para todo lo demás.",
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
    sinSonido: "Sin sonido",
    /* El aviso de que el vídeo no suena solo. Va en la ayuda del campo, y no en la
       opción vacía: si estuviera ahí, parecería una característica y no una regla. */
    videoMudo: "el vídeo va en mudo",
    duracion: "Duración",
    volumen: "Volumen",
    tamano: "Tamaño",
    /* Va debajo de la previa, que es donde se ve el efecto, y por eso el rótulo ya no
       necesita decir «en OBS»: lo dice la ayuda, que es donde cabe contarlo entero. */
    tamanoHint:
      "Cuánto ocupa este aviso en pantalla. Se aplica al medio y a su texto, y solo a este aviso: el tramo enorme puede ocupar más que una rosa. Al moverlo, la previa cambia al momento; al darle a Probar, sale así en OBS.",
    animacion: "Animación",
    animacionHint:
      "Cómo entra y cómo sale el aviso, cuánto tarda cada cosa y a qué ritmo. El aviso se queda en pantalla lo que diga «Duración» **después** de terminar de entrar.",
    entra: "Entra",
    sale: "Sale",
    animacionEntrada: "Cómo entra el aviso",
    animacionSalida: "Cómo sale el aviso",
    /* En segundos y no en milisegundos: es como se piensa un tiempo que se ve. */
    entradaMs: "Segundos que tarda en entrar",
    salidaMs: "Segundos que tarda en salir",
    ritmo: "Ritmo de la animación",
    ritmoHint:
      "Cómo reparte el tiempo la animación. «Automático» deja el que traiga cada una: un rebote rebota sin tener que pedirlo.",
    /* La permanencia: lo que hace la alerta mientras está en pantalla, entre la
       entrada y la salida. */
    permanencia: "Permanencia",
    permanenciaHint:
      "Lo que hace la alerta mientras está en pantalla, ya entrada y antes de salir. Se repite durante todo ese rato: flotar, vibrar, una luz que la cruza, un resplandor en el contorno… Cada efecto trae sus propios mandos, y al elegirlo se ponen sus valores recomendados.",
    minimo: "Mínimo",
    minimoGift: "Solo a partir de estos diamantes",
    minimoLike:
      "Solo a partir de estos likes en la ráfaga. Los mensajes de TikTok se suman durante unos segundos, así que no hace falta que uno solo traiga esa cifra: sesenta likes en cinco mensajes de doce cuentan como sesenta.",
    /* El mínimo de un tramo decide dónde empieza: por debajo de él, el regalo cae
       al tramo de abajo. */
    minimoTramo: "Desde estos diamantes",
    probar: "Probar",
    probarHint:
      "Encola un aviso de mentira con el texto y el medio de arriba. No pasa por el mínimo a propósito: si lo tienes alto, la prueba se quedaría muda y parecería roto.",
    /* Probar y oír son interruptores: mientras suena eso mismo, el botón dice
       «Parar». Un solo audio de prueba suena a la vez —el coordinador corta el
       anterior—, así que el botón que suena es siempre el mismo que se puede parar. */
    parar: "Parar",
    pararHint: "Está sonando: vuelve a pulsar y se para.",
    oir: "Oír",
    oirHint:
      "Suena aquí, en tu monitor, sin encolar ningún aviso: es la única forma de saber qué es un fichero sin tener OBS delante. Si ya está sonando otro, se corta.",
    poner: "Poner",
    puesto: "Puesto",
    ponerSonido: (aviso: string) => `Ponlo como sonido de «${aviso}».`,
    ponerMedio: (aviso: string) => `Ponlo como imagen o vídeo de «${aviso}».`,
    quitar: "Quitar",
    quitarHint: "Se lo quita a este aviso. El fichero sigue en la lista.",
    buscar: "Buscar en los medios",
    buscarPlaceholder: "Buscar…",
    limpiarBusqueda: "Limpiar",
    soloImagenes: "Imágenes",
    soloImagenesHint: "Solo lo que se ve: imágenes, GIF y vídeos.",
    soloSonidos: "Sonidos",
    soloSonidosHint: "Solo lo que suena.",
    soloTodo: "Todo",
    soloTodoHint: "Los dos juntos, mezclados.",
    galeria: "Galería",
    cuenta: (vistos: number, total: number) =>
      vistos === total ? `${total}` : `${vistos} de ${total}`,
    sinResultados: (texto: string) => `Ningún medio coincide con «${texto}».`,
    nadaDeEseTipo: "No hay ningún medio de ese tipo cargado.",
    suena: "Suena",
    seVe: "Imagen",
    video: "Vídeo",
    medios: "Medios cargados",
    /* La previa ya no comparte columna con los medios —vive siempre a la vista, al
       lado del editor—, así que no hay dos modos que nombrar: `mediosCorto`,
       `previaCorto` y las dos frases de ayuda se han ido con la pestaña que las
       justificaba. */
    previa: "Previa del aviso",
    previaNota: "el overlay de verdad",
    previaSinServidor:
      "El servidor de overlays todavía no ha arrancado, así que no hay nada que previsualizar.",
    soltar: "Suelta los ficheros o la carpeta aquí",
    elegir: "Elegir fichero",
    importados: (n: number) => (n === 1 ? "Entró 1 fichero." : `Entraron ${n} ficheros.`),
    fallos: (n: number) => (n === 1 ? "1 no entró:" : `${n} no entraron:`),
    borrar: "Borrar",
    borrarTitulo: "Borrar medio",
    borrarConfirmacion: "Se quitará de la biblioteca y de cualquier aviso que lo tenga asignado:",
    cancelar: "Cancelar",
    borrarHint:
      "Si algún aviso lo estaba usando, se queda sin medio: no se puede apuntar a un fichero que ya no está.",
    vacio: "Todavía no has cargado ningún medio.",
    formatos:
      "Se aceptan PNG, JPG, GIF, WEBP, APNG, MP4, WEBM, MP3, OGG, WAV y M4A, hasta 48 MB.",
    /* La lista de formatos es un dato que se consulta cuando un fichero no entra, no
       una frase que haya que leer cada vez: vive en el `title` del aviso y aquí queda
       lo único que hay que saber de un vistazo. */
    formatosCorto: "Hasta 48 MB por fichero.",
    demasiadoGrande: (mb: number) =>
      `Ese fichero pasa de ${mb} MB. Para algo tan grande, arrástralo a la ventana en vez de elegirlo.`,
    guardado: "Guardado",
    salida: "Salida de audio",
    salidaHint:
      "Por dónde oyes las alertas tú. A la audiencia le llegan por la fuente de OBS, no por aquí: esto es para que las escuches al probar y, si quieres, también durante el directo.",
    salidaDispositivo: "Dispositivo",
    salidaSistema: "El del sistema",
    salidaVolumen: "Volumen aquí",
    /* Corto a proposito: va en la tira de abajo, en una linea, y «Escucharlas también
       en directo» obligaba a partirla en dos y estiraba la tira. La explicacion larga
       viaja en el `title` de al lado. */
    salidaEnDirecto: "También en directo",
    salidaEnDirectoHint:
      "Apagado viene bien: en directo ya las oyes por OBS, y sonar dos veces suena peor que no sonarlas.",
    salidaActiva: (dispositivo: string) => `Sonando por ${dispositivo}.`,
    salidaSistemaActivo: "Sonando por el dispositivo del sistema.",
    salidaMuda: (motivo: string) => `Sin sonido: ${motivo}`,
    salidaNoDisponible: (nombre: string) => `${nombre} (no disponible)`,
  },
  /*
   * El contenedor del mensaje: el bloque donde va el texto.
   *
   * Es su propia sección y no un trozo de `alertas` porque es su propio sistema —estilos,
   * animaciones del contenedor y animaciones de la letra—, y porque sus rótulos salen del
   * catálogo de `mensaje.ts`, no de la página.
   */
  mensaje: {
    title: "Mensaje",
    volver: "Volver al aviso",
    /** El botón que abre el panel, con el estilo puesto: se ve sin abrirlo. */
    boton: (estilo: string) => `Mensaje · ${estilo}`,
    botonHint:
      "El estilo y las animaciones del bloque del texto. Lo que cambies se ve en la previa mientras el aviso está en pantalla.",
    estilo: "Estilo del mensaje",
    estiloHint:
      "Cada estilo trae su forma, sus colores y sus animaciones de partida. Los mandos de al lado empiezan en los suyos, y a partir de ahí mandan los tuyos.",
    grupoEstilo: "Estilo",
    grupoTexto: "Texto",
    grupoAnimacion: "Animación",
    animacionMensaje: "Cómo aparece",
    animacionMensajeHint:
      "Cómo entra el bloque del mensaje. Es independiente de cómo entra la alerta entera: la alerta puede estar ya quieta y el mensaje aparecer después.",
    animacionTexto: "Cómo aparece el texto",
    animacionTextoHint:
      "Va aparte de la del bloque: se pueden combinar. Un bloque que se abre a los lados con las palabras saliendo una a una son dos cosas, no una.",
    permanencia: "Mientras está en pantalla",
    permanenciaHint:
      "Lo que hace el mensaje mientras el aviso sigue en pantalla. Son más suaves que los de la alerta a propósito: la alerta ya se está moviendo.",
    ritmo: "Ritmo",
    ritmoHint: "Con qué curva entra. «Automático» deja la que traiga la animación.",
    secuencia:
      "Por ejemplo: la alerta entra, a los 0,25 s se abre el mensaje y las palabras salen una a una.",
    /*
     * Cuando el motor que responde es anterior a este ajuste. No es un aviso de adorno: sin
     * el, elegir un estilo y verlo volver solo a «Default» parece un fallo del panel, y lo
     * que pasa es que el motor no guarda el campo.
     */
    sinMotor:
      "El motor que responde ahora mismo es anterior a estos ajustes, así que no guarda el estilo del mensaje: elige lo que quieras, pero volverá a «Default» y la previa saldrá con el bloque de siempre. Reinicia la aplicación —o el panel— para que sea el motor nuevo.",
  },
  tts: {
    title: "Lectura del chat en voz alta",
    /* Dos vistas dentro de la misma pestaña. La pagina no cabe entera —los diez
       paneles suman 1.831 px para 674 de alto— y sacarlos a otra pestaña no vale:
       las otras cinco estan exactamente llenas. Se reparten por lo que se hace con
       cada una: lo que suena mientras emites, y lo que tienes guardado. */
    vistaSonando: "Lo que suena",
    vistaVoces: "Voces y claves",
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
    /** El panel donde se elige **la voz** (ritmo, tono y las dos voces). */
    voice: "La voz",
    /** El panel de por donde sale: dispositivo y volumen. */
    output: "Salida de audio",
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
    /** Selector de motor: dos caminos, el mismo resultado (un fichero de audio). */
    engine: "Motor de voz",
    engineEdge: "La de siempre",
    engineFish: "Fish Audio",
    /* Las dos frases que hacían falta y no estaban: **qué es cada motor**, dicho
       para quien no sabe qué es un «motor de voz». El streamer preguntó «no sé si
       uso la de Fish o la de Edge», y la pantalla no lo decía en ninguna parte. */
    engineEdgeHint:
      "La voz de siempre es la de Microsoft Edge: ya viene puesta, es gratis y no hay que configurar nada.",
    engineFishHint:
      "Fish Audio son voces clonadas: hace falta una clave y se paga por lo que lee.",
    engineHint:
      "La de siempre es la que trae el programa y no cuesta nada. Fish Audio son voces clonadas y se paga por uso.",
    /* El botón dice **a dónde se cambia**, no «pulsa aquí». Van las dos frases
       enteras y no una plantilla con el nombre dentro: «Cambiar a La de siempre»
       arrastraba la mayúscula del rótulo a mitad de frase. */
    engineSwitchToEdge: "Cambiar a la de siempre",
    engineSwitchToFish: "Cambiar a Fish Audio",
    engineSwitchHint: "Al cambiar de motor se vacía lo que estaba en la cola.",
    /** Estado del motor elegido, en identificadores de Rust. */
    engineReady: {
      ready: "Listo para leer",
      missing_secret: "Falta la clave de la API: sin ella no se sintetiza nada.",
      missing_voice: "Falta el código de voz: Fish no elige una voz por su cuenta.",
      no_usable_key: "Ninguna clave se puede usar: están rechazadas o sin saldo.",
    },
    /* «Clave en uso», no «Usando»: al lado del nombre del motor, un «Usando la de
       marzo» se lee como si la voz fuera esa. */
    engineInUse: (nombre: string) => `Clave en uso: ${nombre}`,
    engineKeys: (vivas: number, total: number) => `${vivas} de ${total} claves en pie`,
    /** Ajustes de Fish Audio. */
    fish: "Fish Audio",
    fishHint: "La clave se guarda solo en este equipo y no vuelve a la pantalla.",
    /* Las voces guardadas con nombre. Antes habia **una sola casilla**: pegar un
       codigo nuevo borraba el anterior. */
    voiceName: "Cómo llamarla",
    voiceNamePlaceholder: "mi voz de mujer",
    voiceCode: "Código",
    voiceCodePlaceholder: "el reference_id de Fish",
    voiceAdd: "Guardar voz",
    voiceInUse: "En uso",
    voiceUse: "Usar esta",
    voiceRemoveHint: "Quitar de la lista. La voz que está sonando no cambia.",
    voicesSaved: "Voces guardadas",
    voicesSavedHint: "Elige una y queda sonando, sin buscar nada.",
    voicesEmpty:
      "Todavía no hay ninguna. Guarda la que uses con «Guardar voz» y aparecerá aquí para elegirla de un clic.",
    /* Lo que se guarda de cada voz. `proveedor` solo se enseña cuando hay más de
       uno en la lista; con una sola, repetirlo en cada fila es ruido. */
    voiceProvider: { edge: "Microsoft", fish: "Fish" } as Record<string, string>,
    voiceSave: "Guardar voz",
    voiceSaveHint: "La añade a la lista de arriba para no volver a buscarla.",

    /* Las plantillas de lo que se lee. */
    plantillas: "Cómo se lee",
    plantillasHint:
      "Escribe la frase con las variables entre llaves. Lo que no sea una variable se lee tal cual.",
    chatTemplate: "Un mensaje del chat",
    giftTemplate: "Un regalo",
    followTemplate: "Un seguidor nuevo",
    plantillasVariables: "Variables",
    fishModel: "Modelo",
    fishModelPrice: (precio: string) => (precio === "0" ? "gratis" : `${precio} $ por millón`),
    /** Las claves guardadas y su relevo automatico. */
    keys: "Claves de Fish Audio",
    keysHint:
      "Hasta diez. Si una deja de valer, se pasa sola a la siguiente: la voz no se corta.",
    keysEmpty: "Todavía no hay ninguna clave guardada.",
    keyName: "Cómo llamarla",
    keyNamePlaceholder: "la de marzo",
    keyValue: "Clave",
    keyValuePlaceholder: "Pega aquí la clave de fish.audio",
    keyAdd: "Añadir clave",
    keyRemove: "Quitar",
    keyReset: "Reintentar",
    keyUsed: "En uso",
    keyStates: {
      viva: "En pie",
      invalida: "Rechazada",
      agotada: "Sin saldo",
      apagada: "Apagada",
    },
    keyFull: "Ya hay diez claves: quita una para añadir otra.",
    keyEmpty: "La clave no puede estar vacía.",
    /** Las acciones de una clave, dentro del menú ⋯ de su fila. */
    keyMenu: "Más acciones",
    keyProbar: "Probar",
    keyProbarHint: "Pregunta a Fish Audio con esta clave. No gasta saldo.",
    keyProbando: "Probando…",
    keyProbarOk: "La clave funciona.",
    keyProbarFallo: (motivo: string) => `La clave no responde: ${motivo}`,
    keyRenombrar: "Renombrar",
    keyRenombrarAviso: "¿Cómo quieres llamarla?",
    keyDesactivar: "Desactivar",
    keyActivar: "Activar",
    keyDesactivarHint:
      "Deja de intentarse sin perderla: se queda guardada con su nombre y su contador.",
    keyQuitar: "Eliminar",
    keyQuitarAviso: "Se quita de la lista. La clave sigue siendo tuya en Fish Audio.",
    keyAddOpen: "+ Añadir clave",
    /** Consumo: se cobra por bytes del texto enviado, así que se cuenta aquí. */
    usage: "Consumo",
    usageHint: "El gasto de aquí abajo lo cuenta la aplicación, frase a frase.",
    usageModel: (modelo: string, precio: string) =>
      precio === "0"
        ? `Contando con ${modelo}: gratis`
        : `Contando con ${modelo}: ${precio} $ por millón de bytes`,
    usageSession: "Este directo",
    usageTotal: "En total",    usageBytes: (texto: string) => `${texto} de texto`,
    usageCalls: (texto: string) => `${texto} frases`,
    usageFree: "gratis",
    usageEmpty: "Todavía no se ha mandado nada a Fish Audio.",
    /**
     * Las dos mitades del consumo, separadas a propósito.
     *
     * Arriba lo que dice **el proveedor** (el saldo de la cuenta, que solo lo sabe
     * Fish) y abajo lo que cuenta **la aplicación** (bytes de texto enviados por
     * esta instalación). Mezclarlos hacía pensar que el gasto local y el saldo real
     * salían del mismo sitio.
     */
    consumoProveedor: "En tu cuenta de Fish Audio",
    consumoAplicacion: "Lo que ha gastado esta aplicación",

    /* El saldo de la cuenta, preguntado a la API del motor de voz. */
    saldo: "Saldo de la cuenta",
    saldoHint:
      "Lo pregunta a Fish cada 5 minutos. El gasto de aquí abajo lo cuenta la aplicación; esto es lo que dice la API.",
    saldoRestante: "Queda",
    saldoTotal: "De un total de",
    saldoDe: (total: string) => `de ${total}`,
    saldoSinDato: "—",
    /** El plan, tal cual lo llama la API. Lo que no esté en la lista se enseña tal cual. */
    saldoPlanes: { free: "gratuito", pro: "de pago" } as Record<string, string>,
    saldoHace: (texto: string) => `Consultado hace ${texto}`,
    saldoAhora: "Consultado ahora mismo",
    saldoSinClave: "Sin una clave no hay saldo que consultar. Añade una aquí abajo.",
    saldoError: (motivo: string) => `No se pudo preguntar el saldo: ${motivo}`,
    saldoPoco: "Queda poco saldo",
    usageUnknownModel:
      "Ese modelo no está en la lista de precios: se cuenta al precio de pago, 15 $ por millón.",
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

  /**
   * La biblioteca de voces de Fish Audio.
   *
   * Vive aparte de `tts` porque es otra cosa: `tts` es **ejecución** —qué se lee,
   * con qué voz, a qué volumen— y esto es **administración** —buscar voces,
   * escucharlas, guardarlas y llevar las claves—. Los dos textos están separados
   * para que no se dupliquen los mandos (docs/interfaz.md).
   */
  voces: {
    /* Las dos pestañas de la biblioteca. */
    biblioteca: "Biblioteca de voces",
    misVoces: "Mis voces",
    explorar: "Explorar Fish Audio",
    misVocesHint: "Las que has guardado. Se quedan aquí aunque cierres la aplicación.",
    explorarHint:
      "El catálogo público de Fish Audio. Escucha antes de guardar: las muestras son suyas y no gastan saldo.",

    /* El alta. */
    agregar: "+ Agregar voz",
    agregarTitulo: "Agregar una voz",
    agregarHint:
      "Pega el identificador de una voz de Fish o búscala en el catálogo. Primero se comprueba y se enseña; se guarda cuando tú lo digas.",
    importarPorId: "Importar por ID",
    referenceId: "Identificador (reference ID)",
    referenceIdPlaceholder: "9a9cf47702da476aa4629e2506d4a857",
    nombreOpcional: "Nombre personalizado (opcional)",
    nombreOpcionalPlaceholder: "Voz mujer TikTok",
    nombreOpcionalHint: "Si lo dejas vacío se usa el nombre que trae Fish. El suyo no se pierde.",
    comprobar: "Comprobar",
    comprobando: "Comprobando…",
    guardarEnMisVoces: "Guardar en Mis voces",
    cerrar: "Cerrar",

    /* Buscar y filtrar. */
    buscar: "Buscar voces…",
    buscarPlaceholder: "Nombre de la voz",
    filtroTodas: "Todas",
    filtroFavoritas: "Favoritas",
    filtroIdioma: "Idioma",
    soloMisModelos: "Mis modelos",
    soloMisModelosHint: "Solo las voces de tu cuenta de Fish Audio.",
    limpiarFiltros: "Quitar filtros",

    /* La rejilla y sus estados. */
    cargarMas: "Cargar más",
    cargando: "Cargando…",
    cargandoMas: "Cargando más voces…",
    sinResultados: "Ninguna voz coincide con la búsqueda.",
    errorCargar: "No se pudo cargar el catálogo.",
    reintentar: "Reintentar",
    sinClave: "Para explorar el catálogo hace falta una clave de Fish Audio.",
    sinClaveIr: "Ir a las claves",
    sinGuardadas: "Todavía no has guardado ninguna voz.",
    sinGuardadasHint:
      "Explora el catálogo, escucha una muestra y pulsa «+ Guardar». Aparecerá aquí.",
    sinFavoritas: "No has marcado ninguna voz con la estrella.",
    cuantas: (cuantas: number, total: number) =>
      cuantas === total ? `${total} voces` : `${cuantas} de ${total} voces`,
    yaNoEsta: "Esta voz ya no está en el catálogo de Fish Audio.",

    /* La tarjeta. */
    escuchar: "Escuchar",
    usar: "Usar",
    guardar: "Guardar",
    guardada: "Guardada",
    yaGuardada: "Ya está en Mis voces",
    sinMuestra: "Esta voz no trae muestra: se puede generar una prueba desde el detalle.",
    sinImagen: "Sin imagen",
    sonando: "Reproduciendo",
    enUso: "La que está puesta",
    verDetalles: "Ver detalles",
    noDisponible: "Todavía no se puede usar",

    /* El reproductor. */
    cargandoMuestra: "Cargando la muestra…",
    muestraError: "No se pudo reproducir la muestra.",
    pararMuestra: "Parar",
    muestraOficial: "Muestra de Fish Audio",
    muestraSinTexto: "Sin texto asociado",

    /* El detalle. */
    detalles: "Detalles",
    detallesHint: "Lo que Fish Audio sabe de esta voz.",
    descripcion: "Descripción",
    idioma: "Idioma",
    autor: "Autor",
    etiquetas: "Etiquetas",
    identificador: "Identificador",
    copiarId: "Copiar identificador",
    copiado: "Copiado",
    muestras: "Muestras",
    sinMuestras: "Sin muestra",
    sinMuestrasHint:
      "Fish Audio no ha publicado ninguna muestra de esta voz. Se puede generar una prueba con tu clave, y esa sí gasta saldo.",
    generarPrueba: "Generar prueba",
    generandoPrueba: "Generando…",
    generarPruebaAviso: "Generar una prueba manda texto a Fish Audio y se cobra.",
    muestraNumero: (numero: number) => `Muestra ${numero}`,
    actualizado: (cuando: string) => `Actualizado el ${cuando}`,

    /* El menú ⋯ de una voz guardada. */
    menu: "Más acciones",
    editarNombre: "Editar nombre",
    actualizarDesde: "Actualizar desde Fish Audio",
    actualizando: "Actualizando…",
    actualizada: "Datos actualizados",
    eliminar: "Eliminar de Mis voces",
    eliminarAviso: "Se quita de esta lista. En tu cuenta de Fish Audio no se toca nada.",
    quitarFavorito: "Quitar de favoritas",
    ponerFavorito: "Marcar como favorita",

    /* Guardar desde el catálogo. */
    guardadaAviso: "Guardada en Mis voces.",
  },
} as const;
