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

- **Fuera las tarjetas con borde.** Las secciones se separan con **aire** y un rotulo
  pequeno en mayusculas. Un borde por seccion convierte la pantalla en un rack.
- **Fuera el azul-negro.** El fondo pasa a un negro **calido** (marron). El frio es la
  mitad del aire de laboratorio.
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

### Chat — la que se usa mas
Dos columnas: el chat y la actividad. Se queda como esta de estructura; cambia el
aspecto (sin bordes, fondo calido, la cabecera y el marcador nuevos). La frase de
arriba tiene que decir que **hay que escribir el usuario y pulsar Conectar**, que hoy
se dice pero enterrado.

### Aportaciones — cuatro tablas son la misma pregunta con otro reloj
Hoy: cuatro tablas con las mismas columnas, y la misma persona en las cuatro, asi que
para saber algo de alguien hay que mirar en cuatro sitios, y el nº1 de esta noche y el
de siempre se ven iguales.

- **Una tabla, una fila por persona**, con taps, diamantes y regalos como columnas.
- **El reloj es un interruptor**: `En directo` / `De siempre`, en vez de dos tablas.
- **Ultimos regalos no es una tabla, es un flujo**: va al lado, como lista de sucesos.

### Alertas — ensena todo a la vez y no ensena el resultado
Hoy: cinco formularios identicos apilados (27 campos) y el texto se escribe a ciegas.

- **Lista a la izquierda, editor a la derecha.** Los cinco avisos con su interruptor,
  y solo se abre el que se toca.
- **Previa en vivo arriba del editor.** Ya esta la maquina: la pagina de alertas es una
  pagina real y la pestana Overlays ya enmarca cosas en una previa. Es el mismo patron.
- **El texto se lee mientras se escribe**, con un ejemplo: `Juan dono Rosa ×5`.
- **Los medios por miniatura y el sonido con un boton de oir.** Hoy son nombres de
  fichero.
- **La direccion de OBS se muda a Overlays.** Es una direccion, como las otras tres.

### Voz — mezcla lo que se configura con lo que esta pasando
Hoy: ocho tarjetas, y la mitad son diagnostico.

- **Arriba los ajustes**: encender, voz, volumen, dispositivo, que se lee.
- **En medio, sonando ahora y la cola** — eso si sirve en directo.
- **El historico y los descartados, a Desarrollador.** Son para cuando algo va mal.

### Overlays — es un menu de once filas, no un panel
Hoy: tres pestanas y once filas con once botones que dicen lo mismo.

- **Las tres direcciones a la vez**, en una tabla de tres filas, sin pestanas.
- **El tamano que hay que ponerle a la fuente de OBS, en su fila.** Es justo el dato
  que falta cuando la fuente se desborda.
- **Elegir diseno con miniaturas en fila**, no once filas con once botones.
- **Los minijuegos solo donde valen** (tap tap), que hoy salen en las tres vistas.

## Orden de trabajo

1. **Armazon** — cabecera y marcador, con **una** pantalla dentro (Chat).
2. **Alertas** — la que no se entiende, y la que mas gana.
3. **Aportaciones** — de cuatro tablas a una.
4. **Overlays** — direcciones, tamanos y miniaturas.
5. **Voz** — separar ajustes de diagnostico.

Todo esto es interfaz, asi que **se ve al instante** en el servidor de desarrollo, sin
compilar. Se ensena en cada paso antes de seguir.
