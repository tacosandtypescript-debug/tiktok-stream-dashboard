//! Overlays para OBS: elegir diseño por vista, verlo en vivo y copiar la
//! dirección.
//!
//! Tres decisiones que se ven en esta página:
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
//!
//! Coste: un diseño cargado es un renderer más de WebView2 mientras la pestaña
//! está abierta (docs/plan-review.md §175). Por eso se pinta **una vista a la
//! vez** y no las tres: pasar de pestaña desmonta el marco y lo libera.

import { useState } from "react";

import type { OverlayDesignInfo } from "../api";
import { Card, Copiar, VistaPrevia } from "../components";
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

  if (base === null) {
    return (
      <div className="grid-panel">
        <Card title={t.overlay.title}>
          <p className="empty">{t.overlay.unavailable}</p>
        </Card>
      </div>
    );
  }

  const deLaVista = disenos.filter((diseno) => diseno.vistas.includes(vista));
  const elegido = seleccion[vista];
  const actual = deLaVista.find((diseno) => diseno.id === elegido) ?? deLaVista[0];

  return (
    <div className="grid-panel overlays">
      <p className="hint">{t.overlay.hint}</p>

      {/* Dos columnas: a la izquierda lo que se configura —las direcciones y la
          lista de diseños— y a la derecha **la previa, con la columna entera para
          ella**.
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
        </div>

        {actual ? (
          /* Sin rótulo de sección a propósito: la barra de la propia previa ya dice
             que es la vista previa y qué diseño está enseñando, y un rótulo encima
             sería la misma palabra dos veces. */
          <Card>
            <VistaPrevia
              url={urlDePrevia(base, vista, actual.id)}
              ancho={actual.previa.ancho}
              alto={actual.previa.alto}
              etiqueta={t.overlay.preview}
              nota={`${t.overlay.simulator} · ${actual.id}`}
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
