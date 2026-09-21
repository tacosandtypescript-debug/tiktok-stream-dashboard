//! «+ Agregar voz»: pegar un identificador y **comprobarlo antes de guardar**.
//!
//! Es un desplegable compacto y no una ventana flotante: ocupa una fila cuando
//! está cerrado, se abre donde está el botón y no tapa la biblioteca, que es lo que
//! se sigue mirando mientras se pega un identificador.
//!
//! Comprobar **no guarda**: primero se enseña la voz que hay al otro lado —su
//! portada, su nombre, su autor, su idioma y una muestra si la trae— para poder
//! ver que el identificador pegado es el que se quería. Guardar es el segundo paso,
//! y se da a propósito.

import { useState } from "react";

import type { TtsVozFish } from "../api";
import { t } from "../i18n/es";
import { useReproductor } from "./ReproductorMuestras";
import { idiomaLegible, imagenDeVoz, primeraMuestra } from "./tipos";
import { vocesApi } from "./vocesApi";

interface Props {
  /** Guarda la voz comprobada. Devuelve cuando el motor ya la tiene. */
  onGuardar: (id: string, nombre: string) => Promise<void>;
  /** Cerrar el desplegable. */
  onCerrar: () => void;
}

export function ImportarVoz({ onGuardar, onCerrar }: Props) {
  const reproductor = useReproductor();
  const [id, setId] = useState("");
  const [nombre, setNombre] = useState("");
  const [comprobando, setComprobando] = useState(false);
  const [voz, setVoz] = useState<TtsVozFish | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);
  const [guardada, setGuardada] = useState(false);

  const comprobar = () => {
    const limpio = id.trim();
    if (!limpio) return;
    setComprobando(true);
    setError(null);
    setVoz(null);
    setGuardada(false);
    void vocesApi
      .obtener(limpio)
      .then((encontrada) => {
        if (!encontrada.id) {
          setError(t.voces.yaNoEsta);
          return;
        }
        setVoz(encontrada);
      })
      .catch((causa: unknown) => setError(String(causa)))
      .finally(() => setComprobando(false));
  };

  const guardar = () => {
    if (!voz) return;
    setGuardando(true);
    setError(null);
    void onGuardar(voz.id, nombre)
      .then(() => setGuardada(true))
      .catch((causa: unknown) => setError(String(causa)))
      .finally(() => setGuardando(false));
  };

  const muestra = voz ? primeraMuestra(voz) : null;

  return (
    <section className="voz-importar" aria-label={t.voces.agregarTitulo}>
      <header className="voz-importar-cabeza">
        <span className="tira-rotulo">{t.voces.agregarTitulo}</span>
        <button type="button" className="ghost tiny" onClick={onCerrar}>
          {t.voces.cerrar}
        </button>
      </header>
      <p className="hint">{t.voces.agregarHint}</p>

      <div className="alta-linea">
        <div className="campo">
          <label htmlFor="voz-id">{t.voces.referenceId}</label>
          <input
            id="voz-id"
            value={id}
            placeholder={t.voces.referenceIdPlaceholder}
            spellCheck={false}
            autoComplete="off"
            onChange={(evento) => setId(evento.target.value)}
            onKeyDown={(evento) => {
              if (evento.key === "Enter" && !evento.nativeEvent.isComposing) comprobar();
            }}
          />
        </div>
        <div className="campo">
          <label htmlFor="voz-nombre-propio">{t.voces.nombreOpcional}</label>
          <input
            id="voz-nombre-propio"
            value={nombre}
            placeholder={t.voces.nombreOpcionalPlaceholder}
            maxLength={40}
            spellCheck={false}
            onChange={(evento) => setNombre(evento.target.value)}
          />
        </div>
        <button type="button" disabled={!id.trim() || comprobando} onClick={comprobar}>
          {comprobando ? t.voces.comprobando : t.voces.comprobar}
        </button>
      </div>
      <p className="hint">{t.voces.nombreOpcionalHint}</p>

      {error ? <p className="voz-aviso">{error}</p> : null}

      {voz ? (
        <div className="voz-comprobada">
          {imagenDeVoz(voz) ? (
            <img className="voz-comprobada-imagen" src={imagenDeVoz(voz)} alt="" loading="lazy" />
          ) : (
            <span className="voz-comprobada-imagen voz-imagen-vacia">{t.voces.sinImagen}</span>
          )}
          <div className="voz-comprobada-datos">
            <span className="voz-titulo">{voz.titulo || voz.id}</span>
            <span className="voz-rotulo">
              {voz.idiomas.length > 0 ? (
                <span className="etiqueta">{voz.idiomas.map(idiomaLegible).join(" · ")}</span>
              ) : null}
              {voz.autor.nombre ? <span className="voz-motor">{voz.autor.nombre}</span> : null}
            </span>
            {muestra && reproductor ? (
              <button
                type="button"
                className="ghost tiny"
                onClick={() =>
                  reproductor.alternar({
                    clave: `importar:${voz.id}`,
                    titulo: `${voz.titulo || voz.id} · ${t.voces.muestraOficial}`,
                    url: muestra.audio,
                  })
                }
              >
                ▶ {t.voces.escuchar}
              </button>
            ) : (
              <span className="hint">{t.voces.sinMuestras}</span>
            )}
          </div>
        </div>
      ) : null}

      {voz ? (
        <div className="voz-comprobada-acciones">
          <button type="button" disabled={guardando || guardada} onClick={guardar}>
            {guardada ? `✓ ${t.voces.guardada}` : t.voces.guardarEnMisVoces}
          </button>
          {guardada ? <span className="hint">{t.voces.guardadaAviso}</span> : null}
        </div>
      ) : null}
    </section>
  );
}
