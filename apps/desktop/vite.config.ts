import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * A donde apunta el proxy de desarrollo.
 *
 * `npm run dev` levanta la interfaz con recarga en caliente, pero el motor no
 * vive aqui: vive en el servidor del panel (`tiktok-stream-dashboard.exe --web`).
 * Con este proxy, la pagina se sirve desde Vite y las llamadas a `/api` van al
 * motor, asi que se puede tocar React y verlo al instante **contra datos reales**.
 *
 * Coincide con `TTSDASH_WEB_PORT` del servidor; si alli se cambia el puerto, aqui
 * se cambia con la misma variable.
 */
// Se lee de `globalThis` en vez de `process.env` para no arrastrar `@types/node`
// a la interfaz, que no lo usa para nada mas.
const entorno = (
  globalThis as { process?: { env?: Record<string, string | undefined> } }
).process?.env;
const motor = `http://127.0.0.1:${entorno?.TTSDASH_WEB_PORT ?? "8790"}`;

// Configuracion de Vite para Tauri: puerto fijo (Tauri lo espera) y sin
// observar src-tauri (Rust se recompila por su cuenta).
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      // `src-tauri` se recompila por su cuenta. Y las carpetas temporales que dejan los
      // editores al guardar (`.package.json.<pid>.<uuid>.tmpdir`) tumbaban el servidor
      // con EBUSY: el vigilante intentaba seguirlas justo cuando desaparecían.
      ignored: ["**/src-tauri/**", "**/.*.tmpdir/**", "**/*.tmp", "**/.*.tmp"],
    },
    fs: {
      // El motor del juego vive en el prototipo (`prototipos/trompos/js`), que es su
      // entorno de pruebas: el overlay lo importa de allí en vez de mantener una copia.
      allow: [".", "..", "../..", "../../.."],
    },
    proxy: {
      // El WebSocket de eventos necesita `ws: true`: sin eso el proxy corta la
      // conexion y el chat se queda quieto aunque el motor este mandando.
      "/api": { target: motor, changeOrigin: true, ws: true },
    },
  },
  build: {
    target: "chrome110",
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    // Dos documentos: la interfaz (`index.html`) y el overlay del juego
    // (`juego.html`), que OBS carga como fuente de navegador.
    rollupOptions: { input: { index: "index.html", juego: "juego.html" } },
  },
});
