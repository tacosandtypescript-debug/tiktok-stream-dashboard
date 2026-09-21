//! La biblioteca de voces: las dos pestañas, la rejilla y las acciones.
//!
//! Es la tarjeta grande de «Voces y claves» y sustituye a las cuatro cajas que
//! había antes. Lo que sabe hacer:
//!
//!   * **Mis voces**: las guardadas —de Fish y de la voz de siempre—, con su
//!     estrella, su idioma y sus acciones.
//!   * **Explorar Fish Audio**: el catálogo, con buscador, filtros y paginación.
//!   * **+ Agregar voz**: pegar un identificador, comprobarlo y guardarlo.
//!
//! Lo que **no** sabe: qué es Fish Audio por dentro (eso es del motor), cómo se
//! reproduce una muestra (eso es del reproductor global) y qué significa «usar una
//! voz» (eso es del lector, que lo pasa hecho desde la página). Cada cosa en su
//! sitio es lo que permite que esto no sea un componente de dos mil líneas.
//!
//! El reproductor envuelve al **cuerpo** y no a la tarjeta entera a propósito: la
//! barra de lo que está sonando tiene que quedar dentro del marco, pegada abajo,
//! para que se vea aunque la lista esté desplazada.

import { useCallback, useEffect, useMemo, useState } from "react";

import type { TtsStatus, TtsVozFish, TtsVozGuardada } from "../api";
import { Card } from "../components";
import { t } from "../i18n/es";
import { DetallesVoz } from "./DetallesVoz";
import { ImportarVoz } from "./ImportarVoz";
import { MenuVoz, type AccionMenu } from "./MenuVoz";
import { RejillaVoces } from "./RejillaVoces";
import { ReproductorMuestras, useReproductor } from "./ReproductorMuestras";
import { TarjetaVoz, motorDeVoz } from "./TarjetaVoz";
import { useCatalogo } from "./useCatalogo";
import {
  claveDeVoz,
  detalleDeGuardada,
  estaGuardada,
  filtrarVoces,
  idiomaLegible,
  idiomasDisponibles,
  imagenDeGuardada,
  imagenDeVoz,
  nombreDeVoz,
  ordenarVoces,
  primeraMuestra,
  urlPrueba,
} from "./tipos";
import { vocesApi } from "./vocesApi";

type Vista = "mis" | "explorar";

interface Props {
  /** La dirección del servidor de overlays, que ya trae el token. */
  urlOverlay?: string;
  /** Las voces guardadas, tal como las manda el motor. */
  guardadas: TtsVozGuardada[];
  /** El motor puesto ahora mismo (`fish` o `edge`). */
  proveedor: string;
  /** La voz de Fish que está en uso, para destacarla. */
  referenciaEnUso: string;
  /** Las voces de la voz de siempre que están en uso, por idioma. */
  edgeEnUso: { es: string; en: string };
  /** Si hay alguna clave guardada: sin ella no se puede explorar. */
  hayClaves: boolean;
  /** El estado nuevo después de cada cambio, para que la página lo reparta. */
  onStatus: (status: TtsStatus) => void;
  /** Pone una voz en uso. La lógica vive en la página, que es quien manda ajustes. */
  onUsar: (voz: TtsVozGuardada) => void;
  /** Lleva a la tarjeta de claves. */
  onIrAClaves: () => void;
}

export function BibliotecaVoces(props: Props) {
  return (
    <Card title={t.voces.biblioteca}>
      <ReproductorMuestras>
        <CuerpoBiblioteca {...props} />
      </ReproductorMuestras>
    </Card>
  );
}

function CuerpoBiblioteca({
  urlOverlay,
  guardadas,
  proveedor,
  referenciaEnUso,
  edgeEnUso,
  hayClaves,
  onStatus,
  onUsar,
  onIrAClaves,
}: Props) {
  const reproductor = useReproductor();
  const [vista, setVista] = useState<Vista>("mis");
  const [buscador, setBuscador] = useState("");
  const [idioma, setIdioma] = useState("");
  const [soloFavoritas, setSoloFavoritas] = useState(false);
  const [propios, setPropios] = useState(false);
  const [agregando, setAgregando] = useState(false);
  const [detalle, setDetalle] = useState<
    | { tipo: "guardada"; voz: TtsVozGuardada; nombre: string }
    | { tipo: "catalogo"; voz: TtsVozFish }
    | null
  >(null);
  const [ocupada, setOcupada] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  /** La voz del catálogo recién pedida, cuando el detalle es de una guardada. */
  const [fresca, setFresca] = useState<TtsVozFish | null>(null);
  /** La voz cuya muestra se está resolviendo antes de sonar. */
  const [preparando, setPreparando] = useState<string | null>(null);

  const catalogo = useCatalogo({ buscar: buscador, idioma, propios }, vista === "explorar");

  /** Las guardadas que pasan el buscador y los filtros, ya ordenadas. */
  const misVoces = useMemo(() => {
    const texto = buscador.trim().toLowerCase();
    const filtradas = filtrarVoces(guardadas, { idioma, soloFavoritas }).filter((voz) => {
      if (!texto) return true;
      return (
        nombreDeVoz(voz).toLowerCase().includes(texto) ||
        voz.referencia.toLowerCase().includes(texto) ||
        voz.autor.toLowerCase().includes(texto)
      );
    });
    return ordenarVoces(filtradas);
  }, [buscador, guardadas, idioma, soloFavoritas]);

  /**
   * Los idiomas que existen **de verdad** en lo que se está mirando.
   *
   * En «Mis voces» salen de las voces guardadas y en «Explorar» de lo que ha
   * devuelto el catálogo: ofrecer un idioma que no tiene ninguna voz sería ofrecer
   * una búsqueda que no devuelve nada.
   */
  const idiomas =
    vista === "mis"
      ? idiomasDisponibles(guardadas)
      : [
          ...new Set(
            catalogo.items.flatMap((voz) =>
              voz.idiomas.map((codigo) => codigo.split(/[-_]/)[0].toLowerCase()),
            ),
          ),
        ]
          .filter(Boolean)
          .sort((a, b) => idiomaLegible(a).localeCompare(idiomaLegible(b), "es"));

  const aplicar = useCallback(
    (status: TtsStatus) => {
      setAviso(null);
      onStatus(status);
    },
    [onStatus],
  );

  const conError = useCallback((causa: unknown) => setAviso(String(causa)), []);

  /**
   * Las muestras de Fish vienen **firmadas y con una hora de validez**.
   *
   * Por eso la que se guardó ayer ya no suena: antes de reproducir se le pide al
   * catálogo la buena —leer no gasta saldo— y si no se puede se intenta la que hay
   * guardada, que al menos vale si la voz se guardó hace un rato. Sin esto, el ▶ de
   * una voz guardada fallaría siempre a partir de la hora.
   */
  const escucharVoz = useCallback(
    (clave: string, titulo: string, respaldo: string, referencia: string) => {
      if (!reproductor) return;
      setPreparando(clave);
      // La dirección viaja como **promesa** al coordinador: mientras se pide, el
      // turno ya es de esta voz, así que una muestra que llegue tarde no arranca por
      // encima de la que se pidió después. Resolverlo aquí con un `then` era la
      // carrera: dos clics seguidos y la primera en contestar era la que sonaba.
      const muestra = vocesApi
        .obtener(referencia)
        .then((voz) => primeraMuestra(voz)?.audio || respaldo)
        // Sin catálogo se intenta la que hay guardada, que al menos vale si la voz
        // se guardó hace poco.
        .catch(() => respaldo);
      reproductor.alternar({ clave, titulo, url: muestra });
      void muestra.finally(() =>
        // Solo se quita el aviso si sigue siendo **esta** la que se está pidiendo.
        setPreparando((actual) => (actual === clave ? null : actual)),
      );
    },
    [reproductor],
  );

  /**
   * Al abrir el detalle de una voz **guardada** se refrescan sus datos.
   *
   * No es un capricho: la descripción, las etiquetas y sobre todo las muestras
   * cambian en el catálogo, y las direcciones de audio caducan. Es una lectura, no
   * gasta saldo, y si falla se enseña lo que había guardado en vez de un hueco.
   */
  useEffect(() => {
    setFresca(null);
    if (detalle?.tipo !== "guardada" || detalle.voz.proveedor !== "fish-audio") return;
    const referencia = detalle.voz.referencia;
    let vivo = true;
    void vocesApi
      .obtener(referencia)
      .then((voz) => {
        if (vivo) setFresca(voz);
      })
      .catch(() => undefined);
    return () => {
      vivo = false;
    };
  }, [detalle]);

  const guardar = useCallback(
    (id: string, nombre?: string) => {
      setOcupada(id);
      return vocesApi
        .guardar(id, nombre)
        .then(aplicar)
        .catch((causa: unknown) => {
          conError(causa);
          throw causa;
        })
        .finally(() => setOcupada(null));
    },
    [aplicar, conError],
  );

  const accionGuardada = useCallback(
    (referencia: string, operacion: () => Promise<TtsStatus>) => {
      setOcupada(referencia);
      operacion()
        .then(aplicar)
        .catch(conError)
        .finally(() => setOcupada(null));
    },
    [aplicar, conError],
  );

  /** El menú ⋯ de una voz guardada. */
  const menuDe = (voz: TtsVozGuardada): AccionMenu[] => [
    {
      etiqueta: voz.favorito ? t.voces.quitarFavorito : t.voces.ponerFavorito,
      onClick: () =>
        accionGuardada(voz.referencia, () => vocesApi.favorita(voz.referencia, !voz.favorito)),
    },
    {
      etiqueta: t.voces.editarNombre,
      onClick: () => {
        const propuesto = window.prompt(t.voces.nombreOpcional, voz.nombre);
        if (propuesto === null) return;
        accionGuardada(voz.referencia, () => vocesApi.renombrar(voz.referencia, propuesto));
      },
    },
    {
      etiqueta: t.voces.copiarId,
      pista: voz.referencia,
      onClick: () => void navigator.clipboard?.writeText(voz.referencia),
    },
    ...(voz.proveedor === "fish-audio"
      ? [
          {
            etiqueta:
              ocupada === voz.referencia ? t.voces.actualizando : t.voces.actualizarDesde,
            deshabilitado: ocupada === voz.referencia,
            onClick: () =>
              accionGuardada(voz.referencia, () => vocesApi.actualizar(voz.referencia)),
          },
        ]
      : []),
    {
      etiqueta: t.voces.verDetalles,
      onClick: () => setDetalle({ tipo: "guardada", voz, nombre: nombreDeVoz(voz) }),
    },
    {
      etiqueta: t.voces.eliminar,
      peligrosa: true,
      confirmar: t.voces.eliminarAviso,
      onClick: () => accionGuardada(voz.referencia, () => vocesApi.quitar(voz.referencia)),
    },
  ];

  const estaEnUso = (voz: TtsVozGuardada) =>
    voz.proveedor === "fish-audio"
      ? proveedor === "fish" && voz.referencia === referenciaEnUso
      : proveedor === "edge" &&
        voz.referencia === (voz.idioma === "en" ? edgeEnUso.en : edgeEnUso.es);

  return (
    <div className="voz-biblioteca">
      <div className="voz-biblioteca-cabeza">
        <div className="vista-switch" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={vista === "mis"}
            className={vista === "mis" ? "active" : "ghost"}
            onClick={() => setVista("mis")}
          >
            {t.voces.misVoces}
            {guardadas.length > 0 ? (
              <span className="switch-diseno">{guardadas.length}</span>
            ) : null}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={vista === "explorar"}
            className={vista === "explorar" ? "active" : "ghost"}
            onClick={() => setVista("explorar")}
          >
            {t.voces.explorar}
          </button>
        </div>
        <button
          type="button"
          className="ghost"
          aria-expanded={agregando}
          onClick={() => setAgregando((abierto) => !abierto)}
        >
          {t.voces.agregar}
        </button>
      </div>

      {agregando ? (
        <ImportarVoz onGuardar={guardar} onCerrar={() => setAgregando(false)} />
      ) : null}

      <div className="voz-filtros">
        <input
          type="search"
          className="voz-buscador"
          value={buscador}
          placeholder={t.voces.buscar}
          aria-label={t.voces.buscar}
          onChange={(evento) => setBuscador(evento.target.value)}
        />
        <div className="voz-filtros-botones">
          <button
            type="button"
            className={soloFavoritas ? "" : "ghost"}
            aria-pressed={soloFavoritas}
            title={t.voces.filtroFavoritas}
            onClick={() => setSoloFavoritas((puesto) => !puesto)}
          >
            ★
          </button>
          {idiomas.length > 0 ? (
            <select
              value={idioma}
              aria-label={t.voces.filtroIdioma}
              onChange={(evento) => setIdioma(evento.target.value)}
            >
              <option value="">{t.voces.filtroIdioma}</option>
              {idiomas.map((codigo) => (
                <option key={codigo} value={codigo}>
                  {idiomaLegible(codigo)}
                </option>
              ))}
            </select>
          ) : null}
          {vista === "explorar" ? (
            <label className="switch" title={t.voces.soloMisModelosHint}>
              <input
                type="checkbox"
                checked={propios}
                onChange={(evento) => setPropios(evento.target.checked)}
              />
              <span>{t.voces.soloMisModelos}</span>
            </label>
          ) : null}
          {vista === "explorar" && catalogo.items.length > 0 ? (
            <span className="hint">
              {t.voces.cuantas(catalogo.items.length, catalogo.total)}
            </span>
          ) : null}
        </div>
      </div>

      {aviso ? <p className="voz-aviso">{aviso}</p> : null}

      <div className="voz-cuerpo">
        <div className="voz-lista">
          {vista === "mis" ? (
        <RejillaVoces
          estado={misVoces.length > 0 ? "listo" : "vacio"}
          mensaje={
            guardadas.length === 0
              ? `${t.voces.sinGuardadas} ${t.voces.sinGuardadasHint}`
              : soloFavoritas
                ? t.voces.sinFavoritas
                : t.voces.sinResultados
          }
        >
          {misVoces.map((voz) => {
            const muestra = primeraMuestra(voz);
            return (
              <TarjetaVoz
                key={claveDeVoz(voz)}
                nombre={nombreDeVoz(voz)}
                idioma={idiomaLegible(voz.idioma)}
                motor={motorDeVoz(voz.proveedor)}
                imagen={imagenDeGuardada(voz, urlOverlay)}
                pista={voz.descripcion || voz.referencia}
                enUso={estaEnUso(voz)}
                sonando={reproductor?.sonando?.clave === claveDeVoz(voz)}
                progreso={reproductor?.sonando?.progreso}
                ocupada={ocupada === voz.referencia || preparando === claveDeVoz(voz)}
                acciones={{
                  onEscuchar: muestra
                    ? () =>
                        escucharVoz(
                          claveDeVoz(voz),
                          `${nombreDeVoz(voz)} · ${muestra.titulo || t.voces.muestraOficial}`,
                          muestra.audio,
                          voz.referencia,
                        )
                    : undefined,
                  onUsar: () => onUsar(voz),
                  onDetalles: () => setDetalle({ tipo: "guardada", voz, nombre: nombreDeVoz(voz) }),
                  menu: <MenuVoz acciones={menuDe(voz)} />,
                }}
              />
            );
          })}
        </RejillaVoces>
      ) : !hayClaves ? (
        <div className="voces-vacio">
          <p className="hint">{t.voces.sinClave}</p>
          <button type="button" className="ghost" onClick={onIrAClaves}>
            {t.voces.sinClaveIr}
          </button>
        </div>
      ) : (
        <>
          <RejillaVoces
            estado={
              catalogo.error
                ? "error"
                : catalogo.cargando && catalogo.items.length === 0
                  ? "cargando"
                  : catalogo.items.length === 0
                    ? "vacio"
                    : "listo"
            }
            mensaje={catalogo.error ?? t.voces.sinResultados}
            onReintentar={catalogo.error ? catalogo.recargar : undefined}
          >
            {catalogo.items.map((voz) => {
              const muestra = primeraMuestra(voz);
              const yaEsta = estaGuardada(guardadas, {
                proveedor: "fish-audio",
                referencia: voz.id,
              });
              const clave = `fish-audio:${voz.id}`;
              return (
                <TarjetaVoz
                  key={voz.id}
                  nombre={voz.titulo || voz.id}
                  idioma={voz.idiomas.map(idiomaLegible).join(" · ")}
                  motor={voz.autor.nombre || motorDeVoz("fish-audio")}
                  imagen={imagenDeVoz(voz) || undefined}
                  pista={voz.descripcion || voz.id}
                  atenuada={!voz.estado || voz.estado === "trained" ? false : true}
                  guardada={yaEsta}
                  sonando={reproductor?.sonando?.clave === clave}
                  progreso={reproductor?.sonando?.progreso}
                  ocupada={ocupada === voz.id}
                  acciones={{
                    onEscuchar: muestra
                      ? () =>
                          reproductor?.alternar({
                            clave,
                            titulo: `${voz.titulo || voz.id} · ${muestra.titulo || t.voces.muestraOficial}`,
                            url: muestra.audio,
                          })
                      : undefined,
                    onGuardar: yaEsta ? undefined : () => void guardar(voz.id),
                    onDetalles: () => setDetalle({ tipo: "catalogo", voz }),
                  }}
                />
              );
            })}
          </RejillaVoces>

          {catalogo.hayMas ? (
            <div className="voces-mas">
              <button
                type="button"
                className="ghost"
                disabled={catalogo.cargandoMas}
                onClick={catalogo.cargarMas}
              >
                {catalogo.cargandoMas ? t.voces.cargandoMas : t.voces.cargarMas}
              </button>
            </div>
          ) : null}
            </>
          )}
        </div>

        {detalle ? (
          <DetallesVoz
            // Los datos **frescos** del catálogo mandan cuando los hay: la
            // descripción y las muestras cambian, y las direcciones de audio
            // caducan. Lo guardado queda de respaldo para cuando no hay red.
            voz={
              detalle.tipo === "guardada"
                ? (fresca ?? detalleDeGuardada(detalle.voz))
                : detalle.voz
            }
            nombre={
              detalle.tipo === "guardada" ? detalle.nombre : detalle.voz.titulo || detalle.voz.id
            }
            proveedor={detalle.tipo === "guardada" ? detalle.voz.proveedor : "fish-audio"}
            guardada={detalle.tipo === "guardada"}
            onCerrar={() => setDetalle(null)}
            onGenerarPrueba={
              detalle.tipo === "guardada" && detalle.voz.proveedor === "fish-audio"
                ? async () => {
                    const archivo = await vocesApi.probar(detalle.voz.referencia);
                    return urlPrueba(urlOverlay, archivo) ?? archivo;
                  }
                : undefined
            }
          />
        ) : null}
      </div>
    </div>
  );
}
