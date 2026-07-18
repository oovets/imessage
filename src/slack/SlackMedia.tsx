// Renders a Slack file attachment.
//
// Slack's url_private links only resolve with the workspace token, so the
// webview cannot load them directly — an <img src> pointed at one gets an HTML
// sign-in page back, which is why these used to render as broken cards. The
// host downloads the bytes with the token and hands back a temp-file path that
// the asset protocol serves (and, for video, range-requests so seeking works).

import { useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { FileDown } from "lucide-react";
import type { Attachment } from "@/types";
import { sl } from "./api";
import { parseSlFileGuid } from "./adapters";

/** Stable temp-file name; the key is unique per file (see slFileToAttachment). */
function tempName(fileKey: string, transferName: string): string {
  const ext = transferName.includes(".") ? transferName.split(".").pop() : "";
  return ext ? `${fileKey}.${ext}` : fileKey;
}

export function SlackMedia({ att }: { att: Attachment }) {
  const { workspaceId, fileKey } = parseSlFileGuid(att.guid);
  const mime = att.mimeType ?? "";
  const isVideo = mime.startsWith("video/");
  const isImage = mime.startsWith("image/");

  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // Only media is fetched eagerly. Other documents wait for a click, so a
    // channel full of large files doesn't download them all on scroll.
    if (!isImage && !isVideo) return;

    sl.downloadFile(workspaceId, att.url, tempName(fileKey, att.transferName))
      .then((path) => {
        if (!cancelled) setUrl(convertFileSrc(path));
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [att.guid, att.url, isImage, isVideo]);

  if (isVideo) {
    if (!url) {
      return (
        <div className="rounded-lg bg-muted/40 text-muted-foreground text-xs px-3 py-6 my-1 text-center min-w-32">
          {failed ? "⚠ video unavailable" : "Loading video…"}
        </div>
      );
    }
    return (
      <video
        src={url}
        controls
        preload="metadata"
        className="rounded-lg max-h-80 max-w-full -mx-1 mb-1"
        onError={() => setFailed(true)}
        onLoadedMetadata={(e) => {
          // Show the first frame as a poster instead of a black box.
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

  if (isImage) {
    if (!url) {
      return (
        <div className="rounded-lg bg-muted/40 text-muted-foreground text-xs px-3 py-6 my-1 text-center min-w-32">
          {failed ? "⚠ image unavailable" : "Loading image…"}
        </div>
      );
    }
    return (
      <img
        src={url}
        alt={att.transferName || "Slack image"}
        style={{ imageOrientation: "from-image" }}
        className="rounded-lg max-h-80 max-w-full -mx-1 mb-1 object-cover"
        onError={() => setFailed(true)}
      />
    );
  }

  // Everything else: a card that downloads on demand and then opens.
  return (
    <button
      onClick={async () => {
        try {
          const path = await sl.downloadFile(
            workspaceId,
            att.url,
            tempName(fileKey, att.transferName)
          );
          window.open(convertFileSrc(path), "_blank");
        } catch {
          setFailed(true);
        }
      }}
      className="flex w-full items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2 my-1 text-sm hover:bg-muted/60"
      title={att.transferName}
    >
      <FileDown className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span className="truncate">{att.transferName}</span>
      {failed && <span className="ml-auto text-xs text-destructive">failed</span>}
    </button>
  );
}
