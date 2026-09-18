import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Configuracion de Vite para Tauri: puerto fijo (Tauri lo espera) y sin
// observar src-tauri (Rust se recompila por su cuenta).
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    target: "chrome110",
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
  },
});
