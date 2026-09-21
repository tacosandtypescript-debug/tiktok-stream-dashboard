//! El panel del **contenedor del mensaje**: su estilo, su letra y sus animaciones.
//!
//! Sustituye al editor del aviso mientras está abierto, y no se lleva a un diálogo: el
//! aviso de la izquierda y la **previa de la derecha siguen a la vista**, así que lo que
//! se cambia se ve al momento —la previa recibe cada cambio por `postMessage`—. Un
//! diálogo taparía justo lo que hay que mirar.
//!
//! Los mandos no están escritos uno a uno: salen del catálogo (`mensaje.ts`). Un estilo
//! declara los suyos y aquí se pintan esos y solo esos, que es lo que evita veinticinco
//! campos a la vez. Añadir un mando nuevo es una línea allí.
//!
//! Y va en **tres grupos** —el estilo, la letra y la animación— porque de una tirada no
//! caben: el panel mide lo que mide el editor, y con los treinta mandos juntos habría que
//! desplazarse para encontrar cualquiera. En tres pestañas, cada una cabe casi entera.

import { useState } from "react";

import type { AjusteAviso, MensajeAviso } from "./api";
import {
  ALINEACIONES,
  ANIMACIONES_MENSAJE,
  ANIMACIONES_TEXTO,
  ESTILOS,
  FUENTES,
  MANDOS_CONTENEDOR,
  MANDOS_TEXTO,
  PERMANENCIAS_MENSAJE,
  PESOS,
  estiloMensaje,
  mensajeDe,
  nombreEstilo,
  parcheDeEstilo,
  usaIntensidad,
  type MandoMensaje,
} from "./mensaje";
import { Card } from "./components";
import { RITMOS } from "./animaciones";
import { t } from "./i18n/es";

/** Los tres grupos del panel. */
type Grupo = "estilo" | "texto" | "animacion";

const GRUPOS: Array<{ id: Grupo; rotulo: string }> = [
  { id: "estilo", rotulo: t.mensaje.grupoEstilo },
  { id: "texto", rotulo: t.mensaje.grupoTexto },
  { id: "animacion", rotulo: t.mensaje.grupoAnimacion },
];

interface Props {
  /** El aviso que se está editando, para el rótulo. */
  aviso: string;
  ajuste: AjusteAviso;
  busy: boolean;
  /** Un cambio del contenedor. Se guarda entero, como el resto del aviso. */
  onCambiar: (parche: Partial<MensajeAviso>) => void;
  onCerrar: () => void;
}

export function PanelMensaje({ aviso, ajuste, busy, onCambiar, onCerrar }: Props) {
  // El mensaje **completo**: si el motor que contesta es anterior a esto, su foto no trae
  // el contenedor y aquí se rellena con lo de fábrica. Ver `mensajeDe`.
  const mensaje = mensajeDe(ajuste);
  /**
   * Si el motor que responde **conoce** este ajuste.
   *
   * Se mira el campo en crudo y no el resultado de `mensajeDe`: rellenar lo que falta es
   * necesario para poder pintar el panel, pero callarse que falta sería mentir. Un motor
   * anterior a esto guarda los ajustes **sin** el mensaje —deserializa la estructura, no
   * conoce el campo y lo descarta sin dar error—, así que el estilo que elijas volvería a
   * aparecer como «Default» en cuanto llegara la foto siguiente, y la previa saldría con el
   * bloque de siempre. Eso hay que decirlo, no disimularlo.
   */
  const soportado = Boolean(ajuste.mensaje);
  const [grupo, setGrupo] = useState<Grupo>("estilo");
  // Los mandos del contenedor que este estilo usa. Un estilo sin «resplandor» no lo
  // enseña: un mando que no hace nada es peor que un mando que no está.
  const campos = estiloMensaje(mensaje.estilo)?.campos ?? MANDOS_CONTENEDOR.map((m) => m.campo);

  return (
    <Card
      title={t.mensaje.title}
      nota={aviso}
      actions={
        <button type="button" className="ghost" onClick={onCerrar}>
          {t.mensaje.volver}
        </button>
      }
    >
      <div className="mensaje-panel">
        {/* Lo primero, si pasa: sin esto, elegir un estilo y verlo volver solo a «Default»
            parece un fallo del panel, y es el motor que no lo guarda. */}
        {soportado ? null : <p className="mensaje-aviso">{t.mensaje.sinMotor}</p>}
        <label className="mensaje-fila">
          <span className="animacion-etiqueta">{t.mensaje.estilo}</span>
          <select
            className="mensaje-estilo"
            value={mensaje.estilo}
            disabled={busy}
            aria-label={t.mensaje.estilo}
            title={t.mensaje.estiloHint}
            // El estilo **y sus valores**: elegir «Cristal» es empezar de cristal, no
            // heredar el fondo del que estuviera antes.
            onChange={(evento) => onCambiar(parcheDeEstilo(evento.target.value, mensaje))}
          >
            {ESTILOS.map((estilo) => (
              <option key={estilo.id} value={estilo.id}>
                {estilo.nombre}
              </option>
            ))}
          </select>
        </label>
        <p className="hint mensaje-pista">{estiloMensaje(mensaje.estilo)?.pista}</p>

        <div className="mensaje-grupos" role="tablist" aria-label={t.mensaje.title}>
          {GRUPOS.map((opcion) => (
            <button
              key={opcion.id}
              type="button"
              role="tab"
              aria-selected={grupo === opcion.id}
              className={grupo === opcion.id ? "mensaje-grupo activo" : "mensaje-grupo"}
              onClick={() => setGrupo(opcion.id)}
            >
              {opcion.rotulo}
            </button>
          ))}
        </div>

        <div className="mensaje-mandos">
          {grupo === "estilo" ? (
            <div className="mensaje-rejilla">
              {MANDOS_CONTENEDOR.filter((mando) => campos.includes(mando.campo)).map((mando) => (
                <Mando
                  key={mando.campo}
                  mando={mando}
                  mensaje={mensaje}
                  busy={busy}
                  onCambiar={onCambiar}
                />
              ))}
            </div>
          ) : null}

          {grupo === "texto" ? (
            <div className="mensaje-rejilla">
              {MANDOS_TEXTO.map((mando) => (
                <Mando
                  key={mando.campo}
                  mando={mando}
                  mensaje={mensaje}
                  busy={busy}
                  onCambiar={onCambiar}
                />
              ))}
            </div>
          ) : null}

          {grupo === "animacion" ? (
            <div className="mensaje-animaciones">
              <label className="mensaje-mando">
                <span className="animacion-etiqueta">{t.mensaje.animacionMensaje}</span>
                <select
                  value={mensaje.animacion}
                  disabled={busy}
                  aria-label={t.mensaje.animacionMensaje}
                  title={t.mensaje.animacionMensajeHint}
                  onChange={(evento) => onCambiar({ animacion: evento.target.value })}
                >
                  {ANIMACIONES_MENSAJE.map((animacion) => (
                    <option key={animacion.id} value={animacion.id}>
                      {animacion.nombre}
                    </option>
                  ))}
                </select>
              </label>

              <label className="mensaje-mando">
                <span className="animacion-etiqueta">{t.mensaje.animacionTexto}</span>
                <select
                  value={mensaje.animacion_texto}
                  disabled={busy}
                  aria-label={t.mensaje.animacionTexto}
                  title={t.mensaje.animacionTextoHint}
                  onChange={(evento) => onCambiar({ animacion_texto: evento.target.value })}
                >
                  {ANIMACIONES_TEXTO.map((animacion) => (
                    <option key={animacion.id} value={animacion.id}>
                      {animacion.nombre}
                    </option>
                  ))}
                </select>
              </label>

              <label className="mensaje-mando">
                <span className="animacion-etiqueta">{t.mensaje.permanencia}</span>
                <select
                  value={mensaje.animacion_idle}
                  disabled={busy}
                  aria-label={t.mensaje.permanencia}
                  title={t.mensaje.permanenciaHint}
                  onChange={(evento) => onCambiar({ animacion_idle: evento.target.value })}
                >
                  {PERMANENCIAS_MENSAJE.map((efecto) => (
                    <option key={efecto.id} value={efecto.id}>
                      {efecto.nombre}
                    </option>
                  ))}
                </select>
              </label>

              <Mando
                mando={MANDO_RETARDO}
                mensaje={mensaje}
                busy={busy}
                onCambiar={onCambiar}
              />
              <Mando
                mando={MANDO_DURACION}
                mensaje={mensaje}
                busy={busy}
                onCambiar={onCambiar}
              />
              {/* La velocidad del bucle solo se toca si hay bucle, y la intensidad solo
                  si la animación elegida se mueve: un mando que no hace nada con lo que
                  hay puesto es una promesa incumplida. */}
              {mensaje.animacion_idle !== "ninguna" ? (
                <Mando mando={MANDO_CICLO} mensaje={mensaje} busy={busy} onCambiar={onCambiar} />
              ) : null}
              {usaIntensidad(mensaje) ? (
                <Mando
                  mando={MANDO_INTENSIDAD}
                  mensaje={mensaje}
                  busy={busy}
                  onCambiar={onCambiar}
                />
              ) : null}
              <label className="mensaje-mando">
                <span className="animacion-etiqueta">{t.mensaje.ritmo}</span>
                <select
                  value={mensaje.ritmo}
                  disabled={busy}
                  aria-label={t.mensaje.ritmo}
                  title={t.mensaje.ritmoHint}
                  onChange={(evento) => onCambiar({ ritmo: evento.target.value })}
                >
                  {RITMOS.map((ritmo) => (
                    <option key={ritmo.id} value={ritmo.id}>
                      {ritmo.nombre}
                    </option>
                  ))}
                </select>
              </label>

              <p className="hint mensaje-ayuda">{t.mensaje.secuencia}</p>
            </div>
          ) : null}
        </div>
      </div>
    </Card>
  );
}

/**
 * Un mando del panel, pintado desde su descriptor.
 *
 * Los tres tiempos van en **segundos** y con decimales: el motor los guarda en
 * milisegundos, pero «0,25 s» es como se piensa un tiempo que se ve. La conversión vive
 * en las constantes de abajo, en un sitio, y no repartida por el panel.
 */
function Mando({
  mando,
  mensaje,
  busy,
  onCambiar,
}: {
  mando: MandoMensaje;
  mensaje: MensajeAviso;
  busy: boolean;
  onCambiar: (parche: Partial<MensajeAviso>) => void;
}) {
  const bruto = mensaje[mando.campo];
  const opciones =
    mando.campo === "fuente"
      ? FUENTES
      : mando.campo === "peso"
        ? PESOS
        : mando.campo === "alineacion"
          ? ALINEACIONES
          : [];

  /**
   * Lo que se enseña, en las unidades de la interfaz.
   *
   * Los tiempos van en segundos —«0,25 s» es como se piensa un tiempo que se ve— y el
   * motor los guarda en milisegundos; el espaciado y el contorno van en décimas de píxel,
   * que es lo que deja apretar una letra medio píxel. La conversión vive aquí, en un
   * sitio, y no repartida por cada mando.
   */
  const visible = mando.decimas
    ? Number(bruto) / 10
    : mando.enSegundos
      ? Number(bruto) / 1000
      : Number(bruto);

  /** Un cambio, en las unidades **del motor**. */
  const escribir = (valor: number) => {
    const guardado = mando.decimas
      ? Math.round(valor * 10)
      : mando.enSegundos
        ? Math.round(valor * 1000)
        : Math.round(valor);
    const parche: Record<string, string | number> = { [mando.campo]: guardado };
    onCambiar(parche as Partial<MensajeAviso>);
  };

  /** Un cambio que no es un número: un color o una opción de una lista. */
  const escribirTexto = (valor: string) => {
    const parche: Record<string, string | number> = {
      [mando.campo]: mando.campo === "peso" ? Number(valor) : valor,
    };
    onCambiar(parche as Partial<MensajeAviso>);
  };

  return (
    <label className="mensaje-mando">
      <span className="animacion-etiqueta">
        {/* La unidad va en el rótulo y no detrás del campo, como en la permanencia: pegada
            al número parece parte de él. */}
        {mando.etiqueta}
        {mando.unidad ? ` ${mando.unidad}` : ""}
      </span>
      {mando.tipo === "color" ? (
        <input
          type="color"
          className="mensaje-color"
          value={String(bruto)}
          disabled={busy}
          aria-label={mando.etiqueta}
          onChange={(evento) => escribirTexto(evento.target.value)}
        />
      ) : mando.tipo === "lista" ? (
        <select
          value={String(bruto)}
          disabled={busy}
          aria-label={mando.etiqueta}
          onChange={(evento) => escribirTexto(evento.target.value)}
        >
          {opciones.map((opcion) => (
            <option key={opcion.valor} value={opcion.valor}>
              {opcion.nombre}
            </option>
          ))}
        </select>
      ) : (
        <input
          type="number"
          className="mensaje-numero"
          min={mando.min}
          max={mando.max}
          step={mando.decimas ? 0.1 : mando.paso}
          value={visible}
          disabled={busy}
          aria-label={mando.etiqueta}
          onChange={(evento) => {
            const valor = Number(evento.target.value);
            if (!Number.isFinite(valor)) return;
            escribir(valor);
          }}
        />
      )}
    </label>
  );
}

// ---------------------------------------------------------------------------
// Los tres tiempos y la intensidad, en las unidades de la interfaz
// ---------------------------------------------------------------------------

/** Aparece a los… segundos de que entre la alerta. */
const MANDO_RETARDO: MandoMensaje = {
  campo: "retardo_ms",
  etiqueta: "Aparece a los",
  tipo: "numero",
  unidad: "s",
  min: 0,
  max: 10,
  paso: 0.05,
  enSegundos: true,
};

const MANDO_DURACION: MandoMensaje = {
  campo: "duracion_ms",
  etiqueta: "Duración",
  tipo: "numero",
  unidad: "s",
  min: 0.1,
  max: 5,
  paso: 0.05,
  enSegundos: true,
};

const MANDO_CICLO: MandoMensaje = {
  campo: "ciclo_ms",
  etiqueta: "Velocidad",
  tipo: "numero",
  unidad: "s",
  min: 0.4,
  max: 20,
  paso: 0.1,
  enSegundos: true,
};

const MANDO_INTENSIDAD: MandoMensaje = {
  campo: "intensidad",
  etiqueta: "Intensidad",
  tipo: "numero",
  unidad: "%",
  min: 0,
  max: 200,
  paso: 5,
};

/** El nombre del estilo, para el botón que abre este panel. */
export function rotuloMensaje(estilo: string): string {
  return t.mensaje.boton(nombreEstilo(estilo));
}
