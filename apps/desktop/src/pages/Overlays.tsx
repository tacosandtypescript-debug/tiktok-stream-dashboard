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

import { useLayoutEffect, useRef, useState } from "react";

import type { OverlayDesignInfo } from "../api";
import { Card, Copiar } from "../components";
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
    <div className="grid-panel">
      <p className="hint">{t.overlay.hint}</p>

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
          /* La previa y la lista van en dos columnas: el marcador mide 420 px de
             ancho y dejarlo solo en una tarjeta de pantalla completa llenaba de
             vacio los otros mil. */
          <div className="diseno-panel">
            <VistaPrevia
              url={urlDePrevia(base, vista, actual.id)}
              previa={actual.previa}
              diseno={actual.id}
            />
            <div className="diseno-columna">
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
              <p className="hint">{t.overlay.previewHint}</p>
            </div>
          </div>
        ) : (
          <p className="empty">{t.overlay.empty}</p>
        )}
      </Card>
    </div>
  );
}

/**
 * El marco de la vista previa, escalado al ancho que haya.
 *
 * El diseño se dibuja en su lienzo real (420 px de ancho, o 1080×1920 en los de
 * pantalla completa) y se escala entero. Se mide con `ResizeObserver` en vez de
 * con un ancho fijo porque la ventana se redimensiona: con un tamaño fijo, la
 * previa se salía de la tarjeta o dejaba franjas.
 */
function VistaPrevia({
  url,
  previa,
  diseno,
}: {
  url: string;
  previa: { ancho: number; alto: number };
  diseno: string;
}) {
  const caja = useRef<HTMLDivElement>(null);
  const [escala, setEscala] = useState(1);

  useLayoutEffect(() => {
    const nodo = caja.current;
    if (!nodo) return;
    const medir = () => {
      const ancho = nodo.clientWidth;
      if (ancho > 0) setEscala(Math.min(1, ancho / previa.ancho));
    };
    medir();
    const observador = new ResizeObserver(medir);
    observador.observe(nodo);
    return () => observador.disconnect();
  }, [previa.ancho]);

  return (
    /*
     * El tope de ancho es `min(100%, lienzo)` y **no** `previa.ancho` a secas.
     *
     * Con el numero suelto, el marco crecia hasta los 1080 del iframe: se salia de
     * su columna de 460 y se pintaba encima de la lista de diseños. Y era un bucle,
     * porque la escala se calcula midiendo ese mismo marco — medía 1080, sacaba
     * escala 1, y el iframe volvia a medir 1080. Con el `min(100%, …)` el marco no
     * puede pasar de su columna, la medida sale 460, la escala sale 0,42 y todo
     * encaja.
     */
    <div className="previa-marco" style={{ maxWidth: `min(100%, ${previa.ancho}px)` }}>
      <div className="previa-barra">
        <span className="etiqueta">{t.overlay.preview}</span>
        <span className="previa-aviso">
          {t.overlay.simulator} · {diseno}
        </span>
      </div>
      <div
        className="previa-caja"
        ref={caja}
        style={{ height: Math.round(previa.alto * escala) }}
      >
        {/* La `key` recarga el marco al cambiar de diseño: sin ella, React
            reutilizaría el mismo `iframe` y el documento viejo seguiría pintado. */}
        <iframe
          key={url}
          className="previa"
          src={url}
          title={`${t.overlay.preview} · ${diseno}`}
          style={{
            width: previa.ancho,
            height: previa.alto,
            transform: `scale(${escala})`,
          }}
        />
      </div>
    </div>
  );
}
