//! El detalle de una voz: lo que no cabe en la tarjeta.
//!
//! Se enseña en un panel dentro de la propia biblioteca —no en una ventana
//! flotante— porque lo que se viene a hacer aquí es **escuchar muestras** y
//! decidir, y eso se hace mejor sin perder de vista la lista.
//!
//! Las muestras van numeradas y con su texto: es lo que permite comprobar que una
//! voz dice lo que parece que dice antes de guardarla. Y si no hay ninguna, se
//! ofrece **generar una prueba**, diciendo antes que eso sí se cobra.

import { useState } from "react";

import type { TtsMuestraVoz } from "../api";
import { t } from "../i18n/es";
import { useReproductor } from "./ReproductorMuestras";
import { claveDeVoz, idiomaLegible } from "./tipos";

interface Props {
  /** La voz del catálogo, o los datos equivalentes de una guardada. */
  voz: {
    id: string;
    titulo: string;
    descripcion: string;
    portada: string;
    idiomas: string[];
    tags: string[];
    muestras: TtsMuestraVoz[];
    autor: { id: string; nombre: string; avatar: string };
    actualizado_en: string;
  };
  /** El nombre que se enseña, ya resuelto. */
  nombre: string;
  /** `fish-audio` o `edge`: con que motor se probaría. */
  proveedor: string;
  /** Si es una voz guardada: habilita «Generar prueba». */
  guardada?: boolean;
  /** Cerrar el panel. */
  onCerrar: () => void;
  /** Genera una prueba. Devuelve el nombre del fichero sintetizado. */
  onGenerarPrueba?: () => Promise<string>;
}

export function DetallesVoz({
  voz,
  nombre,
  proveedor,
  guardada,
  onCerrar,
  onGenerarPrueba,
}: Props) {
  const reproductor = useReproductor();
  const [copiado, setCopiado] = useState(false);
  const [generando, setGenerando] = useState(false);
  const [errorPrueba, setErrorPrueba] = useState<string | null>(null);
  /** El fichero de la prueba generada, si se generó. */
  const [prueba, setPrueba] = useState<string | null>(null);

  const imagen = voz.portada || voz.autor.avatar;

  const copiar = () => {
    void navigator.clipboard?.writeText(voz.id).then(
      () => {
        setCopiado(true);
        setTimeout(() => setCopiado(false), 1500);
      },
      () => setCopiado(false),
    );
  };

  const generar = () => {
    if (!onGenerarPrueba) return;
    setGenerando(true);
    setErrorPrueba(null);
    void onGenerarPrueba()
      .then((archivo) => {
        setPrueba(archivo);
        // La prueba recien hecha se reproduce: es lo que se acaba de pedir.
        if (reproductor) {
          reproductor.alternar({
            clave: `${claveDeVoz({ proveedor, referencia: voz.id })}:prueba`,
            titulo: `${nombre} · ${t.voces.generarPrueba}`,
            url: archivo,
          });
        }
      })
      .catch((causa: unknown) => setErrorPrueba(String(causa)))
      .finally(() => setGenerando(false));
  };

  return (
    <aside className="voz-detalle" aria-label={`${t.voces.detalles}: ${nombre}`}>
      <header className="voz-detalle-cabeza">
        <span className="voz-detalle-titulo" title={nombre}>
          {nombre}
        </span>
        <button type="button" className="ghost tiny" onClick={onCerrar}>
          {t.voces.cerrar}
        </button>
      </header>

      <div className="voz-detalle-cuerpo">
        {imagen ? (
          <img className="voz-detalle-imagen" src={imagen} alt="" loading="lazy" />
        ) : (
          <span className="voz-detalle-imagen voz-imagen-vacia">{t.voces.sinImagen}</span>
        )}

        {voz.descripcion ? <p className="hint">{voz.descripcion}</p> : null}

        <dl className="voz-detalle-datos">
          {voz.idiomas.length > 0 ? (
            <>
              <dt>{t.voces.idioma}</dt>
              <dd>{voz.idiomas.map(idiomaLegible).join(" · ")}</dd>
            </>
          ) : null}
          {voz.autor.nombre ? (
            <>
              <dt>{t.voces.autor}</dt>
              <dd>{voz.autor.nombre}</dd>
            </>
          ) : null}
          {voz.tags.length > 0 ? (
            <>
              <dt>{t.voces.etiquetas}</dt>
              <dd>{voz.tags.join(" · ")}</dd>
            </>
          ) : null}
          <dt>{t.voces.identificador}</dt>
          <dd>
            <code className="path" title={voz.id}>
              {voz.id}
            </code>
            <button type="button" className="ghost tiny" onClick={copiar}>
              {copiado ? t.voces.copiado : t.voces.copiarId}
            </button>
          </dd>
          {voz.actualizado_en ? (
            <>
              <dt>{t.voces.actualizado("")}</dt>
              <dd>{voz.actualizado_en}</dd>
            </>
          ) : null}
        </dl>

        <div className="voz-detalle-muestras">
          <span className="tira-rotulo">{t.voces.muestras}</span>
          {voz.muestras.length === 0 ? (
            <>
              <p className="hint">{t.voces.sinMuestrasHint}</p>
              {guardada && onGenerarPrueba ? (
                <>
                  <button type="button" className="ghost" disabled={generando} onClick={generar}>
                    {generando ? t.voces.generandoPrueba : t.voces.generarPrueba}
                  </button>
                  <p className="hint">{t.voces.generarPruebaAviso}</p>
                </>
              ) : null}
            </>
          ) : (
            <ul className="voz-muestras">
              {voz.muestras.map((muestra, indice) => {
                const titulo = muestra.titulo || t.voces.muestraNumero(indice + 1);
                const sonando =
                  reproductor?.sonando?.clave ===
                  `${claveDeVoz({ proveedor, referencia: voz.id })}:${indice}`;
                return (
                  <li key={`${muestra.audio}-${indice}`}>
                    <button
                      type="button"
                      className="ghost tiny"
                      onClick={() =>
                        reproductor?.alternar({
                          clave: `${claveDeVoz({ proveedor, referencia: voz.id })}:${indice}`,
                          titulo: `${nombre} · ${titulo}`,
                          url: muestra.audio,
                        })
                      }
                    >
                      {sonando ? "❚❚" : "▶"} {titulo}
                    </button>
                    <span className="hint" title={muestra.texto}>
                      {muestra.texto || t.voces.muestraSinTexto}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}

          {prueba ? (
            <button
              type="button"
              className="ghost tiny"
              onClick={() =>
                reproductor?.alternar({
                  clave: `${claveDeVoz({ proveedor, referencia: voz.id })}:prueba`,
                  titulo: `${nombre} · ${t.voces.generarPrueba}`,
                  url: prueba,
                })
              }
            >
              ▶ {t.voces.generarPrueba}
            </button>
          ) : null}
          {errorPrueba ? <p className="voz-aviso">{errorPrueba}</p> : null}
        </div>
      </div>
    </aside>
  );
}
