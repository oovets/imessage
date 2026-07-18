// Memory-friendly, orientation-correct inline image.
//
// Fetches the full image (which carries EXIF orientation), decodes it applying
// that orientation, and draws a *downscaled* copy to a canvas — so the DOM
// keeps only a small bitmap instead of a full-resolution one, while still
// showing the correct rotation (server thumbnails drop EXIF and render sideways).
// Falls back to a plain <img> if createImageBitmap options aren't supported.

import { useEffect, useRef, useState } from "react";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

// Retina-friendly cap for an inline bubble image (rendered at max-h-80).
const MAX_THUMB_WIDTH = 720;

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
  const [mode, setMode] = useState<"loading" | "canvas" | "img">("loading");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await tauriFetch(src);
        if (!res.ok) throw new Error(`http ${res.status}`);
        const blob = await res.blob();
        // `from-image` applies the EXIF orientation to the decoded bitmap.
        const bitmap = await createImageBitmap(blob, {
          imageOrientation: "from-image",
        } as ImageBitmapOptions);
        if (cancelled) {
          bitmap.close();
          return;
        }
        const canvas = canvasRef.current;
        if (!canvas) {
          bitmap.close();
          return;
        }
        const scale = Math.min(1, MAX_THUMB_WIDTH / bitmap.width);
        const w = Math.max(1, Math.round(bitmap.width * scale));
        const h = Math.max(1, Math.round(bitmap.height * scale));
        canvas.width = w;
        canvas.height = h;
        canvas.getContext("2d")?.drawImage(bitmap, 0, 0, w, h);
        bitmap.close(); // release the full-resolution decode
        setMode("canvas");
      } catch {
        if (!cancelled) setMode("img");
      }
    })();
    return () => {
      cancelled = true;
    };
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
