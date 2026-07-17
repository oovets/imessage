import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";
import { ThemeProvider } from "./components/ThemeProvider";
import { isTauriRuntime } from "./lib/tauriEnv";
import { installMemoryDiagnostics } from "./lib/memoryDiagnostics";

// Expose window.__mem() for capturing memory-baseline snapshots during dev.
if (import.meta.env.DEV) {
  installMemoryDiagnostics();
}

// Lets CSS opt into native-window styling (transparent background for vibrancy,
// titlebar inset) only when running inside the Tauri shell — never in a browser.
if (isTauriRuntime()) {
  document.documentElement.classList.add("tauri");
}

createRoot(document.getElementById("root")!).render(
  <ThemeProvider>
    <App />
  </ThemeProvider>
);
