import assert from "node:assert/strict";
import test from "node:test";

import { crearColaDeGuardados } from "./alertasGuardado.ts";

test("dos guardados seguidos conservan los cambios de ambos avisos", async () => {
  const inicial = {
    gift: { medio: "", activo: false },
    follow: { sonido: "", activo: false },
  };
  const enviados = [];
  let liberarPrimero;
  const primeraRespuesta = new Promise((resolve) => {
    liberarPrimero = resolve;
  });
  const cola = crearColaDeGuardados(inicial);

  const guardar = async (ajustes) => {
    enviados.push(structuredClone(ajustes));
    if (enviados.length === 1) await primeraRespuesta;
    return structuredClone(ajustes);
  };

  const primero = cola.encolar(
    (actuales) => ({
      ...actuales,
      gift: { ...actuales.gift, medio: "regalo.gif" },
    }),
    guardar,
  );
  const segundo = cola.encolar(
    (actuales) => ({
      ...actuales,
      follow: { ...actuales.follow, sonido: "follow.ogg" },
    }),
    guardar,
  );

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(enviados.length, 1, "el segundo guardado debe esperar al primero");

  liberarPrimero();
  await Promise.all([primero, segundo]);

  assert.deepEqual(enviados[1], {
    gift: { medio: "regalo.gif", activo: false },
    follow: { sonido: "follow.ogg", activo: false },
  });
});
