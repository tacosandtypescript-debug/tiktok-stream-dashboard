//! El menú ⋯ de una voz guardada.
//!
//! Es un `<details>` y no un desplegable propio a propósito: el navegador ya sabe
//! abrirlo, cerrarlo con Escape y darle el foco, y en una tarjeta compacta eso es
//! exactamente lo que hace falta. Meter un menú flotante con posicionamiento
//! calculado sería maquinaria nueva para el mismo resultado.
//!
//! Los textos largos —el identificador, la confirmación de borrado— van en el
//! `title` del elemento que los necesita, que es la regla de la casa para no
//! engordar las tarjetas.

import { useEffect, useRef, useState } from "react";

import { t } from "../i18n/es";

export interface AccionMenu {
  /** El texto del botón. */
  etiqueta: string;
  /** Lo que se dice al pasar el ratón, si hace falta explicar algo. */
  pista?: string;
  onClick: () => void;
  /** Un aviso que se confirma antes de hacerlo (borrar, por ejemplo). */
  confirmar?: string;
  /** Deshabilitado (una operación en curso, por ejemplo). */
  deshabilitado?: boolean;
  /** La acción que saca el dato de sitio: se pinta distinta. */
  peligrosa?: boolean;
}

export function MenuVoz({ acciones }: { acciones: AccionMenu[] }) {
  const contenedor = useRef<HTMLDetailsElement | null>(null);
  const [abierto, setAbierto] = useState(false);

  // Un clic fuera cierra. Un menú que se queda abierto mientras se pulsa en otra
  // tarjeta parece parte de la tarjeta en la que se pulsó.
  useEffect(() => {
    if (!abierto) return;
    const alPulsar = (evento: MouseEvent) => {
      if (!contenedor.current?.contains(evento.target as Node)) setAbierto(false);
    };
    document.addEventListener("mousedown", alPulsar);
    return () => document.removeEventListener("mousedown", alPulsar);
  }, [abierto]);

  return (
    <details
      className="voz-menu"
      ref={contenedor}
      open={abierto}
      onToggle={(evento) => setAbierto((evento.target as HTMLDetailsElement).open)}
    >
      <summary className="ghost tiny" title={t.voces.menu} aria-label={t.voces.menu}>
        ⋯
      </summary>
      <div className="voz-menu-lista" role="menu">
        {acciones.map((accion) => (
          <button
            key={accion.etiqueta}
            type="button"
            role="menuitem"
            className={accion.peligrosa ? "ghost tiny peligrosa" : "ghost tiny"}
            title={accion.pista}
            disabled={accion.deshabilitado}
            onClick={() => {
              if (accion.confirmar && !window.confirm(accion.confirmar)) return;
              setAbierto(false);
              accion.onClick();
            }}
          >
            {accion.etiqueta}
          </button>
        ))}
      </div>
    </details>
  );
}
