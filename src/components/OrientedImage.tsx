// Memory-friendly, orientation-correct inline image.
//
// Fetches the full image (which carries EXIF orientation), decodes it applying
// that orientation, and draws a *downscaled* copy to a canvas — so the DOM
// keeps only a small bitmap instead of a full-resolution one, while still
// showing the correct rotation (server thumbnails drop EXIF and render sideways).
// Falls back to a plain <img> if createImageBitmap options aren't supported.
//
// The downscaled bitmap is kept in a small module-level LRU keyed by src, and
// concurrent loads of one src share a single fetch. MessageList remounts per
// chat (and a focus toggle remounts every pane), so without this every revisit
// re-downloaded and re-decoded every original; with it a revisit paints the
// same pixels synchronously before first paint.

import { useLayoutEffect, useRef, useState } from "react";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

// Retina-friendly cap for an inline bubble image (rendered at max-h-80).
const MAX_THUMB_WIDTH = 720;

// Total pixel area of cached thumbnails (~64 MB of RGBA): a few dozen bubble
// images, i.e. the photos of the last couple of chats.
const MAX_CACHED_AREA = 16_000_000;

type Waiter = { ok: (thumb: ImageBitmap) => void; fail: () => void };

// A load still unsettled after this long is presumed stalled (plugin-http has
// no timeout, and a tunnel can hang a response indefinitely): a new mount
// starts a fresh one instead of joining it, as every mount did before loads
// were shared — otherwise one stalled response would blank that image for the
// whole session.
const JOIN_WINDOW_MS = 15_000;

// `thumb` is null while the load is in flight; mounted canvases waiting on it
// sit in `waiters`. Map insertion order is the LRU order (oldest first).
type Entry = { thumb: ImageBitmap | null; waiters: Set<Waiter>; started: number };

const entries = new Map<string, Entry>();
let cachedArea = 0;

const areaOf = (b: ImageBitmap) => b.width * b.height;

// Fetch + orientation-correct decode + downscale: exactly the pipeline that
// used to draw straight into the bubble's canvas, now producing a bitmap of
// the final w×h so drawing it 1:1 yields the same pixels.
async function decodeThumb(src: string): Promise<ImageBitmap> {
  const res = await tauriFetch(src);
  if (!res.ok) throw new Error(`http ${res.status}`);
  const blob = await res.blob();
  // `from-image` applies the EXIF orientation to the decoded bitmap.
  const bitmap = await createImageBitmap(blob, {
    imageOrientation: "from-image",
  } as ImageBitmapOptions);
  const scale = Math.min(1, MAX_THUMB_WIDTH / bitmap.width);
  if (scale === 1) return bitmap; // already bubble-sized: keep the decode as-is
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  try {
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    ctx.drawImage(bitmap, 0, 0, w, h);
    return await createImageBitmap(canvas);
  } finally {
    bitmap.close(); // release the full-resolution decode
    canvas.width = canvas.height = 0; // and the scratch canvas's backing store
  }
}

/** A cached thumbnail for `src`, marked most-recently-used; null on a miss. */
function takeThumb(src: string): ImageBitmap | null {
  const entry = entries.get(src);
  if (!entry?.thumb) return null;
  entries.delete(src);
  entries.set(src, entry);
  return entry.thumb;
}

function settle(src: string, entry: Entry, thumb: ImageBitmap) {
  // Waiters draw first, synchronously, so eviction below can never close a
  // bitmap a mounted canvas is still about to draw. (Drawing copies the pixels,
  // so closing it afterwards is safe.)
  for (const w of entry.waiters) {
    try {
      w.ok(thumb);
    } catch {
      w.fail();
    }
  }
  entry.waiters.clear();
  const area = areaOf(thumb);
  const current = entries.get(src);
  if (area > MAX_CACHED_AREA || (current && current !== entry)) {
    // Too big to cache on its own (an extreme panorama), or a stalled load a
    // later mount has already replaced: drop it.
    if (current === entry) entries.delete(src);
    thumb.close();
    return;
  }
  entry.thumb = thumb;
  cachedArea += area;
  entries.delete(src);
  entries.set(src, entry);
  // Evict oldest ready entries until back under budget. In-flight entries hold
  // no pixels and have waiters, so they're skipped.
  for (const [key, e] of entries) {
    if (cachedArea <= MAX_CACHED_AREA) break;
    if (!e.thumb || e === entry) continue;
    entries.delete(key);
    cachedArea -= areaOf(e.thumb);
    e.thumb.close();
  }
}

/**
 * Start (or join) the load for `src`. The waiter is called once it settles;
 * the returned function unsubscribes it (the load itself carries on and is
 * cached for the next mount).
 */
function loadThumb(src: string, waiter: Waiter): () => void {
  let entry = entries.get(src);
  if (!entry || (!entry.thumb && Date.now() - entry.started > JOIN_WINDOW_MS)) {
    // (A stalled entry keeps its own waiters; it's just no longer the one
    // new mounts join or the cache records.)
    const created: Entry = { thumb: null, waiters: new Set(), started: Date.now() };
    entries.set(src, created);
    decodeThumb(src).then(
      (thumb) => settle(src, created, thumb),
      () => {
        // Forget failures so the next mount retries.
        if (entries.get(src) === created) entries.delete(src);
        for (const w of created.waiters) w.fail();
        created.waiters.clear();
      }
    );
    entry = created;
  }
  const waiters = entry.waiters;
  waiters.add(waiter);
  return () => {
    waiters.delete(waiter);
  };
}

function paint(canvas: HTMLCanvasElement, thumb: ImageBitmap) {
  canvas.width = thumb.width;
  canvas.height = thumb.height;
  canvas.getContext("2d")?.drawImage(thumb, 0, 0);
}

export function OrientedImage({
  src,
  alt,
  className,
}: {
  src: string;
  alt: string;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [mode, setMode] = useState<"loading" | "canvas" | "img">(() =>
    entries.get(src)?.thumb ? "canvas" : "loading"
  );

  // Layout effect so a cache hit is drawn before the browser paints: no blank
  // canvas, no pop-in, no content shift above the scroll position.
  useLayoutEffect(() => {
    const show = (thumb: ImageBitmap) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      try {
        paint(canvas, thumb);
        setMode("canvas");
      } catch {
        setMode("img");
      }
    };
    const cached = takeThumb(src);
    if (cached) {
      show(cached);
      return;
    }
    return loadThumb(src, { ok: show, fail: () => setMode("img") });
  }, [src]);

  if (mode === "img") {
    return (
      <img
        src={src}
        alt={alt}
        loading="lazy"
        className={className}
        style={{ imageOrientation: "from-image" }}
      />
    );
  }
  // While loading the canvas is hidden (its intrinsic size is 0), so nothing
  // is drawn until the downscaled bitmap is ready.
  return <canvas ref={canvasRef} aria-label={alt} className={className} />;
}
