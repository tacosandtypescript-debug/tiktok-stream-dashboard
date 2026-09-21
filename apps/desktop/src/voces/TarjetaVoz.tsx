//! La tarjeta de una voz: la misma para «Mis voces» y para «Explorar».
//!
//! **No sabe nada de Fish Audio.** Recibe una voz ya masticada y las acciones que
//! se le pueden hacer; quien la pinta decide cuales. Asi el mismo componente sirve
//! para las dos pestañas cambiando solo lo que se puede pulsar, que es justo lo que
//! pide el encargo: `▶ | Usar | ⋯` en las guardadas y `▶ | + Guardar` en el
//! catalogo.
//!
//! Prioridad de lo que se ve, en este orden: imagen, nombre, idioma, escuchar,
//! usar/guardar. Todo lo demas —autor, etiquetas, descripcion, muestras— vive en
//! el detalle, porque una biblioteca se recorre con la vista y no leyendo.

import { useState } from "react";

import { t } from "../i18n/es";
import { esVozDeFish, idiomaLegible } from "./tipos";

/** Lo que se puede hacer con una voz desde su tarjeta. */
export interface AccionesVoz {
  /** Escuchar la muestra oficial. Sin muestra no se pinta el boton. */
  onEscuchar?: () => void;
  /** Ponerla en uso (solo en «Mis voces»). */
  onUsar?: () => void;
  /** Guardarla en «Mis voces» (solo en «Explorar»). */
  onGuardar?: () => void;
  /** Abrir el detalle. */
  onDetalles?: () => void;
  /** El menu ⋯ de una voz guardada. */
  menu?: React.ReactNode;
}

interface Props {
  /** El nombre que se enseña, ya resuelto por quien la pinta. */
  nombre: string;
  /** El idioma, ya legible. Vacio si no se sabe. */
  idioma: string;
  /** De donde salio: «Fish Audio», «La de siempre»... */
  motor: string;
  /** La imagen. Puede ser una direccion remota, una local o nada. */
  imagen?: string;
  /** Si esta sonando **esta** voz. */
  sonando?: boolean;
  /** De 0 a 1, para la barrita de la que suena. */
  progreso?: number | null;
  /** Si es la que el lector esta usando ahora mismo. */
  enUso?: boolean;
  /** Una voz que no se puede usar todavia (sin entrenar, por ejemplo). */
  atenuada?: boolean;
  /** El texto del `title` de la imagen: la descripcion o el identificador. */
  pista?: string;
  /** Si ya esta guardada: en «Explorar» cambia `+ Guardar` por `✓ Guardada`. */
  guardada?: boolean;
  /** Ocupada (guardando, actualizando): los botones se apagan, no desaparecen. */
  ocupada?: boolean;
  acciones?: AccionesVoz;
}

/**
 * La imagen de la tarjeta, con su placeholder.
 *
 * Si la direccion falla se cae al placeholder **en el mismo hueco**: la rejilla no
 * se descuadra ni aparece el icono roto del navegador. Es lo que pide el encargo
 * para no depender de que Fish conteste.
 */
function Imagen({ url, pista }: { url?: string; pista?: string }) {
  const [fallo, setFallo] = useState(false);
  if (!url || fallo) {
    return (
      <span className="voz-imagen voz-imagen-vacia" aria-hidden="true">
        {t.voces.sinImagen}
      </span>
    );
  }
  return (
    <img
      className="voz-imagen"
      src={url}
      alt=""
      title={pista}
      loading="lazy"
      decoding="async"
      onError={() => setFallo(true)}
    />
  );
}

export function TarjetaVoz({
  nombre,
  idioma,
  motor,
  imagen,
  sonando,
  progreso,
  enUso,
  atenuada,
  pista,
  guardada,
  ocupada,
  acciones,
}: Props) {
  const clases = [
    "voz-tarjeta",
    sonando ? "sonando" : "",
    enUso ? "en-uso" : "",
    atenuada ? "atenuada" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <article className={clases}>
      <button
        type="button"
        className="voz-imagen-boton"
        onClick={acciones?.onDetalles}
        disabled={!acciones?.onDetalles}
        title={acciones?.onDetalles ? t.voces.verDetalles : undefined}
        aria-label={`${t.voces.verDetalles}: ${nombre}`}
      >
        <Imagen url={imagen} pista={pista} />
      </button>

      <div className="voz-datos">
        <span className="voz-titulo" title={nombre}>
          {nombre}
        </span>
        <span className="voz-rotulo">
          {idioma ? (
            <span className="etiqueta" title={idioma}>
              {idioma}
            </span>
          ) : null}
          <span className="voz-motor">{motor}</span>
        </span>
      </div>

      <div className="voz-acciones">
        {sonando ? (
          <span className="voz-suena" title={t.voces.sonando}>
            <span className="voz-suena-icono" aria-hidden="true">
              ❚❚
            </span>
            {progreso !== null && progreso !== undefined ? (
              <span className="voz-suena-barra" aria-hidden="true">
                <span style={{ width: `${Math.round(progreso * 100)}%` }} />
              </span>
            ) : null}
          </span>
        ) : (
          <button
            type="button"
            className="ghost tiny"
            onClick={acciones?.onEscuchar}
            disabled={!acciones?.onEscuchar}
            title={acciones?.onEscuchar ? t.voces.escuchar : t.voces.sinMuestra}
          >
            ▶ {t.voces.escuchar}
          </button>
        )}

        {acciones?.onUsar ? (
          enUso ? (
            <span className="etiqueta" title={t.voces.enUso}>
              {t.tts.voiceInUse}
            </span>
          ) : (
            <button
              type="button"
              className="ghost tiny"
              onClick={acciones.onUsar}
              disabled={ocupada}
            >
              {t.voces.usar}
            </button>
          )
        ) : null}

        {acciones?.onGuardar ? (
          guardada ? (
            <span className="etiqueta" title={t.voces.yaGuardada}>
              ✓ {t.voces.guardada}
            </span>
          ) : (
            <button
              type="button"
              className="ghost tiny"
              onClick={acciones.onGuardar}
              disabled={ocupada}
            >
              + {t.voces.guardar}
            </button>
          )
        ) : null}

        {acciones?.menu}
      </div>
    </article>
  );
}

/** El rotulo del motor, corto: es lo que distingue una voz de otra en la tarjeta. */
export function motorDeVoz(proveedor: string): string {
  return esVozDeFish(proveedor) ? t.tts.voiceProvider.fish : t.tts.voiceProvider.edge;
}

/** El idioma, ya legible. Se exporta para no repetir el `??` en cada sitio. */
export function idiomaDeVoz(codigo: string): string {
  return idiomaLegible(codigo);
}
