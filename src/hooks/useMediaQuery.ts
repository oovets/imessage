import { useCallback, useMemo, useSyncExternalStore } from "react";

/**
 * Whether `query` currently matches, kept live across viewport changes.
 *
 * Built on useSyncExternalStore so the very first render already has the
 * right answer (getSnapshot reads `matches` synchronously). A layout that
 * branches on it never mounts the wrong tree and then swaps it out.
 *
 * `fallback` is used where matchMedia does not exist (jsdom, very old
 * webviews).
 */
export function useMediaQuery(query: string, fallback = true): boolean {
  const mql = useMemo(
    () =>
      typeof window !== "undefined" && typeof window.matchMedia === "function"
        ? window.matchMedia(query)
        : null,
    [query]
  );

  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!mql) return () => {};
      // Safari < 14 (macOS 10.15 WKWebView) only has the legacy listener API.
      if (typeof mql.addEventListener === "function") {
        mql.addEventListener("change", onChange);
        return () => mql.removeEventListener("change", onChange);
      }
      mql.addListener?.(onChange);
      return () => mql.removeListener?.(onChange);
    },
    [mql]
  );

  const getSnapshot = useCallback(() => (mql ? mql.matches : fallback), [mql, fallback]);

  return useSyncExternalStore(subscribe, getSnapshot);
}
