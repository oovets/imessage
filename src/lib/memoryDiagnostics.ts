import { useAppStore } from "@/store/useAppStore";

/**
 * Dev-only memory snapshot. Attaches `window.__mem()` so you can capture a
 * consistent set of counters at each baseline scenario (cold start, big chat
 * open, 1000-message scroll, 50 chats opened, idle, reconnect, …) from the
 * Safari Web Inspector console without instrumenting components.
 *
 * Pair the JS-heap figure with the WebContent process RSS from
 * `vmmap <pid>` / Activity Monitor — the two live in different processes and
 * neither alone tells the whole story for a Tauri/WKWebView app.
 */
export interface MemorySnapshot {
  jsHeapMB: number | null;
  domNodes: number;
  imgNodes: number;
  detachedListeners: "use Web Inspector: Timeline → JS heap → Retainers";
  cachedChats: number;
  cachedMessageObjects: number;
  linkPreviews: number;
  paneLeaves: number;
}

function countMessageObjects(messages: Record<string, unknown[]>): number {
  let total = 0;
  for (const key in messages) total += messages[key]?.length ?? 0;
  return total;
}

export function memorySnapshot(): MemorySnapshot {
  const s = useAppStore.getState();
  // performance.memory is non-standard and Chromium-only; on WKWebView it is
  // usually undefined — fall back to null and read the heap from Web Inspector.
  const perfMemory = (performance as unknown as {
    memory?: { usedJSHeapSize: number };
  }).memory;

  let paneLeaves = 0;
  const stack = [s.paneTree];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.type === "leaf") paneLeaves += 1;
    else stack.push(n.children[0], n.children[1]);
  }

  return {
    jsHeapMB: perfMemory ? Math.round(perfMemory.usedJSHeapSize / 1e5) / 10 : null,
    domNodes: document.getElementsByTagName("*").length,
    imgNodes: document.images.length,
    detachedListeners: "use Web Inspector: Timeline → JS heap → Retainers",
    cachedChats: Object.keys(s.messages).length,
    cachedMessageObjects: countMessageObjects(s.messages),
    linkPreviews: Object.keys(s.linkPreviewCache).length,
    paneLeaves,
  };
}

// --- Scenario recorder ----------------------------------------------------
// Automates the baseline click-sequence: start a timer, walk through the
// scenarios marking each one, then dump a table / CSV. Saves you from typing
// __mem() by hand at every step.
//
//   __memRec.start()                 // begins sampling every 5s
//   __memRec.mark("open big chat")   // label the current moment
//   ...do the action...
//   __memRec.mark("scroll 1000")
//   __memRec.stop()
//   __memRec.dump()                  // console.table + returns CSV
//
// Combine with scripts/mem-snapshot.sh for the matching RSS column.

interface RecordedRow extends MemorySnapshot {
  t: number; // seconds since start
  label: string;
}

interface MemRecorder {
  start: (intervalSec?: number) => void;
  mark: (label: string) => MemorySnapshot;
  stop: () => void;
  dump: () => string;
  rows: RecordedRow[];
}

function createRecorder(): MemRecorder {
  let timer: ReturnType<typeof setInterval> | null = null;
  let startedAt = 0;
  const rows: RecordedRow[] = [];

  const sample = (label: string): MemorySnapshot => {
    const snap = memorySnapshot();
    const t = startedAt ? Math.round((Date.now() - startedAt) / 1000) : 0;
    rows.push({ t, label, ...snap });
    return snap;
  };

  return {
    rows,
    start(intervalSec = 5) {
      if (timer) clearInterval(timer);
      startedAt = Date.now();
      rows.length = 0;
      sample("start");
      timer = setInterval(() => sample("tick"), intervalSec * 1000);
    },
    mark(label: string) {
      const snap = sample(label);
      console.log(`[mem] ${label}`, snap);
      return snap;
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    dump() {
      console.table(rows);
      const cols = [
        "t",
        "label",
        "jsHeapMB",
        "domNodes",
        "imgNodes",
        "cachedChats",
        "cachedMessageObjects",
        "linkPreviews",
        "paneLeaves",
      ] as const;
      const header = cols.join(",");
      const lines = rows.map((r) =>
        cols.map((c) => JSON.stringify((r as unknown as Record<string, unknown>)[c] ?? "")).join(",")
      );
      return [header, ...lines].join("\n");
    },
  };
}

export function installMemoryDiagnostics(): void {
  if (typeof window === "undefined") return;
  const w = window as unknown as {
    __mem: () => MemorySnapshot;
    __memRec: MemRecorder;
  };
  w.__mem = memorySnapshot;
  w.__memRec = createRecorder();
}
