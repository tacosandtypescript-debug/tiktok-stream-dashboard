//! La biblioteca de voces vista desde la tarjeta: **pedir**, no reproducir.
//!
//! Aquí no hay ningún `<audio>`: el único elemento de audio de la aplicación vive
//! en `previewAudio.tsx`, y este fichero es el **adaptador** que traduce "la
//! muestra de esta voz" a una petición del coordinador. Se mantiene el vocabulario
//! de la biblioteca —clave de la voz, título, progreso— porque las tarjetas ya lo
//! hablaban, y cambiarlo obligaría a tocar diez sitios para lo mismo.
//!
//! Las muestras que se reproducen son las **oficiales de Fish**: direcciones a
//! audios que ya existen. Recorrer el catálogo escuchando voces no gasta ni una
//! síntesis —solo se genera cuando una voz no trae ninguna, y eso lo pide el
//! streamer a propósito—.

import { createContext, useContext, useEffect, useMemo } from "react";

import { usePreviewAudio, type EstadoPreview } from "../previewAudio";
import { t } from "../i18n/es";

/** En qué está el reproductor. */
export type EstadoMuestra = EstadoPreview;

/** Lo que está sonando. */
export interface Sonando {
  /** Clave de la voz (`proveedor:referencia`), para que la tarjeta se reconozca. */
  clave: string;
  /** Lo que se enseña en la barra: el nombre de la voz y de la muestra. */
  titulo: string;
  /** De 0 a 1. `null` mientras no se sabe (el audio no ha dicho cuánto dura). */
  progreso: number | null;
}

interface Reproductor {
  sonando: Sonando | null;
  estado: EstadoMuestra;
  /** El motivo, cuando el estado es `error`. */
  error: string | null;
  /** Suena esa muestra; si ya estaba sonando **esa misma**, la pausa. */
  alternar: (pedido: {
    clave: string;
    titulo: string;
    /** La dirección, o la promesa que la resuelve (las muestras van firmadas). */
    url: string | Promise<string | undefined>;
  }) => void;
  /** Para todo. Se llama al salir de la biblioteca. */
  parar: () => void;
  /** Vuelve a intentar la última que falló. */
  reintentar: () => void;
}

const Contexto = createContext<Reproductor | null>(null);

/**
 * El reproductor de la biblioteca.
 *
 * Se lee del coordinador global, así que **una muestra de voz también calla un
 * sonido de la biblioteca de alertas** y al revés. Si no hay coordinador —o no hay
 * proveedor de la biblioteca, como en el banco de la interfaz—, el hook devuelve
 * `null` y la tarjeta se pinta sin botón de escuchar: es preferible una tarjeta
 * muda a una que reviente por no encontrar el contexto.
 */
export function useReproductor(): Reproductor | null {
  const preview = usePreviewAudio();
  return useMemo(() => {
    if (!preview) return null;
    // Solo se enseña como "sonando" lo que es **una muestra de voz**: si lo que
    // suena es la previa de una alerta, la barra de la biblioteca no tiene nada que
    // decir, y sin esta comprobación diría que suena una voz que no suena.
    const activo = preview.actual?.origen === "muestra-voz" ? preview.actual : null;
    return {
      sonando: activo
        ? {
            clave: activo.id,
            titulo: activo.titulo,
            progreso: preview.progreso,
          }
        : null,
      estado: activo ? preview.estado : "parado",
      error: activo ? preview.error : null,
      alternar: (pedido) =>
        preview.alternar({
          origen: "muestra-voz",
          id: pedido.clave,
          titulo: pedido.titulo,
          url: pedido.url,
        }),
      parar: preview.parar,
      reintentar: preview.reintentar,
    };
  }, [preview]);
}

/**
 * El proveedor de la biblioteca y su barra.
 *
 * Ya no reproduce nada: presta el reproductor del coordinador a las tarjetas y
 * pinta la barra de lo que está sonando.
 */
export function ReproductorMuestras({ children }: { children: React.ReactNode }) {
  const valor = useReproductor();
  const parar = valor?.parar;
  // Al desmontarse —cambiar de vista dentro de la página de Voz, o de pestaña— no
  // puede quedarse sonando una muestra: el `<audio>` ya no vive aquí, así que sin
  // esto la muestra sobreviviría a la biblioteca que la pidió.
  useEffect(() => () => parar?.(), [parar]);
  return (
    <Contexto.Provider value={valor}>
      {children}
      <BarraDeReproduccion />
    </Contexto.Provider>
  );
}

/**
 * La barra de lo que está sonando.
 *
 * Va **fuera** de las tarjetas, abajo del todo de la biblioteca: dice qué suena
 * aunque la tarjeta se haya quedado fuera de la parte visible de la lista, y es
 * donde se corta. Sin nada sonando no ocupa ni un píxel.
 */
function BarraDeReproduccion() {
  const reproductor = useContext(Contexto);
  if (!reproductor?.sonando && reproductor?.estado !== "error") return null;

  return (
    <div className="muestra-barra" role="status" aria-live="polite">
      {reproductor.estado === "error" ? (
        <>
          <span className="muestra-aviso">{reproductor.error ?? t.voces.muestraError}</span>
          <button type="button" className="ghost tiny" onClick={reproductor.reintentar}>
            {t.voces.reintentar}
          </button>
        </>
      ) : (
        <>
          <span className={`muestra-punto ${reproductor.estado}`} aria-hidden="true" />
          <span className="muestra-titulo" title={reproductor.sonando?.titulo}>
            {reproductor.estado === "cargando" ? t.voces.cargandoMuestra : reproductor.sonando?.titulo}
          </span>
          <span className="muestra-progreso" aria-hidden="true">
            <span style={{ width: `${Math.round((reproductor.sonando?.progreso ?? 0) * 100)}%` }} />
          </span>
        </>
      )}
      {reproductor.sonando || reproductor.estado === "error" ? (
        <button type="button" className="ghost tiny" onClick={reproductor.parar}>
          {t.voces.pararMuestra}
        </button>
      ) : null}
    </div>
  );
}
