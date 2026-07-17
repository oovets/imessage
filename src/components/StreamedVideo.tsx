// Plays a BlueBubbles video attachment. A plain <video src={serverUrl}> often
// won't play: the element uses the webview's own networking (not the Tauri
// http plugin), so it hits CORS/cert/range issues reaching the server. We
// fetch the bytes through the Tauri http plugin and play them from an
// in-memory object URL, which the browser can seek natively.

import { useEffect, useState } from "react";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

export function StreamedVideo({
  src,
  mime,
  className,
}: {
  src: string;
  mime?: string;
  className?: string;
}) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let created: string | null = null;
    (async () => {
      try {
        const res = await tauriFetch(src);
        if (!res.ok) throw new Error(`http ${res.status}`);
        const buffer = await res.arrayBuffer();
        if (cancelled) return;
        // The server often omits Content-Type, so a plain res.blob() has no
        // type and the <video> can't pick a decoder. Force the known mime.
        const blob = new Blob([buffer], { type: mime || "video/mp4" });
        created = URL.createObjectURL(blob);
        setObjectUrl(created);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
      if (created) URL.revokeObjectURL(created);
    };
  }, [src, mime]);

  if (failed) {
    return (
      <div className="rounded-lg bg-muted/40 text-muted-foreground text-xs px-3 py-6 my-1 text-center">
        ⚠ video unavailable
      </div>
    );
  }
  if (!objectUrl) {
    return (
      <div className="rounded-lg bg-muted/40 text-muted-foreground text-xs px-3 py-6 my-1 text-center min-w-32">
        Loading video…
      </div>
    );
  }
  return (
    <video
      src={objectUrl}
      controls
      preload="metadata"
      className={className}
      onError={() => setFailed(true)}
    />
  );
}
