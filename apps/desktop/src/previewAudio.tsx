//! El único que reproduce audio de **previsualización**.
//!
//! Hay tres sitios que suenan al pulsar algo, y solo uno puede sonar a la vez:
//!
//!   * el botón «Oír» de la biblioteca de sonidos de Alertas y el de dentro del
//!     editor —los dos suenan en el **monitor de alertas** de Rust—;
//!   * el botón «Probar» de la previa de un aviso —también por el monitor—;
//!   * la muestra de una voz, que suena en el `<audio>` de aquí.
//!
//! Antes cada uno tiraba por su cuenta: se pulsaba «Oír» en un sonido, luego en
//! otro, y el primero seguía sonando por debajo; y lo mismo entre la biblioteca y
//! la previa del aviso. Con un solo `<audio>` por biblioteca se arreglaba dentro de
//! las voces, pero no **entre** las tres cosas, que es donde estaba el fallo.
//!
//! Aquí vive el coordinador: **toda** reproducción de prueba pasa por `sonar()`, y
//! antes de reproducir nada se corta lo anterior —lo de aquí y lo del motor, con
//! `parar_preview`—. Quien reproduce avisa cuando acaba, y quien no termina de
//! sonar porque otro le quitó el turno se entera por la **marca**: cada petición
//! lleva un número, y lo que llega tarde se descarta en vez de arrancar. Sin eso,
//! tres clics rápidos («Oír A → Probar alerta → Oír B») pueden acabar con A sonando
//! otra vez, porque su `play()` resolvió el último.
//!
//! El motor sigue siendo la fuente de verdad de lo que suena **por el monitor**: por
//! eso `actual` se limpia preguntándole a Rust si el preview del motor sigue
//! sonando, y no con un temporizador que adivine la duración del fichero.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

import { api, type OrigenPreview } from "./api";
import { t } from "./i18n/es";

/**
 * Cada cuánto se le pregunta al motor si sigue sonando lo que encoló.
 *
 * No hay evento que avise del final de un fichero: el motor lo sabe, pero no lo
 * publica. Se pregunta mientras suena algo —y solo mientras—, que es un rato de
 * segundos.
 */
const SONDEO_MS = 300;

/**
 * Margen para que el motor recoja la orden antes de dar por hecho que no suena.
 *
 * La orden va por IPC y el turno lo apunta el motor al atenderla: la primera
 * pregunta puede llegar antes que el propio `play`, y sin este margen el preview
 * se daría por terminado antes de empezar.
 */
const GRACIA_MS = 1500;

/** En qué está el preview. Es el mismo vocabulario que el de la biblioteca de voces. */
export type EstadoPreview = "parado" | "cargando" | "sonando" | "pausado" | "error";

/** Lo que está sonando de prueba, si hay algo. */
export interface PreviewActivo {
  origen: OrigenPreview;
  id: string;
  /** Lo que se enseña: el nombre del sonido, el aviso o la voz. */
  titulo: string;
}

/**
 * Lo que se le pide al coordinador.
 *
 * Con `url` suena aquí; sin ella lo reproduce el motor, y entonces hace falta
 * `motor`, que es la llamada que lo pone en marcha. Va como función y no como un
 * nombre de comando a propósito: quien pide el sonido es quien sabe qué hay que
 * mandarle al motor —y qué hacer con la foto que devuelve—.
 */
export interface PeticionPreview {
  origen: OrigenPreview;
  id: string;
  titulo?: string;
  /**
   * Dirección del audio que se reproduce en la interfaz, o una promesa que la
   * resuelve.
   *
   * La promesa existe por las muestras de voz de Fish: van **firmadas y caducan**,
   * así que la buena se pide al catálogo justo antes de sonar y eso tarda. Que la
   * espere el coordinador —y no cada tarjeta— es lo que hace que una muestra que
   * llega tarde no arranque por encima de la que se pidió después.
   */
  url?: string | Promise<string | undefined>;
  /** Lo que pone a sonar el motor. Solo se usa cuando no hay `url`. */
  motor?: () => void;
}

export interface PreviewAudio {
  /** Lo que suena ahora mismo, o `null`. */
  actual: PreviewActivo | null;
  estado: EstadoPreview;
  /** El motivo, cuando el estado es `error`. */
  error: string | null;
  /** De 0 a 1, mientras se sepa. */
  progreso: number | null;
  /** Reproduce, aunque ya estuviera sonando eso mismo: vuelve a empezar. */
  sonar: (peticion: PeticionPreview) => void;
  /** Si ya sonaba **eso mismo**, lo para; si no, reproduce. Es el botón interruptor. */
  alternar: (peticion: PeticionPreview) => void;
  /** Corta lo que suene, aquí y en el motor. */
  parar: () => void;
  /** Vuelve a intentar lo último que se pidió. */
  reintentar: () => void;
}

const Contexto = createContext<PreviewAudio | null>(null);

/**
 * El coordinador.
 *
 * Devuelve `null` si no hay proveedor —el banco de la interfaz, una página
 * suelta—: quien lo use tiene que poder pintarse sin sonido, y una tarjeta sin
 * botón de escuchar es mejor que una pantalla en blanco.
 */
export function usePreviewAudio(): PreviewAudio | null {
  return useContext(Contexto);
}

export function PreviewAudioProvider({ children }: { children: React.ReactNode }) {
  const elemento = useRef<HTMLAudioElement | null>(null);
  const [actual, setActual] = useState<PreviewActivo | null>(null);
  const [estado, setEstado] = useState<EstadoPreview>("parado");
  const [error, setError] = useState<string | null>(null);
  const [progreso, setProgreso] = useState<number | null>(null);
  /**
   * El número de la última petición.
   *
   * Es lo que hace que lo que llega tarde no arranque: cada petición se lleva su
   * marca, y cuando una promesa resuelve se comprueba que siga siendo la vigente.
   */
  const marca = useRef(0);
  /** Lo último pedido, para poder reintentarlo. */
  const ultima = useRef<PeticionPreview | null>(null);
  /**
   * Si el próximo `pause` del elemento es un corte **puesto por aquí**.
   *
   * El suceso de pausa no llega en el momento de pulsar, sino como una tarea
   * aparte: cuando se atiende, el `<audio>` ya puede tener la dirección nueva, y
   * pintar «en pausa» lo que se acaba de arrancar es un parpadeo que no dice nada.
   */
  const pausaPropia = useRef(false);

  /**
   * Pone una dirección en el `<audio>` y la arranca.
   *
   * La marca va aparte porque la dirección puede llegar de una promesa: cuando
   * resuelve, la petición puede haber dejado de ser la vigente, y entonces no se
   * arranca nada.
   */
  const arrancar = useCallback((url: string, mia: number) => {
    const el = elemento.current;
    if (!el) return;
    el.setAttribute("src", url);
    // `play()` devuelve una promesa que rechaza si el navegador no deja sonar
    // —falta de gesto, audio bloqueado, dirección caída—. Se dice, no se traga.
    el.play()
      .then(() => {
        // Un clic posterior ya mandó: esta reproducción no puede quedarse sonando
        // por haber resuelto tarde. Se comprueba **la dirección** y no solo la
        // marca, porque si el que llegó después también suena aquí, el elemento es
        // el mismo y un `pause()` a ciegas lo callaría a él.
        if (marca.current !== mia && el.getAttribute("src") === url) el.pause();
      })
      .catch(() => {
        if (marca.current !== mia) return;
        setEstado("error");
        setError(t.voces.muestraError);
      });
  }, []);

  /**
   * Deja el `<audio>` callado y **sin fichero**.
   *
   * Se suelta el `src` porque un elemento con dirección sigue teniendo abierto el
   * audio aunque esté en pausa: en una biblioteca que se recorre entera, eso son
   * decenas de descargas a medio terminar.
   */
  const callar = useCallback(() => {
    const el = elemento.current;
    if (!el) return;
    // La marca se pone **solo** si de verdad había algo sonando: `pause()` sobre un
    // elemento ya parado no dispara ningún suceso, y la marca se comería la próxima
    // pausa de verdad.
    if (!el.paused) pausaPropia.current = true;
    el.pause();
    el.removeAttribute("src");
    el.load();
  }, []);

  const parar = useCallback(() => {
    // La marca se mueve **antes** que nada: cualquier `play()` en vuelo queda
    // invalidado y no puede resucitar lo que se acaba de cortar.
    marca.current += 1;
    ultima.current = null;
    callar();
    setActual(null);
    setEstado("parado");
    setError(null);
    setProgreso(null);
    void api.pararPreview().catch(() => undefined);
  }, [callar]);

  /**
   * Reproduce, cortando antes lo que sonara.
   *
   * Es el `stopCurrent()` del coordinador: lo de aquí y lo del motor, en ese orden.
   * Al motor se le pide soltar **lo que este coordinador cree que suena** y no «lo
   * que sea»: si entre el clic y la orden el turno ya es de otra cosa, soltarlo sin
   * condición apagaría el sonido que acaba de empezar.
   */
  const reproducir = useCallback(
    (peticion: PeticionPreview) => {
      const mia = (marca.current += 1);
      const anterior = actual;
      ultima.current = peticion;
      callar();
      if (anterior) void api.pararPreview(anterior).catch(() => undefined);
      setActual({
        origen: peticion.origen,
        id: peticion.id,
        titulo: peticion.titulo ?? peticion.id,
      });
      setError(null);
      setProgreso(null);
      setEstado("cargando");

      if (peticion.url) {
        const pedida = peticion.url;
        if (typeof pedida === "string") {
          arrancar(pedida, mia);
          return;
        }
        // Una muestra firmada se pide antes de sonar. El turno ya es de esta
        // petición, así que si mientras llega se pide otra cosa, esta se descarta
        // —que es justo lo que evita que una muestra lenta arranque por encima de
        // la siguiente—.
        void pedida
          .then((url) => {
            if (url && marca.current === mia) arrancar(url, mia);
          })
          .catch(() => {
            if (marca.current !== mia) return;
            setEstado("error");
            setError(t.voces.muestraError);
          });
        return;
      }

      peticion.motor?.();
    },
    [actual, arrancar, callar],
  );

  const alternar = useCallback(
    (peticion: PeticionPreview) => {
      const mismo = actual?.origen === peticion.origen && actual.id === peticion.id;
      if (!mismo) {
        reproducir(peticion);
        return;
      }
      const el = elemento.current;
      // Volver a pulsar ▶ sobre una muestra en pausa la reanuda: el fichero sigue
      // cargado, así que pararla del todo sería empezar de cero por nada.
      if (peticion.url && el && estado === "pausado" && el.getAttribute("src")) {
        setEstado("cargando");
        el.play().catch(() => {
          setEstado("error");
          setError(t.voces.muestraError);
        });
        return;
      }
      parar();
    },
    [actual, estado, parar, reproducir],
  );

  const reintentar = useCallback(() => {
    if (ultima.current) reproducir(ultima.current);
  }, [reproducir]);

  /**
   * Mientras suena un preview **del motor**, se le pregunta si sigue sonando.
   *
   * Es lo que limpia el estado visual cuando el fichero se acaba: el motor lo sabe
   * y lo suelta al preguntárselo, y aquí se deja de pintar como sonando. Con la
   * muestra de una voz no se pregunta: esa suena en el `<audio>` de aquí, y quien
   * avisa de su final es el propio elemento.
   */
  useEffect(() => {
    if (!actual || actual.origen === "muestra-voz") return;
    let vivo = true;
    /** Si ya se le vio el turno al motor, un "no hay nadie" es que terminó. */
    let visto = false;
    const limite = Date.now() + GRACIA_MS;
    const preguntar = () => {
      void api
        .previewEstado()
        .then((duenio) => {
          if (!vivo) return;
          if (duenio) {
            visto = true;
            setEstado("sonando");
            return;
          }
          // Sin turno: o el motor ya terminó, o la orden va camino de llegar. El
          // margen distingue las dos cosas sin adivinar la duración del fichero.
          if (!visto && Date.now() < limite) return;
          setActual(null);
          setEstado("parado");
          setProgreso(null);
        })
        .catch(() => undefined);
    };
    preguntar();
    const temporizador = window.setInterval(preguntar, SONDEO_MS);
    return () => {
      vivo = false;
      window.clearInterval(temporizador);
    };
  }, [actual]);

  /** Los sucesos del elemento: son los que dicen de verdad qué está pasando. */
  useEffect(() => {
    const el = elemento.current;
    if (!el) return;
    const alSonar = () => setEstado("sonando");
    const alProgresar = () => {
      const duracion = el.duration;
      setProgreso(
        Number.isFinite(duracion) && duracion > 0 ? el.currentTime / duracion : null,
      );
    };
    const alPausar = () => {
      // Un corte puesto por el coordinador no es una pausa del streamer: ver
      // `pausaPropia`. Y un `pause` **sin dirección** es el que deja el elemento al
      // soltarlo, que tampoco se pinta.
      if (pausaPropia.current) {
        pausaPropia.current = false;
        return;
      }
      if (!el.getAttribute("src")) return;
      setEstado((antes) => (antes === "error" ? antes : "pausado"));
    };
    const alAcabar = () => {
      setActual(null);
      setEstado("parado");
      setProgreso(null);
      // El turno se suelta para no dejarlo apuntando a algo que ya no suena.
      void api.pararPreview().catch(() => undefined);
    };
    const alFallar = () => {
      setEstado("error");
      setError(t.voces.muestraError);
    };
    el.addEventListener("playing", alSonar);
    el.addEventListener("timeupdate", alProgresar);
    el.addEventListener("pause", alPausar);
    el.addEventListener("ended", alAcabar);
    el.addEventListener("error", alFallar);
    return () => {
      el.removeEventListener("playing", alSonar);
      el.removeEventListener("timeupdate", alProgresar);
      el.removeEventListener("pause", alPausar);
      el.removeEventListener("ended", alAcabar);
      el.removeEventListener("error", alFallar);
    };
  }, []);

  const valor = useMemo<PreviewAudio>(
    () => ({ actual, estado, error, progreso, sonar: reproducir, alternar, parar, reintentar }),
    [actual, estado, error, progreso, reproducir, alternar, parar, reintentar],
  );

  return (
    <Contexto.Provider value={valor}>
      {children}
      {/* El **único** elemento de audio de la interfaz. `preload="none"` a
          propósito: no se descarga nada hasta que alguien pulsa ▶. */}
      <audio ref={elemento} preload="none" />
    </Contexto.Provider>
  );
}
