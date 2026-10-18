const OPEN_SETTINGS = "app:open-settings";

/** Opens the Settings dialog from anywhere (an empty state, the status menu). */
export function openSettings(): void {
  window.dispatchEvent(new Event(OPEN_SETTINGS));
}

/** For the Settings dialog: call `onOpen` whenever openSettings() is. */
export function onOpenSettings(onOpen: () => void): () => void {
  window.addEventListener(OPEN_SETTINGS, onOpen);
  return () => window.removeEventListener(OPEN_SETTINGS, onOpen);
}
