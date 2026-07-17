// Plays a BlueBubbles video attachment with low memory use.
//
// A plain <video src={serverUrl}> won't play (the webview's own networking
// hits CORS/cert/range on the server). We fetch the bytes through the Tauri
// http plugin *once*, write them to a temp file, and stream that file via the
// asset protocol (convertFileSrc) — so playback seeks from disk with range
// requests instead of holding the whole video in the JS heap. A cached temp
// file is reused across mounts, avoiding re-downloads.

import { useEffect, useState } from "react";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";

// Stable, collision-resistant temp-file name from the source URL.
function nameFor(src: string, ext: string): string {
  let hash = 0;
  for (let i = 0; i < src.length; i++) hash = (hash * 31 + src.charCodeAt(i)) | 0;
  return `bb-${(hash >>> 0).toString(36)}.${ext}`;
}

export function StreamedVideo({
  src,
  mime,
  className,
}: {
  src: string;
  mime?: string;
  className?: string;
}) {
  const [fileSrc, setFileSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const ext = (mime?.split("/")[1] || "mp4").replace(/[^a-z0-9]/gi, "");
        const name = nameFor(src, ext);
        // Reuse an already-downloaded temp file if present (no re-fetch).
        const existing = await invoke<string | null>("media_temp_path", { name });
        if (cancelled) return;
        if (existing) {
          setFileSrc(convertFileSrc(existing));
          return;
        }
        const res = await tauriFetch(src);
        if (!res.ok) throw new Error(`http ${res.status}`);
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (cancelled) return;
        const path = await invoke<string>("save_media_temp", { bytes, name });
        if (!cancelled) setFileSrc(convertFileSrc(path));
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [src, mime]);

  if (failed) {
    return (
      <div className="rounded-lg bg-muted/40 text-muted-foreground text-xs px-3 py-6 my-1 text-center">
        ⚠ video unavailable
      </div>
    );
  }
  if (!fileSrc) {
    return (
      <div className="rounded-lg bg-muted/40 text-muted-foreground text-xs px-3 py-6 my-1 text-center min-w-32">
        Loading video…
      </div>
    );
  }
  return (
    <video
      src={fileSrc}
      controls
      preload="metadata"
      className={className}
      onError={() => setFailed(true)}
      // Nudge to the first frame so it shows as a poster instead of a black box.
      onLoadedMetadata={(e) => {
        const v = e.currentTarget;
        if (v.currentTime === 0) {
          try {
            v.currentTime = 0.05;
          } catch {
            /* seeking not ready yet */
          }
        }
      }}
    />
  );
}
