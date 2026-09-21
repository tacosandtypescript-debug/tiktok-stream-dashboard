//! Overlays para OBS: elegir diseño por vista, verlo en vivo y copiar la
//! dirección.
//!
//! Cuatro decisiones que se ven en esta página:
//!
//!   * **Una elección por vista**, porque cada tabla es una fuente de OBS
//!     independiente y hace un trabajo distinto: el tap tap es un marcador de
//!     ritmo, los regalos son dinero y los seguidores son gente nueva.
//!   * **La previa es el overlay de verdad**, no una maqueta aparte: se carga el
//!     mismo documento que va a cargar OBS, así que lo que se ve aquí es lo que
//!     sale en antena. Si hubiera dos implementaciones, la previa mentiría en
//!     cuanto una de las dos cambiara.
//!   * **La previa va con el simulador** (`?demo=1`): se mueve sola con taps
//!     inventados. Sin eso habría que estar en directo justo en ese momento para
//!     juzgar un diseño, y los minijuegos no se podrían ni mirar.
//!   * **Los juegos son una sola sección con tarjetas iguales.** Cuatro filas del
//!     mismo tamaño —Pelotas, Duelo, Esgrima y Beyblades— y la configuración del
//!     que la tenga, **desplegada dentro de la misma tarjeta**: Beyblades era un
//!     bloque de 1.500 px suelto debajo, que se comía la columna y se solapaba con
//!     lo de al lado.
//!
//! Coste: un diseño cargado es un renderer más de WebView2 mientras la pestaña
//! está abierta (docs/plan-review.md §175). Por eso se pinta **una vista a la
//! vez** y no las tres: pasar de pestaña desmonta el marco y lo libera. Por lo
//! mismo la configuración de un juego se monta al desplegarla y se desmonta al
//! cerrarla.

import { useCallback, useState } from "react";

import type { OverlayDesignInfo } from "../api";
import { Card, Copiar, VistaPrevia } from "../components";
import { guardarConfig, leerConfig } from "../juego/config";
import { Juego } from "../juego/Juego";
import { t } from "../i18n/es";

/** Las vistas, en el orden en que se enseñan. */
const VISTAS = ["tap", "gifts", "follows"] as const;

type Vista = (typeof VISTAS)[number];

/**
 * Rótulo de un diseño.
 *
 * Rust publica solo el identificador (docs/decisions.md D4), así que si aún no
 * hay rótulo se enseña el identificador en vez de un hueco: un diseño nuevo sin
 * traducir tiene que verse igualmente.
 */
function rotuloDe(id: string | undefined): { nombre: string; resumen: string } {
  if (!id) return { nombre: "", resumen: "" };
  return t.overlay.catalogo[id] ?? { nombre: id, resumen: "" };
}

interface Props {
  /** Raíz del servidor de overlays, o `null` si no arrancó. */
  base: string | null;
  /** Dirección para OBS de cada vista, con su token. */
  urls: Record<string, string>;
  /** Diseño elegido de cada vista. */
  seleccion: Record<string, string>;
  /** Los diseños disponibles y sus vistas. */
  disenos: OverlayDesignInfo[];
  /** Mientras el motor confirma el cambio. */
  busy: boolean;
  onChoose: (vista: string, diseno: string) => void;
}

/**
 * Dirección que carga la vista previa de un diseño.
 *
 * `demo=1` es lo único que la distingue de la que se pega en OBS: el mismo
 * documento, los mismos assets, el mismo pintado.
 */
function urlDePrevia(base: string, vista: string, diseno: string): string {
  return `${base}?view=${encodeURIComponent(vista)}&diseno=${encodeURIComponent(diseno)}&demo=1`;
}

export function Overlays({ base, urls, seleccion, disenos, busy, onChoose }: Props) {
  const [vista, setVista] = useState<Vista>("tap");
  const [creando, setCreando] = useState(false);

  /**
   * Qué juego tiene la configuración desplegada.
   *
   * Es un **identificador** y no un booleano a propósito: el día que otro juego tenga
   * configuración propia, su fila solo tiene que poner su id aquí y el sistema entero
   * —el botón, el desplegado y el cierre— ya vale para él.
   */
  const [desplegado, setDesplegado] = useState<string | null>(null);

  /**
   * Si Beyblades está encendido en el overlay.
   *
   * Vive aquí, y no dentro del panel, porque lo escriben **dos** sitios: la fila de la
   * tarjeta («Usar este») y el botón de dentro («Activar» / «Desactivar»). Con una
   * copia en cada uno, el que no escribe se queda viejo y la fila diría «En antena»
   * mientras el panel enseña «Activar». Se lee del mismo sitio que lee el panel
   * —`localStorage`— así que sigue habiendo una sola verdad.
   */
  const [beybladesActivo, setBeybladesActivo] = useState(() => leerConfig().activo);
  const cambiarBeyblades = useCallback((activo: boolean) => {
    guardarConfig({ ...leerConfig(), activo });
    setBeybladesActivo(activo);
  }, []);

  if (base === null) {
    return (
      <div className="grid-panel">
        <Card title={t.overlay.title}>
          <p className="empty">{t.overlay.unavailable}</p>
        </Card>
      </div>
    );
  }

  /* Marcadores y juegos van en **secciones distintas** porque no se eligen igual: un
     marcador dice lo que ha pasado y se elige por vista; un juego se mueve con el
     ritmo de los taps y solo va en Tap tap. Antes eran once filas en la misma lista y
     no había forma de saber cuál era cuál salvo por el nombre. */
  const marcadores = disenos.filter((diseno) => diseno.tipo === "marcador");
  const juegos = disenos.filter((diseno) => diseno.tipo === "juego");

  const deLaVista = marcadores.filter((diseno) => diseno.vistas.includes(vista));
  const elegido = seleccion[vista];
  const actual = deLaVista.find((diseno) => diseno.id === elegido) ?? deLaVista[0];

  /* La previa sigue a lo último que se eligió: si el juego está puesto, enseña el
     juego —que vive en el hueco de Tap tap— aunque la lista de marcadores esté en
     otra vista. Si no, la previa diría una cosa y la antena otra. */
  const juegoPuesto = juegos.find((diseno) => diseno.id === seleccion.tap);
  const previa = juegoPuesto && vista === "tap" ? juegoPuesto : actual;

  /** Elige un juego para Tap tap y deja la previa enseñándolo. */
  const ponerJuego = (id: string) => {
    setVista("tap");
    onChoose("tap", id);
  };

  return (
    <div className="grid-panel overlays">
      <p className="hint">{t.overlay.hint}</p>

      {/* Dos columnas: a la izquierda lo que se configura —las direcciones, los
          marcadores y los juegos— y a la derecha **la previa, con la columna entera
          para ella**.
          Antes la previa iba dentro de la tarjeta de diseños, al lado de la lista, y
          las dos se estorbaban: la previa de un marcador mide 420x524, así que
          empujaba la tarjeta a 706 px de alto y la página entera a 950 para 674 de
          alto. Con su propia columna entra **a tamaño natural**. */}
      <div className="overlays-columnas">
        <div className="stack">
          {/* Las tres direcciones, siempre a la vista: se pegan en OBS una sola vez
              y conviene tenerlas todas juntas cuando se monta la escena. */}
          <Card title={t.overlay.address}>
            <ul className="direcciones">
              {VISTAS.map((cual) => (
                <li key={cual}>
                  <span className="direccion-vista">{t.overlay.views[cual].title}</span>
                  <Copiar texto={urls[cual]} />
                </li>
              ))}
            </ul>
            <p className="hint">{t.overlay.size}</p>
          </Card>

          <Card title={t.overlay.designs}>
            {/* Sin aviso propio de la sección: las pestañas ya dicen qué vista es cada
                una y debajo va el aviso de la vista elegida. El renglón que había aquí
                repetía eso mismo y le quitaba a la lista los 34 px que le faltaban
                para enseñar los ocho marcadores sin barra. */}
            <div className="vista-switch" role="tablist">
              {VISTAS.map((cual) => (
                <button
                  key={cual}
                  type="button"
                  role="tab"
                  aria-selected={cual === vista}
                  className={cual === vista ? "active" : "ghost"}
                  onClick={() => setVista(cual)}
                >
                  {t.overlay.views[cual].title}
                  <span className="switch-diseno">{rotuloDe(seleccion[cual]).nombre}</span>
                </button>
              ))}
            </div>

            <p className="hint">{t.overlay.views[vista].hint}</p>

            {actual ? (
              <ul className="disenos">
                {deLaVista.map((diseno) => {
                  const rotulo = rotuloDe(diseno.id);
                  return (
                    <li
                      key={diseno.id}
                      className={diseno.id === elegido ? "diseno activo" : "diseno"}
                    >
                      <span className="diseno-texto">
                        <strong>{rotulo.nombre}</strong>
                        <span>{rotulo.resumen}</span>
                      </span>
                      {diseno.id === elegido ? (
                        <span className="etiqueta">{t.overlay.inUse}</span>
                      ) : (
                        <button
                          type="button"
                          className="ghost"
                          disabled={busy}
                          onClick={() => onChoose(vista, diseno.id)}
                        >
                          {t.overlay.use}
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="empty">{t.overlay.empty}</p>
            )}
          </Card>

          {/* La sección de juegos: **el contenedor de todos los minijuegos**, con una
              tarjeta por juego y el mismo tamaño para todas. Un juego ocupa el hueco de
              Tap tap, así que se dice: mientras haya uno puesto, esa vista no enseña el
              marcador.

              Beyblades no sale del catálogo de Rust —es un overlay propio, con su
              servidor de comandos y su configuración—, así que su fila se escribe aquí
              con el mismo marcado y los mismos estilos que las demás. Su configuración
              no vive en un bloque aparte debajo: se despliega aquí dentro. */}
          <Card
            title={t.overlay.games}
            actions={
              <button
                type="button"
                className="ghost"
                aria-expanded={creando}
                onClick={() => setCreando((abierto) => !abierto)}
              >
                {t.overlay.gameCreate}
              </button>
            }
          >
            <p className="hint">{t.overlay.gamesHint}</p>

            {/* La lista nunca está vacía: Beyblades no depende del catálogo. */}
            <ul className="disenos disenos-juegos">
              {juegos.map((juego) => {
                const rotulo = rotuloDe(juego.id);
                const puesto = seleccion.tap === juego.id;
                return (
                  <li key={juego.id} className={puesto ? "diseno activo" : "diseno"}>
                    <span className="diseno-texto">
                      <strong>{rotulo.nombre}</strong>
                      <span>{rotulo.resumen}</span>
                    </span>
                    {puesto ? (
                      <span className="etiqueta">{t.overlay.inUse}</span>
                    ) : (
                      <button
                        type="button"
                        className="ghost"
                        disabled={busy}
                        onClick={() => ponerJuego(juego.id)}
                      >
                        {t.overlay.use}
                      </button>
                    )}
                  </li>
                );
              })}

              <li className={beybladesActivo ? "diseno activo" : "diseno"}>
                <span className="diseno-texto">
                  <strong>{rotuloDe("beyblades").nombre}</strong>
                  <span>{rotuloDe("beyblades").resumen}</span>
                </span>
                <span className="diseno-acciones">
                  {beybladesActivo ? (
                    <span className="etiqueta">{t.overlay.inUse}</span>
                  ) : (
                    <button type="button" className="ghost" onClick={() => cambiarBeyblades(true)}>
                      {t.overlay.use}
                    </button>
                  )}
                  <button
                    type="button"
                    className="ghost"
                    aria-expanded={desplegado === "beyblades"}
                    onClick={() =>
                      setDesplegado((cual) => (cual === "beyblades" ? null : "beyblades"))
                    }
                  >
                    {desplegado === "beyblades" ? t.overlay.collapse : t.overlay.configure}
                  </button>
                </span>
              </li>
            </ul>

            {/* La configuración del juego desplegado, dentro de la propia tarjeta: lo
                que viene después en la página baja solo, sin alturas fijas de por medio. */}
            {desplegado === "beyblades" ? (
              <div className="juego-desplegado">
                <Juego activo={beybladesActivo} onActivo={cambiarBeyblades} />
              </div>
            ) : null}

            {creando ? (
              <div className="juegos-alta">
                <span className="tira-rotulo">{t.overlay.gamesSoon}</span>
                <p className="hint">{t.overlay.gamesSoonHint}</p>
              </div>
            ) : null}
          </Card>
        </div>

        {previa ? (
          /* Sin rótulo de sección a propósito: la barra de la propia previa ya dice
             que es la vista previa y qué diseño está enseñando, y un rótulo encima
             sería la misma palabra dos veces. */
          <Card>
            <VistaPrevia
              url={urlDePrevia(base, vista, previa.id)}
              ancho={previa.previa.ancho}
              alto={previa.previa.alto}
              etiqueta={t.overlay.preview}
              nota={`${t.overlay.simulator} · ${previa.id}`}
            />
            <p className="hint">{t.overlay.previewHint}</p>
          </Card>
        ) : null}
      </div>
    </div>
  );
}

/**
 * El marco de la vista previa vive en `components.tsx`: lo comparten esta página y
 * la de Alertas, que también enseña su overlay de verdad. Tener dos copias de la
 * misma cuenta de escala sería dos sitios donde equivocarse con el tamaño.
 */
