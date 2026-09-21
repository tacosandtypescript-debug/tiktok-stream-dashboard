//! El estado de la pestaña «Explorar Fish Audio».
//!
//! Vive en su propio hook porque tiene lo que ninguna otra parte de la pantalla
//! tiene: red que falla, paginas que se acumulan y un buscador que **no puede**
//! lanzar una peticion por tecla. Mezclado con el resto de la biblioteca, eso son
//! cien lineas mas en un componente que ya de por si pinta mucho.
//!
//! Reglas que se cumplen aqui:
//!
//!   * el buscador espera [`ESPERA_BUSQUEDA`] desde la ultima tecla;
//!   * «Cargar mas» **añade** la pagina siguiente, no la sustituye;
//!   * cambiar de filtro o de busqueda empieza por la pagina 1 y tira lo anterior;
//!   * un fallo se enseña y **no borra** lo que ya estaba cargado.

import { useCallback, useEffect, useRef, useState } from "react";

import type { TtsFiltrosVoces, TtsVozFish } from "../api";
import { ErrorVoces, vocesApi } from "./vocesApi";

/** Cuanto se espera desde la ultima tecla antes de preguntar. */
export const ESPERA_BUSQUEDA = 350;

/** Cuantas voces se piden por pagina. */
export const POR_PAGINA = 24;

export interface EstadoCatalogo {
  items: TtsVozFish[];
  total: number;
  cargando: boolean;
  cargandoMas: boolean;
  error: string | null;
  hayMas: boolean;
  /** Vuelve a pedir la primera pagina con los filtros de ahora. */
  recargar: () => void;
  /** Pide la siguiente y la añade. */
  cargarMas: () => void;
}

/**
 * El catalogo, con sus filtros y su paginacion.
 *
 * `activo` es lo que lo enciende: en la pestaña de «Mis voces» no se pide nada a
 * la red, y pedirlo seria gastar cuota ajena por una lista que no se esta viendo.
 */
export function useCatalogo(
  filtros: TtsFiltrosVoces,
  activo: boolean,
): EstadoCatalogo {
  const [items, setItems] = useState<TtsVozFish[]>([]);
  const [total, setTotal] = useState(0);
  const [pagina, setPagina] = useState(1);
  const [cargando, setCargando] = useState(false);
  const [cargandoMas, setCargandoMas] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Con que filtros se cargaron los `items` que hay ahora. */
  const cargados = useRef<string>("");
  /** Cada peticion lleva su numero: la ultima que llega es la que pinta. */
  const turno = useRef(0);

  // El buscador espera a que el streamer pare de teclear.
  const [buscar, setBuscar] = useState(filtros.buscar ?? "");
  useEffect(() => {
    const reloj = setTimeout(() => setBuscar(filtros.buscar ?? ""), ESPERA_BUSQUEDA);
    return () => clearTimeout(reloj);
  }, [filtros.buscar]);

  const clave = JSON.stringify({
    buscar,
    idioma: filtros.idioma ?? "",
    tag: filtros.tag ?? "",
    autor: filtros.autor ?? "",
    propios: filtros.propios ?? false,
  });

  const pedir = useCallback(
    async (numero: number, acumular: boolean) => {
      const mio = ++turno.current;
      if (acumular) setCargandoMas(true);
      else setCargando(true);
      setError(null);
      try {
        const respuesta = await vocesApi.buscar({
          buscar,
          idioma: filtros.idioma,
          tag: filtros.tag,
          autor: filtros.autor,
          propios: filtros.propios,
          pagina: numero,
          tamano: POR_PAGINA,
        });
        // Si mientras tanto se pidio otra cosa, esta respuesta ya no vale.
        if (mio !== turno.current) return;
        setTotal(respuesta.total);
        setPagina(respuesta.pagina);
        setItems((previas) => {
          if (!acumular) return respuesta.items;
          // Se quitan los repetidos por si la API devolviera una voz en dos
          // paginas: dos tarjetas de la misma voz solo hacen dudar.
          const vistas = new Set(previas.map((voz) => voz.id));
          return [...previas, ...respuesta.items.filter((voz) => !vistas.has(voz.id))];
        });
        cargados.current = clave;
      } catch (causa) {
        if (mio !== turno.current) return;
        setError(causa instanceof ErrorVoces ? causa.message : String(causa));
      } finally {
        if (mio === turno.current) {
          setCargando(false);
          setCargandoMas(false);
        }
      }
    },
    [buscar, clave, filtros.autor, filtros.idioma, filtros.propios, filtros.tag],
  );

  const recargar = useCallback(() => {
    if (!activo) return;
    void pedir(1, false);
  }, [activo, pedir]);

  // Al entrar en la pestaña, o al cambiar cualquier filtro, se empieza de cero.
  useEffect(() => {
    if (!activo) return;
    if (cargados.current === clave) return;
    void pedir(1, false);
  }, [activo, clave, pedir]);

  const cargarMas = useCallback(() => {
    if (!activo || cargando || cargandoMas) return;
    void pedir(pagina + 1, true);
  }, [activo, cargando, cargandoMas, pagina, pedir]);

  const hayMas = items.length < total;

  return { items, total, cargando, cargandoMas, error, hayMas, recargar, cargarMas };
}
