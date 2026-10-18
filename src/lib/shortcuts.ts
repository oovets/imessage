/**
 * Shortcut labels and the primary modifier, per platform. macOS spells
 * shortcuts with ⌘ / ⌥ / ⇧ glyphs and uses ⌘; Linux and Windows spell them
 * out ("Ctrl+K") and use Ctrl. Read on each call, so tests can stub the
 * platform.
 */
export function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent);
}

/** "⌘K" on macOS, "Ctrl+K" elsewhere. */
export function modLabel(key: string | number): string {
  return isMacPlatform() ? `⌘${key}` : `Ctrl+${key}`;
}

/** "⇧⌘D" on macOS, "Ctrl+Shift+D" elsewhere. */
export function shiftModLabel(key: string): string {
  return isMacPlatform() ? `⇧⌘${key}` : `Ctrl+Shift+${key}`;
}

/** "⌥↵" on macOS, "Alt+↵" elsewhere. */
export function altLabel(key: string): string {
  return isMacPlatform() ? `⌥${key}` : `Alt+${key}`;
}

/**
 * The platform's primary modifier alone: ⌘ on macOS, Ctrl elsewhere. The
 * other one must be up, so Ctrl-chords on macOS (and Super on Linux) pass.
 */
export function isPrimaryModifier(event: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return isMacPlatform()
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
}
