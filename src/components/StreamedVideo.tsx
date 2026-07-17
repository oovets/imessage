// Plays a BlueBubbles video attachment with no UI freeze and low memory.
//
// The backend downloads the file to a temp file (bytes fetched in Rust — they
// never cross the IPC boundary, which is what froze the main thread before)
// and we stream it via the asset protocol (convertFileSrc), so playback seeks
// from disk with range requests instead of holding the whole video in memory.
// A cached temp file is reused across mounts.

import { useEffect, useState } from "react";
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
        const path = await invoke<string>("download_to_temp", { url: src, name });
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
