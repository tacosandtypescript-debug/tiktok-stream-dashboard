//! La rejilla de voces y sus estados.
//!
//! Es tonta a proposito: recibe las tarjetas ya montadas y solo decide **como se
//! reparten** y que se enseña mientras no hay nada. Quien sabe de voces es la
//! biblioteca; quien sabe de columnas es esto.
//!
//! Mientras carga se enseñan **esqueletos** con la forma de una tarjeta, no un
//! «cargando» en medio del hueco: la lista no da un salto cuando llegan los datos
//! porque el hueco ya estaba ocupado.

import { t } from "../i18n/es";

export type EstadoRejilla = "cargando" | "listo" | "vacio" | "error";

interface Props {
  estado: EstadoRejilla;
  /** Lo que se dice cuando no hay nada o cuando algo fallo. */
  mensaje?: string;
  /** El boton de reintentar, si el fallo se puede reintentar. */
  onReintentar?: () => void;
  /** Cuantas tarjetas se enseñan mientras carga (para no pintar 24 huecos). */
  esqueletos?: number;
  children?: React.ReactNode;
}

export function RejillaVoces({
  estado,
  mensaje,
  onReintentar,
  esqueletos = 8,
  children,
}: Props) {
  if (estado === "cargando") {
    return (
      <div className="voces-rejilla" aria-busy="true" aria-label={t.voces.cargando}>
        {Array.from({ length: esqueletos }, (_, indice) => (
          <div className="voz-tarjeta voz-esqueleto" key={indice} aria-hidden="true">
            <span className="voz-imagen" />
            <span className="voz-esqueleto-linea" />
            <span className="voz-esqueleto-linea corta" />
          </div>
        ))}
      </div>
    );
  }

  if (estado === "error") {
    return (
      <div className="voces-vacio" role="alert">
        <p className="voz-aviso">{mensaje ?? t.voces.errorCargar}</p>
        {onReintentar ? (
          <button type="button" className="ghost" onClick={onReintentar}>
            {t.voces.reintentar}
          </button>
        ) : null}
      </div>
    );
  }

  if (estado === "vacio") {
    return (
      <div className="voces-vacio">
        <p className="hint">{mensaje ?? t.voces.sinResultados}</p>
      </div>
    );
  }

  return <div className="voces-rejilla">{children}</div>;
}
