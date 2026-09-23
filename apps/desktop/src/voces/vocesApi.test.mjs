import assert from "node:assert/strict";
import test from "node:test";

import { api } from "../api.ts";
import { limpiarCacheCatalogo, vocesApi } from "./vocesApi.ts";

test("reabrir el catalogo con los mismos filtros no repite la red dentro del TTL", async () => {
  limpiarCacheCatalogo();
  const anterior = api.ttsVocesBuscar;
  let peticiones = 0;
  api.ttsVocesBuscar = async (filtros) => {
    peticiones += 1;
    return {
      total: 1,
      pagina: filtros.pagina ?? 1,
      tamano: filtros.tamano ?? 24,
      items: [],
    };
  };

  try {
    const filtros = {
      buscar: "voz alegre",
      idioma: "es",
      tag: "stream",
      autor: "autor-1",
      propios: false,
      pagina: 1,
      tamano: 24,
    };
    await vocesApi.buscar(filtros);
    await vocesApi.buscar({ ...filtros });

    assert.equal(peticiones, 1);
  } finally {
    api.ttsVocesBuscar = anterior;
    limpiarCacheCatalogo();
  }
});
