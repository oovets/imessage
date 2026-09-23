// @vitest-environment jsdom
import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useMediaQuery } from "./useMediaQuery";

type Listener = () => void;

/** A controllable matchMedia: `set` flips `matches` and fires "change". */
function installMatchMedia(initial: boolean, { legacy = false } = {}) {
  let matches = initial;
  const listeners = new Set<Listener>();
  const queries: string[] = [];
  const mql = {
    get matches() {
      return matches;
    },
    media: "",
    ...(legacy
      ? {
          addListener: (cb: Listener) => listeners.add(cb),
          removeListener: (cb: Listener) => listeners.delete(cb),
        }
      : {
          addEventListener: (_type: string, cb: Listener) => listeners.add(cb),
          removeEventListener: (_type: string, cb: Listener) => listeners.delete(cb),
        }),
  };
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (q: string) => {
      queries.push(q);
      return mql;
    },
  });
  return {
    listeners,
    queries,
    set(next: boolean) {
      matches = next;
      listeners.forEach((cb) => cb());
    },
  };
}

function Probe({ query, seen }: { query: string; seen: boolean[] }) {
  const value = useMediaQuery(query);
  seen.push(value);
  return <span data-testid="value">{String(value)}</span>;
}

afterEach(() => {
  delete (window as { matchMedia?: unknown }).matchMedia;
});

describe("useMediaQuery", () => {
  it("has the real answer on the very first render (no flip after mount)", () => {
    installMatchMedia(false);
    const seen: boolean[] = [];
    render(<Probe query="(min-width: 768px)" seen={seen} />);
    // Every render saw `false`: a layout branching on it never mounts the
    // wrong tree first.
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((v) => v === false)).toBe(true);
  });

  it("follows change events and unsubscribes on unmount", () => {
    const mm = installMatchMedia(true);
    const seen: boolean[] = [];
    const { getByTestId, unmount } = render(<Probe query="(min-width: 768px)" seen={seen} />);
    expect(getByTestId("value").textContent).toBe("true");
    expect(mm.queries).toEqual(["(min-width: 768px)"]);

    act(() => mm.set(false));
    expect(getByTestId("value").textContent).toBe("false");
    act(() => mm.set(true));
    expect(getByTestId("value").textContent).toBe("true");
    // One MediaQueryList per query, not one per render.
    expect(mm.queries).toHaveLength(1);

    expect(mm.listeners.size).toBe(1);
    unmount();
    expect(mm.listeners.size).toBe(0);
  });

  it("uses the legacy listener API where addEventListener is missing", () => {
    const mm = installMatchMedia(true, { legacy: true });
    const { getByTestId, unmount } = render(<Probe query="(min-width: 768px)" seen={[]} />);
    act(() => mm.set(false));
    expect(getByTestId("value").textContent).toBe("false");
    unmount();
    expect(mm.listeners.size).toBe(0);
  });

  it("falls back to true where matchMedia does not exist", () => {
    expect(typeof window.matchMedia).toBe("undefined");
    const seen: boolean[] = [];
    const { getByTestId } = render(<Probe query="(min-width: 768px)" seen={seen} />);
    expect(getByTestId("value").textContent).toBe("true");
    expect(seen.every((v) => v === true)).toBe(true);
  });
});
