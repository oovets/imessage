export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** The macOS desktop window, whose traffic lights overlay the toolbar. */
export function hasTrafficLights(): boolean {
  return isTauriRuntime() && /Mac/i.test(navigator.userAgent);
}
