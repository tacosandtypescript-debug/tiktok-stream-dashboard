import React from "react";
import ReactDOM from "react-dom/client";

import { api } from "./api";
import { App } from "./App";
import "./styles.css";

/**
 * Barrera de errores.
 *
 * Sin ella, una excepción durante el render desmonta el árbol y la ventana se
 * queda en blanco o congelada **sin dejar rastro**: es exactamente el síntoma
 * de "la interfaz no se actualiza". Aquí se muestra el fallo y se reporta a
 * Rust, que lo escribe en `error.log`.
 */
class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    const detalle = `${error.message}\n${info.componentStack ?? ""}`;
    console.error(error, info);
    void api.uiError(detalle).catch(() => undefined);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="fatal">
          <h2>La interfaz encontró un error</h2>
          <p className="hint">
            El motor sigue funcionando y los datos se están guardando. Anota este
            mensaje y reabre la aplicación; el detalle completo está en el
            registro de errores.
          </p>
          <pre>{this.state.error.message}</pre>
          <button type="button" onClick={() => this.setState({ error: null })}>
            Reintentar
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

const container = document.getElementById("root");
if (!container) {
  throw new Error("falta el contenedor #root");
}

ReactDOM.createRoot(container).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
