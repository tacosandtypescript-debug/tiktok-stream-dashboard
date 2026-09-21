//! Panel del juego de trompos dentro de la aplicación.
//!
//! **No lleva rótulo ni acciones propias**: es lo que se despliega dentro de la
//! tarjeta de Juegos de Overlays al pulsar Beyblades. El nombre del juego y su mando
//! los pone la fila de esa tarjeta, igual que para Pelotas, Duelo y Esgrima; aquí
//! vive solo la configuración, con los mismos botones y tokens que el resto. El
//! envoltorio es una tarjeta sin cabecera, y la página le disuelve el marco porque ya
//! hay otro alrededor.
//!
//! Lo que hace el panel: activar el overlay, enseñar la vista previa (que es el
//! **mismo documento** que carga OBS), copiar su dirección, mandar los comandos de
//! ronda, y editar la configuración y la tabla de regalos.
//!
//! Los regalos llegan al motor por el bus de eventos que ya existía (el de las
//! Alertas): este panel sólo envía **eventos simulados** cuando se pulsan los
//! controles internos, y esos eventos entran por el mismo camino que los reales.

import { useCallback, useEffect, useMemo, useState } from "react";

import { Card, Copiar, VistaPrevia } from "../components";
import { t } from "../i18n/es";

import {
  ACUMULACIONES,
  CONFIG_POR_DEFECTO,
  CLAVE_ESTADO,
  OBJETIVOS,
  PODERES,
  RECOMPENSAS,
  enviarComando,
  guardarConfig,
  leerConfig,
  leerEstado,
  urlOverlay,
  type ConfigJuego,
  type EstadoJuego,
  type RegaloJuego,
} from "./config";
import "./juego.css";

/** Nombre legible de un poder (el motor publica el identificador). */
function nombrePoder(clave: string | null): string {
  if (!clave) return "—";
  const catalogo = (t as unknown as { juego?: { poderes?: Record<string, string> } }).juego?.poderes;
  return catalogo?.[clave] ?? clave;
}

function nombreRecompensa(clave: string): string {
  return RECOMPENSAS.find((r) => r.clave === clave)?.nombre ?? clave;
}

function nombreObjetivo(clave: string): string {
  return OBJETIVOS.find((o) => o.clave === clave)?.nombre ?? clave;
}

function nombreAcumulacion(clave: string): string {
  return ACUMULACIONES.find((a) => a.clave === clave)?.nombre ?? clave;
}

/** Fila vacía para el alta de un regalo. */
function regaloNuevo(): RegaloJuego {
  return {
    id: `regalo-${Date.now()}`,
    regalo: "Regalo nuevo",
    regaloId: "",
    cantidad: 1,
    recompensa: "vida",
    vida: 500,
    poder: null,
    objetivo: "propio",
    enfriamiento: 0,
    acumulacion: "inmediata",
    activo: true,
  };
}

interface Props {
  /**
   * Si el juego está encendido en el overlay.
   *
   * Lo gobierna la página y no este panel porque lo escriben **dos** sitios: la fila
   * de la tarjeta («Usar este») y el botón de aquí dentro. Con una copia en cada uno,
   * el que no escribe se queda viejo y la fila diría «En antena» mientras el panel
   * enseña «Activar».
   */
  activo: boolean;
  /** Enciende o apaga el juego. Escribe la página; aquí solo se pide. */
  onActivo: (activo: boolean) => void;
}

export function Juego({ activo, onActivo }: Props) {
  const [config, setConfig] = useState<ConfigJuego>(() => leerConfig());
  const [estado, setEstado] = useState<EstadoJuego | null>(() => leerEstado());
  const [previa, setPrevia] = useState(false);
  const [editando, setEditando] = useState<RegaloJuego | null>(null);
  const [borrando, setBorrando] = useState<string | null>(null);
  const [aviso, setAviso] = useState("");
  const direccion = useMemo(() => urlOverlay(), []);

  /** Cualquier cambio de configuración se guarda y el overlay se entera solo. */
  const aplicar = useCallback(
    (cambio: Partial<ConfigJuego>, nota?: string) => {
      setConfig((actual) => {
        // `activo` se escribe desde el padre, así que se sella con el valor suyo y no
        // con el de la copia local: si no, cambiar el volumen apagaría el juego sin
        // que nadie lo hubiera pedido.
        const siguiente = { ...actual, ...cambio, activo };
        guardarConfig(siguiente);
        return siguiente;
      });
      if (nota) setAviso(nota);
    },
    [activo],
  );

  /** La tabla de regalos se edita en bloque. */
  const aplicarRegalos = useCallback(
    (regalos: RegaloJuego[], nota?: string) => {
      setConfig((actual) => {
        const siguiente = { ...actual, regalos };
        guardarConfig(siguiente);
        return siguiente;
      });
      if (nota) setAviso(nota);
    },
    [],
  );

  // El overlay publica su estado en el almacén del navegador; aquí se escucha.
  useEffect(() => {
    const alCambiar = (evento: StorageEvent) => {
      if (evento.key === CLAVE_ESTADO) setEstado(leerEstado());
    };
    window.addEventListener("storage", alCambiar);
    const reloj = window.setInterval(() => setEstado(leerEstado()), 1000);
    return () => {
      window.removeEventListener("storage", alCambiar);
      window.clearInterval(reloj);
    };
  }, []);

  const conectado = estado?.conexion === "conectado";

  return (
    /* Sin título ni acciones: el rótulo y el mando de la fila los pone la tarjeta de
       Juegos, y aquí solo vive lo que se despliega. El marco lo disuelve la página
       (`.juego-desplegado .card`), que es quien sabe que esto va dentro de otra. */
    <Card>
      <div className="juego">
        <p className="hint">
          Overlay de batalla de trompos: los regalos que ya recibe la aplicación mueven a los
          participantes. Se pega en OBS como fuente de navegador, con el mismo documento que la
          vista previa.
        </p>

        <div className="juego-estado" data-estado={estado?.conexion ?? "desconectado"}>
          <span className="luz" />
          <b>{(estado?.conexion ?? "desconectado").toUpperCase()}</b>
          <span className="detalle">
            {activo
              ? `${estado?.fase ?? "—"} · ${estado?.vivos ?? 0}/${estado?.participantes ?? 0} en pie · ronda ${estado?.ronda ?? 1}`
              : "Desactivado"}
            {estado?.ultimo ? ` · último: ${estado.ultimo}` : ""}
          </span>
        </div>

        <div className="acciones">
          <button
            type="button"
            className={activo ? "ghost" : ""}
            onClick={() => {
              onActivo(!activo);
              setAviso(!activo ? "Juego activado en el overlay" : "Juego desactivado");
            }}
          >
            {activo ? "Desactivar" : "Activar"}
          </button>
          <button type="button" className="ghost" aria-expanded={previa} onClick={() => setPrevia((v) => !v)}>
            {previa ? "Ocultar vista previa" : "Vista previa"}
          </button>
          <Copiar texto={direccion} />
          <button type="button" onClick={() => enviarComando("iniciar")}>
            Iniciar ronda
          </button>
          <button type="button" className="ghost" onClick={() => enviarComando("pausar")}>
            Pausar
          </button>
          <button type="button" className="ghost" onClick={() => enviarComando("reanudar")}>
            Reanudar
          </button>
          <button type="button" className="ghost" onClick={() => enviarComando("reiniciar")}>
            Reiniciar
          </button>
          <button type="button" className="ghost" onClick={() => enviarComando("limpiar")}>
            Limpiar partida
          </button>
        </div>
        <p className="nota-estado">{aviso || `Dirección para OBS: ${direccion}`}</p>

        <div className="cuentas">
          <div>
            <span>Regalos</span>
            <b>{estado?.procesados ?? 0}</b>
          </div>
          <div>
            <span>Duplicados</span>
            <b>{estado?.duplicados ?? 0}</b>
          </div>
          <div>
            <span>Sin configurar</span>
            <b>{estado?.desconocidos ?? 0}</b>
          </div>
          <div>
            <span>En espera</span>
            <b>{estado?.enEspera ?? 0}</b>
          </div>
          <div>
            <span>Ganador</span>
            <b>{estado?.ganador ?? "—"}</b>
          </div>
        </div>

        <div className="rejilla-mando">
          <label className="campo">
            <span>Participantes</span>
            <select
              value={config.maxParticipantes}
              onChange={(e) => {
                const n = Number(e.target.value);
                aplicar({ maxParticipantes: n }, `Arena para ${n} participantes`);
                enviarComando("participantes", { participantes: n });
              }}
            >
              {[10, 20, 30, 40].map((n) => (
                <option key={n} value={n}>
                  {n} participantes
                </option>
              ))}
            </select>
          </label>

          <label className="campo">
            <span>Vida inicial</span>
            <input
              type="number"
              min={200}
              max={9999}
              step={100}
              value={config.vidaInicial}
              onChange={(e) => aplicar({ vidaInicial: Number(e.target.value) || CONFIG_POR_DEFECTO.vidaInicial })}
            />
          </label>

          <label className="campo">
            <span>Velocidad</span>
            <select value={config.velocidad} onChange={(e) => aplicar({ velocidad: Number(e.target.value) })}>
              <option value={0.85}>Pausada (×0,85)</option>
              <option value={1}>Normal</option>
              <option value={1.15}>Rápida (×1,15)</option>
              <option value={1.3}>Muy rápida (×1,3)</option>
            </select>
          </label>

          <label className="campo">
            <span>Duración máxima</span>
            <input
              type="number"
              min={20}
              max={900}
              step={10}
              value={config.duracionMaxima}
              onChange={(e) => aplicar({ duracionMaxima: Number(e.target.value) || CONFIG_POR_DEFECTO.duracionMaxima })}
            />
          </label>

          <label className="campo">
            <span>Volumen</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={config.volumen}
              onChange={(e) => aplicar({ volumen: Number(e.target.value) })}
            />
          </label>

          <label className="campo">
            <span>Modo</span>
            <select value={config.modo} onChange={(e) => aplicar({ modo: e.target.value as "simulado" | "real" })}>
              <option value="simulado">Simulado (sin conexión)</option>
              <option value="real">Real (regalos de TikTok)</option>
            </select>
          </label>
        </div>

        <div className="interruptores">
          <label>
            <input type="checkbox" checked={config.sonido} onChange={(e) => aplicar({ sonido: e.target.checked })} />
            Sonido
          </label>
          <label>
            <input type="checkbox" checked={config.relleno} onChange={(e) => aplicar({ relleno: e.target.checked })} />
            Participantes de relleno
          </label>
          <label>
            <input
              type="checkbox"
              checked={config.rondaAutomatica}
              onChange={(e) => aplicar({ rondaAutomatica: e.target.checked })}
            />
            Iniciar ronda sola
          </label>
          <label>
            <input
              type="checkbox"
              checked={config.mostrarNombres}
              onChange={(e) => aplicar({ mostrarNombres: e.target.checked })}
            />
            Nombres
          </label>
          <label>
            <input
              type="checkbox"
              checked={config.mostrarFotos}
              onChange={(e) => aplicar({ mostrarFotos: e.target.checked })}
            />
            Fotos
          </label>
          <label>
            <input
              type="checkbox"
              checked={config.mostrarTabla}
              onChange={(e) => aplicar({ mostrarTabla: e.target.checked })}
            />
            Tabla
          </label>
          <label>
            <input
              type="checkbox"
              checked={config.mostrarDanio}
              onChange={(e) => aplicar({ mostrarDanio: e.target.checked })}
            />
            Daño
          </label>
          <label>
            <input
              type="checkbox"
              checked={config.mostrarParticulas}
              onChange={(e) => aplicar({ mostrarParticulas: e.target.checked })}
            />
            Partículas
          </label>
          <label>
            <input
              type="checkbox"
              checked={config.mostrarPoderes}
              onChange={(e) => aplicar({ mostrarPoderes: e.target.checked })}
            />
            Poderes
          </label>
        </div>

        {!conectado ? (
          <p className="nota-estado">
            {activo
              ? "El overlay no está abierto: los contadores aparecerán en cuanto se abra la vista previa o la fuente de OBS."
              : "Juego desactivado: el overlay queda en negro (transparente) hasta que se active."}
          </p>
        ) : null}

        {previa ? (
          <VistaPrevia
            url={`${direccion}?taller=1`}
            ancho={1080}
            alto={1920}
            etiqueta="Vista previa del juego"
            nota="mismo documento que OBS · 1080 × 1920"
          />
        ) : null}

        {/* --- configuración de regalos */}
        <div className="acciones" style={{ marginTop: 12 }}>
          <strong style={{ alignSelf: "center" }}>Configuración de regalos</strong>
          <button
            type="button"
            className="ghost"
            onClick={() => setEditando(regaloNuevo())}
            aria-expanded={Boolean(editando)}
          >
            Añadir regalo
          </button>
        </div>

        <div className="tabla-regalos-juego">
          {config.regalos.map((regalo) => (
            <div className="fila-regalo" key={regalo.id} data-activo={regalo.activo ? 1 : 0}>
              <input
                type="checkbox"
                checked={regalo.activo}
                aria-label={`Activar ${regalo.regalo}`}
                onChange={(e) =>
                  aplicarRegalos(
                    config.regalos.map((r) => (r.id === regalo.id ? { ...r, activo: e.target.checked } : r)),
                  )
                }
              />
              <span className="nombre">
                <strong>{regalo.regalo}</strong>
                <span className="pastilla">×{regalo.cantidad}</span>
                <span className={`pastilla ${regalo.recompensa}`}>{nombreRecompensa(regalo.recompensa)}</span>
                {regalo.vida > 0 ? <span className="pastilla">+{regalo.vida} vida</span> : null}
              </span>
              <button type="button" className="ghost" onClick={() => setEditando({ ...regalo })}>
                Editar
              </button>
              {borrando === regalo.id ? (
                <span className="confirmar">
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => {
                      aplicarRegalos(
                        config.regalos.filter((r) => r.id !== regalo.id),
                        `Regalo «${regalo.regalo}» eliminado`,
                      );
                      setBorrando(null);
                    }}
                  >
                    Sí
                  </button>
                  <button type="button" className="ghost" onClick={() => setBorrando(null)}>
                    No
                  </button>
                </span>
              ) : (
                <button type="button" className="ghost" onClick={() => setBorrando(regalo.id)}>
                  Eliminar
                </button>
              )}
              <span className="detalle">
                Poder: {nombrePoder(regalo.poder)} · {nombreObjetivo(regalo.objetivo)} ·{" "}
                {regalo.enfriamiento ? `enfría ${regalo.enfriamiento} s` : "sin enfriamiento"} ·{" "}
                {nombreAcumulacion(regalo.acumulacion)}
                {regalo.regaloId ? ` · id ${regalo.regaloId}` : ""}
              </span>
            </div>
          ))}
        </div>

        <div className="rejilla-mando">
          <label className="campo">
            <span>Si el poder está enfriando</span>
            <select
              value={config.reglas.siEnfriando}
              onChange={(e) => aplicar({ reglas: { ...config.reglas, siEnfriando: e.target.value } })}
            >
              <option value="cola">Poner en cola</option>
              <option value="ignorar">Ignorar el evento</option>
              <option value="primer_disponible">Lanzar el primer poder libre</option>
            </select>
          </label>
          <label className="campo">
            <span>Excedente</span>
            <select
              value={config.reglas.excedente}
              onChange={(e) => aplicar({ reglas: { ...config.reglas, excedente: e.target.value } })}
            >
              <option value="conservar">Conservar</option>
              <option value="reiniciar">Reiniciar</option>
            </select>
          </label>
        </div>

        {editando ? (
          <div className="form-regalo">
            <div className="rejilla">
              <label className="campo">
                <span>Nombre</span>
                <input
                  type="text"
                  value={editando.regalo}
                  onChange={(e) => setEditando({ ...editando, regalo: e.target.value })}
                />
              </label>
              <label className="campo">
                <span>Identificador</span>
                <input
                  type="text"
                  value={editando.regaloId}
                  onChange={(e) => setEditando({ ...editando, regaloId: e.target.value })}
                />
              </label>
              <label className="campo">
                <span>Cantidad</span>
                <input
                  type="number"
                  min={1}
                  max={999}
                  value={editando.cantidad}
                  onChange={(e) => setEditando({ ...editando, cantidad: Number(e.target.value) || 1 })}
                />
              </label>
              <label className="campo">
                <span>Recompensa</span>
                <select
                  value={editando.recompensa}
                  onChange={(e) => setEditando({ ...editando, recompensa: e.target.value })}
                >
                  {RECOMPENSAS.map((r) => (
                    <option key={r.clave} value={r.clave}>
                      {r.nombre}
                    </option>
                  ))}
                </select>
              </label>
              <label className="campo">
                <span>Vida</span>
                <input
                  type="number"
                  min={0}
                  max={99999}
                  step={50}
                  value={editando.vida}
                  onChange={(e) => setEditando({ ...editando, vida: Number(e.target.value) || 0 })}
                />
              </label>
              <label className="campo">
                <span>Poder</span>
                <select
                  value={editando.poder ?? ""}
                  onChange={(e) => setEditando({ ...editando, poder: e.target.value || null })}
                >
                  <option value="">— sin poder —</option>
                  {PODERES.map((p) => (
                    <option key={p} value={p}>
                      {nombrePoder(p)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="campo">
                <span>Objetivo</span>
                <select
                  value={editando.objetivo}
                  onChange={(e) => setEditando({ ...editando, objetivo: e.target.value })}
                >
                  {OBJETIVOS.map((o) => (
                    <option key={o.clave} value={o.clave}>
                      {o.nombre}
                    </option>
                  ))}
                </select>
              </label>
              <label className="campo">
                <span>Enfriamiento (s)</span>
                <input
                  type="number"
                  min={0}
                  max={600}
                  step={0.5}
                  value={editando.enfriamiento}
                  onChange={(e) => setEditando({ ...editando, enfriamiento: Number(e.target.value) || 0 })}
                />
              </label>
              <label className="campo">
                <span>Acumulación</span>
                <select
                  value={editando.acumulacion}
                  onChange={(e) => setEditando({ ...editando, acumulacion: e.target.value })}
                >
                  {ACUMULACIONES.map((a) => (
                    <option key={a.clave} value={a.clave}>
                      {a.nombre}
                    </option>
                  ))}
                </select>
              </label>
              <label className="campo">
                <span>Activo</span>
                <input
                  type="checkbox"
                  checked={editando.activo}
                  onChange={(e) => setEditando({ ...editando, activo: e.target.checked })}
                />
              </label>
            </div>
            <div className="acciones">
              <button
                type="button"
                onClick={() => {
                  const existe = config.regalos.some((r) => r.id === editando.id);
                  const lista = existe
                    ? config.regalos.map((r) => (r.id === editando.id ? editando : r))
                    : [...config.regalos, editando];
                  aplicarRegalos(lista, `Regalo «${editando.regalo}» guardado`);
                  setEditando(null);
                }}
              >
                Guardar
              </button>
              <button type="button" className="ghost" onClick={() => setEditando(null)}>
                Cancelar
              </button>
            </div>
          </div>
        ) : null}

        {/* --- controles internos: eventos simulados por el mismo camino que los reales */}
        <div className="acciones" style={{ marginTop: 12 }}>
          <strong style={{ alignSelf: "center" }}>Eventos de prueba</strong>
          <button
            type="button"
            className="ghost"
            onClick={() => enviarComando("limpiar")}
          >
            Limpiar historial
          </button>
        </div>
        <p className="hint">
          Pasan por el mismo normalizador y la misma lógica que los regalos reales: no hay un camino
          de prueba aparte. Necesitan el overlay abierto (vista previa o fuente de OBS).
        </p>
        <div className="escenarios">
          {[
            ["usuario-nuevo", "Participante nuevo"],
            ["rosa", "Regalo de vida"],
            ["dona", "Regalo de poder"],
            ["acumulado", "Regalo acumulado"],
            ["desconocido", "Regalo desconocido"],
            ["duplicado", "Evento duplicado"],
            ["repetido", "Usuario repetido"],
            ["racha", "Racha parcial"],
            ["espera", "Usuario en espera"],
            ["eliminado", "Participante eliminado"],
            ["evento-especial", "Evento especial"],
          ].map(([clave, nombre]) => (
            <button
              key={clave}
              type="button"
              className="ghost"
              onClick={() => {
                enviarComando("escenario", { escenario: clave });
                setAviso(`Evento de prueba enviado: ${nombre}`);
              }}
            >
              {nombre}
            </button>
          ))}
          <button
            type="button"
            className="ghost"
            onClick={() => {
              for (let i = 0; i < 5; i += 1) enviarComando("escenario", { escenario: "rosa" });
              setAviso("Cinco regalos seguidos enviados");
            }}
          >
            Varios regalos seguidos
          </button>
          <button
            type="button"
            className="ghost"
            onClick={() => {
              enviarComando("reiniciar");
              setAviso("Reiniciado: se conserva la configuración y la tabla");
            }}
          >
            Reconexión / reinicio
          </button>
        </div>
      </div>
    </Card>
  );
}
