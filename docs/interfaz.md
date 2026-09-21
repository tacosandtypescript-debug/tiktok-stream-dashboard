# La interfaz: cuatro reglas y un plan

Lo que pidio el streamer, en sus palabras: **«tiene que ser intuitivo, facil de
entender, saber y configurar»**. Y antes: «parece un centro de control de la NASA».

Eso no es una lista de deseos, son decisiones concretas. Este documento las fija para
que las cinco pantallas se hagan con el mismo criterio y no cada una a su aire.

## Las cuatro reglas

### 1. Entender: cada pantalla dice que es, en una linea y en palabras normales

Arriba de cada pantalla, una frase que explique **que hace eso** sin jerga del
programa. Ya se hace en Alertas y funciona; falta en el resto.

Y las palabras son diseno. Se nombra por lo que el streamer controla, no por como esta
hecho por dentro:

| no | si |
|---|---|
| Medio | Con que sale |
| Minimo | Solo a partir de |
| Salida de audio | Donde lo oyes tu |
| Descartados por cola llena | Se perdieron N avisos: OBS no llegaba |
| Vistas (`?view=`) | Tap tap / Regalos / Seguidores |
| Cola | Lo que viene |

### 2. Saber: lo que importa se sabe sin leer

- **Un solo sitio con numeros grandes.** El marcador, abajo y siempre visible. Si un
  numero esta grande en dos sitios, el ojo no aprende donde mirar.
- **Los estados se ven, no se leen.** Encendido/apagado, en directo/no, sonando/mudo:
  color y forma, no una frase.
- **El color significa siempre lo mismo**, en las cinco pantallas: `brasa` es en
  directo, `ambar` es el primero, `menta` es lo que funciona. Nunca decorativo.
- **Densidad baja.** Si hay que acercarse a leer, esta mal. 12-13 px es el minimo y
  solo para lo secundario.

### 3. Configurar: el mando esta donde esta la cosa, y el resultado se ve

- **Se cambia y se ve en el mismo sitio.** Nada de guardar y mirar OBS para saber como
  quedo. Si algo se puede configurar y no se puede previsualizar, falta la previa, no
  el mando.
- **Nada se guarda a escondidas.** Si algo se aplica solo, se dice.
- **Los valores de fabrica sirven desde el minuto uno.** Se tiene que poder emitir sin
  configurar nada.
- **Un cambio, un sitio.** Lo mismo no se configura en dos pantallas.

### 4. Y la que hace posibles las tres: no parecer un panel

Esto es lo que hoy lo hace parecer la NASA, y es lo que se quita:

- **Las tarjetas con borde: fuera, y luego dentro otra vez.** Se quitaron —las secciones
  pasaron a separarse con **aire** y un rotulo pequeno en mayusculas, porque un borde por
  seccion convierte la pantalla en un rack— y se han vuelto a poner, **en las seis
  pantallas y con el mismo marco**. El motivo de quitarlas ya no se sostiene: desde que
  cada seccion lleva su propia lista y **su propio desplazamiento**, sin un borde que diga
  donde acaba una y empieza la siguiente el ojo no sabe a cual pertenece lo que lee. El
  aire separaba secciones de una lectura continua; no separa dos listas que se mueven por
  su cuenta. El marco vive **una sola vez**, en la regla base de `.card`
  (`styles.css`): radio `12px` por token, borde de 1 px, fondo de panel y 10 px de
  relleno. Las seis pantallas no lo repiten.
- **Fuera el azul-negro.** El fondo es un negro neutro, no azulado.
- **Fuera todo al mismo peso.** Un numero, un rotulo y un boton no pueden gritar igual.

## La paleta y la letra

| | | |
|---|---|---|
| `tinta` | `#16110D` | fondo: negro calido, no azul |
| `brasa` | `#FF4A1F` | en directo, lo urgente |
| `ambar` | `#FFB020` | el primero, el oro |
| `menta` | `#35D6A0` | lo que funciona |
| `humo` | `#8C8177` | lo secundario: gris calido |

**Tipografia.** El proyecto funciona **sin internet y sin assets**, asi que no se bajan
fuentes. Se usan las que trae Windows, eligiendo por caracter y no por costumbre:

- **Bahnschrift** — cifras y titulos. Grotesca condensada tipo DIN, la letra de los
  marcadores. Es la que le quita el aire de programa generico.
- **Segoe UI** — el texto que se lee de cerca, 12-13 px.
- **Consolas** — rutas, direcciones y codigos, que es lo que se copia.

## Por pantalla

### Inicio — la que se usa mas
Cinco paneles: el **chat** en la columna de la izquierda de arriba abajo, y **Regalos**,
**Follow**, **Seguidores** y **Actividad** en los cuatro cuadrantes de la derecha, los
cuatro del mismo tamaño (ver `styles.css`, `.inicio-paneles`). La frase de arriba tiene
que decir que **hay que escribir el usuario y pulsar Conectar**, que se dice pero
enterrado.

### Aportaciones — cuatro tablas son la misma pregunta con otro reloj
Hoy: cuatro tablas con las mismas columnas, y la misma persona en las cuatro, asi que
para saber algo de alguien hay que mirar en cuatro sitios, y el nº1 de esta noche y el
de siempre se ven iguales.

- **Una tabla, una fila por persona**, con taps, diamantes y regalos como columnas.
- **El reloj es un interruptor**: `En directo` / `De siempre`, en vez de dos tablas.
- **Ultimos regalos no es una tabla, es un flujo**: va al lado, como lista de sucesos.

### Alertas — la consola, la biblioteca y lo que se toca una vez

La pestaña trabaja sobre una ventana fija de **1440×900** sin hacer crecer la página:
**684 px** de contenido, medidos, y **0 px de desborde**.

```text
┌──────────────────────────────────────────────────────────────────────┐
│ Explicación de Alertas (una línea)                                   │
├────────────┬──────────────────────────────────┬──────────────────────┤
│ Avisos     │ Editor del aviso                 │ Previa del aviso     │
│ 250 px     │ espacio flexible                 │ 300 px               │
│ 7 filas    │ Duración · Volumen · Mínimo      │ cuadrado, 1:1        │
│            │ Animación · Permanencia          │       [Probar]       │
│            │                                  │ Tamaño ─────── 90 %  │
├────────────┴──────────────────────────────────┴──────────────────────┤
│ BIBLIOTECA (todo el ancho)                                           │
│  soltar + buscar  │  Imágenes (galería)        │  Sonidos (lista)     │
│  240–280 px       │  espacio flexible          │  300–360 px          │
├──────────────────────────────────────────────────────────────────────┤
│ Salida de audio                            │ Dirección para OBS      │
└──────────────────────────────────────────────────────────────────────┘
```

**Esto era tres columnas con la previa escondida detrás de una pestaña, y estaba mal
por dos motivos.** El primero es de fondo: la regla 3 dice que el mando y su resultado
se ven a la vez, y una previa que hay que abrir no previsualiza nada —es justo lo que
se viene a mirar aquí—. El segundo es de reparto: la biblioteca tenía 370 px para **62
imágenes y 157 sonidos**, que a 28 px de miniatura son cinco a la vista y dos nombres,
mientras la salida de audio y la dirección de OBS ocupaban dos tarjetas de media
pantalla con más hueco que contenido. Ese hueco salía de donde no sobraba.

- **La consola es lo que se toca en directo**: los avisos a la izquierda con sus
  interruptores, el editor en el centro solo para el aviso elegido, y la previa a la
  derecha **siempre a la vista**. Las filas de aviso miden 37 px y su nombre va a 14 px
  —un escalón por encima del mínimo del proyecto— porque se encienden y se apagan con
  el directo en marcha.
- **Probar vive en la previa**, no en el editor: el botón que dispara la prueba está
  pegado al sitio donde se ve el resultado. Antes había que pulsarlo en una tarjeta y
  ir a buscar en cuál de las dos pestañas había salido.
- **La biblioteca es una fila entera.** Dar de alta a la izquierda —soltar, elegir y el
  buscador—, y a la derecha las dos listas: **Imágenes** en galería y **Sonidos** en
  lista, cada una con su rótulo, su cuenta y su propio scroll. Las miniaturas suben a
  62 px: a 48 no se distingue un sticker de otro, que es exactamente lo que hay que
  hacer al elegir uno entre 62. El recuento vive en el rótulo de la tarjeta, no repetido
  dentro del buscador.
- **La salida de audio y la dirección de OBS son una tira de una línea cada una.** Se
  tocan una vez, al montar la escena. La dirección se recorta por el final y se lee
  entera en el `title`: se copia con el botón, no se teclea.
- **El editor lleva dos mandos: Duración y Volumen.** El del **tamaño vive en la
  previa**, no aquí, porque es el único ajuste cuyo efecto se ve *mientras se mueve*, y
  el mando tiene que estar pegado a lo que cambia.
- **El lienzo de la previa es cuadrado, y su mando va debajo.** Era 1920×1080 —lo que
  suele tener la escena de OBS— y sobraba sitio por los lados: un aviso se centra y su
  medio va limitado por el **alto** (62 vh), así que en un marco ancho quedaba un aviso
  pequeño nadando entre dos franjas negras. Cuadrado, el mismo aviso ocupa la misma
  **proporción** del marco y no se desperdicia nada; la proporción es lo único que la
  previa puede prometer, porque el tamaño real lo pone la fuente de OBS. La columna baja
  de 430 a 300 px y ese ancho se lo queda el editor, que pasa de 516 a 646.
- **Mover el mando cambia la previa al momento.** El aviso que ya está en pantalla
  cambia de tamaño sin volver a dispararlo: `VistaPrevia` se lo manda al marco con
  `postMessage`, que es la **única** puerta que hay, porque el overlay lo sirve otro
  origen. Sin eso, ajustar el tamaño era mover un deslizador a ciegas y pulsar Probar
  después para ver el resultado.
- **El tamaño se aplica con `zoom` sobre la caja del aviso entera**, y los topes del
  medio (`62 vh`, `70 vw`) van **divididos** por la escala. No es capricho: con
  `max-height`/`max-width` a secas —lo primero que se probó— el mando **no hacía nada**
  en el caso más común, porque los `max-*` solo recortan y un sticker de 150 px nunca
  llega al tope. Medido: el medio se quedaba en 180 px moviera lo que moviera el
  deslizador. Con `zoom` el medio escala exactamente lo que dice el mando (medido:
  factor 2,222 de 90 % a 200 %), el texto crece con él y los topes siguen midiendo lo
  mismo **en pantalla**, así que el aviso no desborda por mucho que se suba. A 100 % no
  cambia absolutamente nada: los avisos ya configurados salen igual que antes.
- **Una prueba sustituye a la prueba que está en pantalla; un aviso de verdad no lo corta
  nadie.** Es la regla que hace usable el previsualizador: probar Regalos, cambiar a
  Seguidores y volver a pulsar tiene que enseñar Seguidores **ya**, no cuando la anterior
  termine. Antes no era así —el aviso nuevo esperaba su turno en la cola— y con los 17 s
  que trae «Regalos» la previa parecía colgada: se reproducía solo, medido, a los 4,5 s
  de pulsar. La distinción importa: los avisos de verdad siguen esperando su turno como
  siempre, porque en un directo cortar la alerta de un regalo para enseñar una prueba
  sería mucho peor que el problema que se arregla.
- **El medio parte de un tamaño uniforme: un 38 % del alto del lienzo.** Antes mandaba el
  tamaño natural del fichero, así que un sticker de 150 px salía diminuto y un GIF de
  1000 px enorme, sin forma de igualarlos salvo moviendo el mando uno a uno. Ahora la
  altura la pone la regla y la anchura la saca el navegador de la proporción, con
  `object-fit: contain` de red: **nada se estira**. Todo se mide **en `vh`**, y eso es lo
  que hace que la previa no mienta: con `vw` mezclado, el mismo aviso saldría distinto en
  la previa cuadrada que en una fuente de OBS de 1920×1080. Los topes —70 % del alto— van
  divididos por la escala, porque `zoom` los multiplica después.
- **El tamaño es por aviso, no global.** Los tres tramos de regalo existen justo para
  que una rosa pase discreta y una galaxia llene la pantalla; con un tamaño único, el
  tramo enorme ocuparía lo mismo que el pequeño y la diferencia se perdería. De fábrica
  van a 100 %, 125 % y 150 %, y el mando va de 25 % a 200 %.
- **La animación es un catálogo, no una animación por alerta.** Once animaciones —fundido,
  cuatro deslizamientos, acercar, alejar, rebote, giro y desenfoque— entre las que cada
  aviso elige **de dónde entra** y **hacia dónde sale**, con sus dos duraciones y un
  ritmo. La salida es la misma animación **al revés**, y por eso un catálogo sirve para
  las dos: con una animación por sentido habría veintidós combinaciones que mantener, y
  añadir la vigésimo tercera obligaría a tocar el CSS y el JavaScript. «Arriba» de entrada
  es bajar desde arriba; de salida, irse hacia arriba. El desplegable las rotula con esas
  palabras y no con el mismo nombre, porque el mismo nombre leído al revés se entiende mal.
- **El motor no sabe de alertas, y el CSS no sabe de animaciones.** `alertas.js` traduce
  la animación elegida a tres variables —de dónde, cuánto tarda y con qué ritmo— y la
  transición la lleva el navegador. Añadir una animación es **una línea** en el catálogo
  del overlay y su nombre en el de Rust; un test compara las dos listas leyendo el fichero,
  porque el overlay corre en otro proceso y si las dos se separan el aviso sale **sin
  animación, sin un error y sin que nada falle**.
- **Los tiempos los lleva la cola, no la animación.** En una página oculta —y una fuente
  de OBS lo está cuando su escena no se ve— el navegador puede no hacer correr las
  transiciones. Si la cola esperase a que terminaran, no volvería a salir ninguna alerta:
  un atasco mudo, que es la peor forma de fallar. La espera es un temporizador propio, así
  que una animación que no corre solo cuesta el efecto, nunca el aviso.
- **Un aviso tiene tres tiempos, no dos: entra, se queda y se va.** La entrada y la
  salida son un instante; la **permanencia** es todo lo que el aviso pasa en pantalla
  —los 17 s de «Regalos», que sin nada dentro son un sticker quieto mirando a cámara—.
  Cada aviso elige **un efecto de permanencia** —sin movimiento, flotar, rebotar, agitar,
  brillo, gelatina y resplandor de borde— y sus parámetros: intensidad, velocidad y
  duración del ciclo, frecuencia con que se repite, dirección, distancia, color, fuerza y
  difusión. «Ninguna» es el valor de fábrica y lo que ya había: un aviso configurado antes
  de esto sale exactamente igual.
- **Los parámetros salen solo cuando hacen falta.** Cada efecto declara los suyos, y el
  editor dibuja únicamente esos: elegir «Flotar» enseña distancia y ciclo, y «Resplandor»
  enseña color, fuerza, difusión, ciclo y modo. Enseñar los siete juegos a la vez serían
  **veintitantos mandos** de los que se usarían tres, y el que busca «cuánto sube» tendría
  que leerlos todos para encontrar el que sí hace algo. Los valores de fábrica de cada
  efecto son los que van bien de entrada —8 px y 2,5 s para flotar, 2 px cada 2 s para
  agitar, 70 % de fuerza con 12 px de difusión para el resplandor—, así que se elige el
  efecto y no hay que tocar nada más.
- **La permanencia son `@keyframes` que escribe el JavaScript, no una transición.** La
  entrada y la salida caben en una transición porque van de un estado a otro una vez,
  pero un parpadeo que se repite cada 2 s **dentro** de un ciclo de 1,5 s necesita un
  fotograma intermedio en un porcentaje —`0 %` quieto, `20 %` arriba, `70 %` abajo,
  `100 %` quieto—, y ese porcentaje **no puede ser una variable**: un selector
  `@keyframes` no acepta `var()`, y un `animation-duration` que valga la suma tampoco
  sirve, porque el hueco muerto tiene que caer dentro del ciclo. Así que el motor genera
  la hoja —una sola, con nombre propio, `dash-permanencia`— cada vez que arranca un aviso
  y la reescribe con los números del aviso que entra. Al salir se para en seco: nada
  queda animándose fuera de pantalla, que en una fuente de OBS es un renderizador
  trabajando para nadie.
- **La permanencia mueve `translate`, `scale` y `rotate`, no `transform`.** La entrada y
  la salida escriben `transform` —deslizar, acercar, girar—, y las dos cosas conviven en
  el mismo elemento: si la permanencia usara `transform` **borraría** el de la entrada y
  el aviso aparecería de golpe en su sitio. Con las propiedades sueltas, el navegador las
  compone: el aviso entra deslizando, y mientras tanto ya está flotando.
- **El mismo catálogo está en los dos lados, y un test lo compara.** El overlay corre en
  otro proceso, así que una permanencia que Rust conozca y `alertas.js` no —o al revés—
  no da error: da un aviso sin efecto y un desplegable que ofrece algo que no hace nada.
  El test lee `alertas.js` y compara los nombres en los dos sentidos, como el de las
  animaciones.
- **La fila de permanencia ocupa dos líneas y el editor no se recorta.** Con el efecto que
  más parámetros tiene —el resplandor, seis mandos— la fila mide 58 px y el editor sigue
  entrando entero: medido, **0 px fuera** de los 350 px de la tarjeta. Un mando de más no
  puede costar un mando invisible: `.card` recorta lo que sobra, así que lo que no cabe no
  avisa, desaparece.
- **Probar manda el aviso a OBS, no solo a la previa.** El botón está pegado a la
  previa por eso mismo, y con el mando del tamaño debajo los tres forman un solo bucle:
  se mueve, se ve cambiar en la previa, se pulsa, y sale así en antena. La prueba
  además **se queda esperando** a la fuente que no está conectada: la previa del panel
  es un suscriptor más, así que sin esto una prueba pulsada con OBS cerrado se la
  quedaba la previa y no llegaba nunca a OBS —que es justo donde se quiere ver el
  tamaño—. Se guarda **una sola**, la última pulsada. Cubre además un caso que no es un
  fallo: OBS apaga el Browser Source cuando su escena no se ve, así que al cambiar a la
  escena de las alertas la prueba aparece.
- El audio separa **Oír**, **Poner** y **Borrar** para que probar un fichero no lo
  asigne por accidente. Los nombres largos se truncan visualmente, pero conservan
  `title` y nombre accesible.
- **Oír y Probar son interruptores, y suena uno a la vez.** Mientras suena algo, el
  botón que lo lanzó dice «Parar» y lleva el punto que late —el mismo del estado en
  directo—, y la fila del sonido se marca. No es un adorno: con ciento cincuenta
  ficheros en la lista, «¿qué se está oyendo?» no se contesta de otra forma. Y es
  **uno solo** porque los tres sitios que reproducen un audio de prueba —Oír, Probar
  y la muestra de una voz— piden turno al mismo coordinador: el que llega corta al
  anterior, aquí y en el monitor. «Oír» sobre lo que ya suena lo para; no lo encola
  otra vez, que era lo que hacía sonar dos cosas juntas.

- La zona de soltar es un control de teclado real: `role="button"`, `tabIndex`, Enter,
  Espacio, etiqueta accesible y botón visible. El buscador se puede limpiar sin borrar
  carácter a carácter y el Enter del editor respeta `event.isComposing` para no romper
  una entrada por IME.
- Borrar usa una confirmación propia de la aplicación con foco, Escape, Cancelar y
  estado ocupado; no se usa `window.confirm`. Los estados vacío, error, sin resultados,
  arrastre activo y medio roto conservan la geometría de la columna.

**Dos cosas que costaron un rato y no se ven a ojo**, medidas con el banco:

- `Card` lleva `min-height: min-content`, que es lo correcto para una tarjeta normal
  —no debe aplastarse por debajo de su cabecera— pero en la biblioteca pedía el alto de
  las 219 filas enteras y estiraba la fila a **5.841 px**, con la página desplazándose.
  La tarjeta de la biblioteca es la única que se encoge, y su rejilla declara una sola
  fila (`minmax(0, 1fr)`) para que sean las listas las que se desplacen.
- La consola es `auto` y **no** `1fr`: estirada dejaba un hueco muerto bajo la lista de
  avisos. El alto que sobra va a la biblioteca, que es la que gana con cada píxel.
- La tira medía 61 px por dos controles que traían el relleno de un formulario —el
  deslizador nativo, 34 px— y porque la dirección de OBS partía en dos líneas. Con los
  mandos compactos y la dirección recortada son 48, y los 13 px son de la galería.


### Los tramos de regalo

Un regalo de diez diamantes y uno de cinco mil no pueden sonar igual: son **tres avisos**
—normal, grande y enorme— con su texto, su sonido, su duracion y **su tamaño**, y el tramo
lo elige el motor por los diamantes. El campo «Minimo» de cada uno **es la frontera**, no un
filtro: por debajo de él el regalo cae al tramo de abajo. El rotulo lo dice asi, porque
«solo a partir de» suena a descarte y no lo es.

El tamaño entra en esa lista y no es un detalle: hasta que se pudo ajustar, los tres tramos
se distinguian solo por lo que se oia y por lo que decia el texto. Que el enorme ocupe mas
que la rosa es la mitad de lo que hace que un regalo grande se note **en pantalla**.

Es lo que hace que una alerta acompañe al directo en vez de interrumpirlo: lo pequeño
pasa discreto y lo grande para todo.

### Voz — mezcla lo que se configura con lo que esta pasando
Hoy: ocho tarjetas, y la mitad son diagnostico.

- **Arriba los ajustes**: encender, voz, volumen, dispositivo, que se lee.
- **En medio, sonando ahora y la cola** — eso si sirve en directo.
- **El historico y los descartados, a Desarrollador.** Son para cuando algo va mal.
  Hecho: los **descartados por los filtros** y los **contadores** del lector viven ya
  en Desarrollador, y el interruptor del **historico de aportaciones** se mudo a la
  tarjeta «Histórico» de Aportaciones —es el ajuste que llena esa tabla, y alli se
  cambia viendo lo que cambia—.

### Voz son dos vistas, no una pagina

La pagina llego a tener **diez paneles**: 1.831 px de contenido para 674 de alto. No
se pueden mover a otra pestaña porque **las otras cinco estan exactamente llenas**
(medido: 674/674 en las cinco), asi que el problema no se traslada, se resuelve donde
esta. Se parte en dos vistas dentro de la misma pestaña:

| vista | que lleva | para que |
|---|---|---|
| **Lo que suena** | la cola, el motor, que se lee, la voz, las plantillas y la salida | lo que se mira o se toca mientras se emite |
| **Voces y claves** | la **biblioteca de voces** —con sus dos pestañas—, las claves de la API y el consumo | lo que se configura una vez y se viene a buscar |

### Voces y claves es una biblioteca, no cuatro cajas

La vista eran **cuatro tarjetas del mismo peso** —voces guardadas, claves, ajustes de
Fish y consumo— y ninguna decia cual era la importante. La lista de voces eran renglones
sin cara, y el alta de una voz ocupaba una tarjeta entera para tres campos que se
rellenan una vez. Ahora es:

```text
┌──────────────────────────────────────────────┬───────────────────────────┐
│ BIBLIOTECA DE VOCES            (≈66 %)       │ CLAVES DE FISH AUDIO      │
│  [ Mis voces ] [ Explorar Fish Audio ]       │  Clave 1        EN USO    │
│  Buscar voces…   ★   Idioma   Mis modelos    │  ••••••••HYP0   ⋯         │
│                                              │  + Añadir clave           │
│  ┌────┐ ┌────┐ ┌────┐ ┌────┐                 ├───────────────────────────┤
│  │img │ │img │ │img │ │img │                 │ CONSUMO                   │
│  │nom │ │nom │ │nom │ │nom │                 │  En tu cuenta de Fish     │
│  │▶ + │ │▶ + │ │▶ + │ │▶ + │                 │  Lo que ha gastado esto   │
│  └────┘ └────┘ └────┘ └────┘                 │                           │
└──────────────────────────────────────────────┴───────────────────────────┘
```

**La biblioteca se queda el alto que sobra.** Medido en la ventana de 1.440×900: la
rejilla reparte **820 / 410 px** (el 2fr/1fr del encargo), la biblioteca ocupa las dos
filas de la derecha y con **24 voces cargadas** su lista mide **1.399 px de contenido en
441 visibles** —se desplaza por dentro—, el panel sigue en **776/776** y el documento en
**900/900**: cargar cien voces **no hace crecer la aplicacion**, que era el punto. La
clave de que eso funcione esta en los minimos: las filas de la rejilla son
`minmax(0, …)` y no `min-content`, porque la biblioteca abarca las dos y su contenido se
sumaria al minimo de cada una hasta desbordar la pantalla.

**Una tarjeta por voz, la misma en las dos pestañas.** Imagen, nombre, idioma y autor,
con `▶ Escuchar` y `+ Guardar` en el catálogo, y `▶ Escuchar`, `Usar` y el menú `⋯` en
«Mis voces». `TarjetaVoz` **no sabe nada de Fish**: recibe la voz y las acciones, y quien
la pinta decide cuáles. Con dos componentes distintos, la misma voz se vería de dos
maneras segun de dónde viniera.

**Un solo reproductor para toda la biblioteca.** Un `<audio>` montado una vez y un
contexto; las tarjetas solo piden. Un reproductor por tarjeta serian cientos de
elementos y la posibilidad real de que dos voces suenen a la vez; al pulsar `▶` en otra
voz, la anterior se corta **antes** de cargar la nueva. La barra de lo que suena vive
pegada abajo del marco, asi que se sabe qué suena aunque su tarjeta se haya quedado
fuera de la parte visible de la lista.

**Las muestras son las de Fish y no se generan.** La API devuelve `samples` con
direcciones a audios ya hechos: recorrer el catálogo escuchando voces **no gasta saldo**.
Solo cuando una voz no trae ninguna se ofrece «Generar prueba», que usa el motor de
siempre y **avisa de que se cobra**. Esas direcciones van firmadas y caducan en una
hora, asi que antes de reproducir una voz guardada se le pide la buena al catálogo
—leer no cuesta— y lo guardado queda de respaldo.

**Lo que la API da relativo se resuelve al leerlo.** `cover_image` no viene como
direccion completa sino como `coverimage/<id>`, y los medios publicos de Fish viven en
`https://public-platform.r2.fish.audio/` —comprobado contra su propia web, que sirve esa
portada con un 200 y `image/jpeg`—. Sin resolverla, el navegador la pide al panel, que no
tiene esa ruta, y la biblioteca se queda sin caras. Y la imagen de una voz guardada se
**cachea en disco** al guardarla: si mañana Fish tarda o la borra, la biblioteca sigue
enseñando la voz en vez de romperse.

**Explorar solo usa lo que la API confirma.** `title`, `language`, `tag`, `author_id` y
`self` son los filtros del esquema oficial; `sort_by` existe pero **no se usa**, porque
el esquema no dice qué valores acepta. Los idiomas del desplegable salen de las voces
cargadas, no de una lista de codigos inventada, y la paginacion es «Cargar más» con el
buscador esperando 350 ms desde la ultima tecla.

**El alta vive dentro de la biblioteca.** «+ Agregar voz» despliega el importador por
identificador: se pega el `reference_id`, se pulsa **Comprobar** y se enseña la voz que
hay al otro lado —portada, nombre, autor, idioma y una muestra— antes de guardarla. El
nombre propio es **opcional** y no pisa el del catalogo: se guardan los dos.

**Las claves son filas compactas con un menú `⋯`.** Probar —que pregunta a Fish sin
gastar saldo y no cambia el estado de la clave—, renombrar, desactivar y eliminar. Con
un botón por acción la fila dejaba de leerse, y lo que se viene a mirar aquí es **cuál
está en uso**. El alta está detrás de «+ Añadir clave»: se hace una vez.

**El consumo son dos mitades.** Arriba lo que dice **el proveedor** —el saldo de la
cuenta, que solo lo sabe Fish— y abajo lo que cuenta **la aplicación** —los bytes de
texto que ha mandado esta instalacion—. Estaban mezclados y parecia que los dos numeros
salian del mismo sitio.

**«Lo que suena» son tres bloques: estado arriba, cinco paneles en una fila y la salida
de audio de franja.** El estado de lectura va a todo el ancho, debajo el selector de
vistas, y luego **una sola fila de cinco paneles de 240 px** —cola, motor de voz, que se
lee, la voz y como se lee— con la **salida de audio cruzando las cinco columnas** por
debajo. Los numeros son los de la orden de trabajo y estan medidos en la ventana de
1.440×900: cabecera **125 px** (orden 110-125), selector **35** (34-38), fila de paneles
**324** (290-330) y franja **97** (90-120). 1.240 px de rejilla, cuatro huecos de 10:
5 × 240 + 40.

**La salida de audio no es un sexto panel, y ahi estaba el fallo.** Era la sexta celda
de la fila, asi que caia sola a una segunda fila de paneles con **1.000 px de vacio** al
lado —medido—. No se arregla reordenando: una rejilla coloca por filas y una fila mide
lo que su panel mas alto, asi que con seis celdas y cinco columnas el hueco cae donde
menos se espera. Se arregla **sacandola de la fila**: lleva `ancho-completo`,
`grid-column: 1 / -1`, y pasa a ser una tira horizontal —dispositivo activo, volumen y
selector en una linea— de 97 px en vez de 152 apilada. Y va **pegada al borde de
abajo**: el panel es columna flexible, la rejilla se queda el alto que sobra y se
reparte en dos filas —la de trabajo, que mide lo que mide, y la de la franja—, asi que
el aire queda **entre** las dos en vez de debajo de todo. Medido: la franja acaba en 890
con el panel en 900, o sea a los 10 px de relleno del marco.

**Los cinco paneles se estiran hasta la franja**, y por eso la fila de trabajo es `1fr` y
no `min-content`: los cinco miden lo mismo de largo —455 px, medido— y su borde inferior
queda a los 10 px de hueco de la franja, que es lo que convierte los seis marcos en un
bloque y no en una fila con un desierto debajo. La fila es `1fr` con minimo `auto`, no
`minmax(0, 1fr)`: si el contenido pidiera mas alto del que hay, la fila crece y el panel
se desplaza, en vez de recortar las tarjetas. Por debajo de 1.340 px de ventana —cuando
los cinco no caben en una fila— el estiron no se aplica: cada fila mide lo suyo.

**Se estira la tarjeta, no su contenido**, y no es lo mismo: `align-items: stretch`
estira la **celda**, pero dentro de la celda vive otra rejilla —la del `.stack`— cuyas
filas son `min-content`, asi que la tarjeta se quedaba con su alto natural y el resto era
aire que no se veia. Medido despues de estirar la fila: las celdas median 455 px y las
tarjetas **65, 200, 135, 283 y 324** —los cinco paneles seguian acabando arriba y el
hueco de debajo seguia ahi—. Con `.stack { grid-auto-rows: minmax(min-content, 1fr) }` la
tarjeta ocupa todo el alto disponible y lo de dentro no se toca: los controles miden lo
que median. El minimo es `min-content` y no `0` para que una tarjeta con mucho contenido
crezca en vez de recortarse.

**Y se adapta solo al alto de la ventana**, sin una sola altura puesta a mano (medido):
900 px de ventana dan tarjetas de **455**; 924 dan **479**; 755 dan **324**, que es su
minimo de contenido —y entonces el panel se desplaza 4 px antes que recortar—.

**Los cinco paneles son fijos, no `auto-fit`.** Con `auto-fit` el numero de columnas
depende del ancho y a 1.716 px —el navegador maximizado— entraba una sexta: el reparto
que la orden prohibe. Por debajo de 1.340 px de ventana si baja a tres columnas
(3+2, una celda vacia) y por debajo de 1.080 a dos, porque ahi cinco paneles de 200 px
no apilan sus controles; la franja sigue cruzando el ancho entero en todos los pasos.

**Las tarjetas de la fila acaban a la misma altura.** Con `start` el hueco de los cortos
caia **al lado**, fuera del marco: medido, 243 px de vacio bajo «Cola» y 150 bajo «Que
se lee», que es lo que se lee como un descuadre. Estiradas, el aire queda dentro del
marco y las cinco siluetas se leen como una rejilla. **La cola es la unica que crece
sola** —un directo con la voz atascada junta avisos—, asi que su lista se desplaza por
dentro con un tope de 232 px y no empuja a los otros cuatro ni estira la fila: la altura
la sigue poniendo «Como se lee», que es la que mas contenido tiene.

**El orden va en el marcado.** El de la fila es cola, motor, que se lee, la voz y como
se lee; la salida de audio va la ultima para que la rejilla pueda bajarla a su fila. No
se hace con `order`: la rejilla coloca por orden de marcado, y con `order` la vista
quedaria al reves de como la lee un lector de pantalla. Cambiar una tarjeta de vista es
cambiarle la clase, no moverla de sitio en el marcado.

**El mensaje que se esta leyendo vive arriba, no en la cola.** La orden lo pide en el
detalle del panel «Cola» y ya esta en el bloque de estado —`LEYENDO AHORA` y el texto
con el usuario—, que es el sitio por el que se empieza a leer la pantalla. Repetirlo en
la tarjeta seria decir lo mismo dos veces en el mismo golpe de vista, asi que la cola
enseña lo que **viene**, que es lo unico que el estado de arriba no dice.

### Las voces guardadas y las plantillas de lectura

- **Voces guardadas**: cada voz que se usa se guarda con su **nombre, su
  identificador, su proveedor, su idioma y una descripcion**, para no volver a
  buscarla en la API. Se guarda la **referencia, nunca el audio**: lo que se reutiliza
  es la configuracion de la voz, no lo que dijo. La lista mezcla los dos motores y
  cada una vuelve al suyo al elegirla. El boton es **texto** («Guardar voz»), no un
  simbolo, y va junto al selector.
- **Plantillas de lectura**: lo que se dice por cada cosa que pasa es configurable,
  con las variables `{usuario}`, `{mensaje}`, `{regalo}`, `{cantidad}` y `{diamantes}`.
  El motor de plantillas vive en `tts/plantilla.rs`, **aparte del chat y de la API de
  voz**: añadir un proveedor nuevo no lo toca, y cambiar una frase no toca ni el bus
  ni la red. Una variable mal escrita **se deja visible** en la frase, para que el
  error se vea en vez de oirse a medias.

## El tamaño es fijo: todo cabe

La ventana mide **1440x900 y no se redimensiona** (`tauri.conf.json`), así que el
reparto de cada pantalla se diseña para ese alto y no para «lo que salga». Lo que deja
el marco son **674 px** de contenido, y las seis pantallas caben ahí **sin desplazar la
página**:

| pantalla | reparto |
|---|---|
| Inicio | el chat a dos filas de alto y cuatro cuadrantes iguales a su derecha |
| Aportaciones | cuatro columnas por dos filas: las cuatro tablas de personas arriba, el resumen por tipo y el flujo de regalos abajo |
| Alertas | consola (avisos 250 px, editor flexible y previa 430 px), biblioteca a todo el ancho y la tira de salida de audio y dirección de OBS |
| Overlays | direcciones, **marcadores** y **juegos** a la izquierda; la previa con su columna entera a la derecha |
| Voz | el estado a todo el ancho, **dos vistas**; en «Lo que suena», una fila de cinco paneles de 240 px y la salida de audio de franja cruzando las cinco columnas; en «Voces y claves», la biblioteca al 66 % y las claves con el consumo al 34 % |
| Desarrollador | las métricas en tres columnas, y dos filas de cuatro y de dos paneles |

Cuatro listas **sí** se desplazan por dentro, y es a propósito: el **chat** de Inicio, el
**flujo de últimos regalos**, la **galería de imágenes** y la **lista de audios** de
Alertas. Son registros que crecen sin tope; un panel de 210 px no puede enseñar sesenta
y dos imágenes o ciento cincuenta y siete sonidos, y recortarlos sin más sería mentir.
Lo que no se desplaza nunca es la página en el ancho normal.

La lista de **avisos** no se desplaza hoy: los siete —los tres tramos de regalo más los
cuatro de siempre— entran enteros en los 355 px de la consola, con filas de 37 px. El
desplazamiento sigue puesto por si alguien llega a más. Antes era la cuarta lista de
verdad, y se resolvió apretando el aire entre los dos grupos en vez de esconder el
séptimo aviso detrás de la barra.

Cuando un panel no cabe, el que cede es su contenido y **nunca** el marco: `.card` lleva
`overflow: hidden` para que las esquinas redondeadas no las pise una fila con fondo, y
eso mismo recortaría en silencio lo que sobresalga. Por eso cada tarjeta que puede
crecer lleva `min-height: 0` y su lista se desplaza por dentro.

### Overlays — direcciones, marcadores y juegos

El plan decia «un menu de once filas, no un panel», y hoy la pagina ya esta ordenada
asi. Medido en la ventana de 1.440x900: **770 px** para lo que se configura y **460**
para la previa, con el panel en **776/776** y el documento en **900/900** —la pestaña
entra entera, sin desplazarse—.

```text
┌────────────────────────────────────────────┬───────────────────────┐
│ DIRECCIÓN PARA OBS     (3 fuentes)         │ VISTA PREVIA          │
│  Tap tap / Regalos / Seguidores  [Copiar]  │  (del diseño puesto)  │
├────────────────────────────────────────────┤                       │
│ MARCADORES   [tap] [regalos] [seguidores]  │   vive, con el        │
│  ocho diseños en dos columnas  «Usar este» │   simulador           │
├────────────────────────────────────────────┤                       │
│ JUEGOS                        + Crear juego│                       │
│  tres juegos en dos columnas   «Usar este» │                       │
└────────────────────────────────────────────┴───────────────────────┘
```

- **Las tres direcciones a la vez**, en una tabla de tres filas, sin pestañas.
- **El tamaño que hay que ponerle a la fuente de OBS, en su fila.** Es justo el dato que
  falta cuando la fuente se desborda.
- **La previa va en su propia columna y se escala por las dos dimensiones.** Un marcador
  mide 420x524 y un diseño de pantalla completa 1080x1920: con el tope de ancho solo,
  esos dos casos medían 550 y 818 px de alto y empujaban la página fuera de la ventana.
  Limitando también el alto, la previa cabe siempre.
- **Marcadores y juegos, en dos secciones y no en una lista de once.** Antes los once
  diseños salían juntos y no había forma de saber cuál era cuál salvo por el nombre. Se
  separan porque **no se eligen igual**: un marcador dice lo que ha pasado y se elige por
  vista; un juego se mueve con el ritmo de los taps y solo va en Tap tap. El motor
  publica cuál es cuál (`tipo`: `marcador` o `juego`) y un test impide que un juego
  acabe declarado marcador o que admita vistas donde no hay taps que lo muevan.
- **Un juego ocupa el hueco de Tap tap**: mientras haya uno puesto, esa vista no enseña
  el marcador. Por eso la previa sigue a **lo último que se eligió** —si el juego está
  puesto, enseña el juego— en vez de a la pestaña de marcadores: si no, la previa diría
  una cosa y la antena otra.
- **Los ocho marcadores entran sin barra.** La fila de marcadores es la flexible: mide
  **307 px** y su lista **204 de 204**. Para conseguirlo se quitó el aviso que repetía lo
  que ya dicen las pestañas y el de la vista elegida se quedó en una línea; con los dos,
  la lista pedía 34 px más de los que había y salía una barra por un renglón de más.
- **La sección de Juegos es también el taller.** «+ Crear juego» abre el sitio donde se
  crearán los nuevos: un overlay que se mueve con el ritmo de los taps. Los tres que hay
  se pueden poner en antena desde ahí mismo.

## Orden de trabajo

1. **Armazon** — cabecera y marcador, con **una** pantalla dentro (Chat).
2. **Alertas** — la que no se entiende, y la que mas gana.
3. **Aportaciones** — de cuatro tablas a una.
4. **Overlays** — direcciones, tamanos y miniaturas.
5. **Voz** — separar ajustes de diagnostico.

Todo esto es interfaz, asi que **se ve al instante** en el servidor de desarrollo, sin
compilar. Se ensena en cada paso antes de seguir.
