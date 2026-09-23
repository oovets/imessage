// Renders a Telegram media attachment by lazily fetching its bytes as a data
// URL (tg_media_data_url, cache-first on the backend). Photos and stickers
// render inline; documents render as a downloadable card.

import { useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { FileDown } from "lucide-react";
import type { Attachment } from "@/types";
import { tg } from "./api";

// Resolved data URLs by att.guid (unique per media: it embeds the cacheKey),
// kept in JS so a chat revisit or pane remount renders straight from memory
// instead of decrypting + base64-encoding every item over IPC again, and shows
// the <img> on the first render instead of a "Loading media…" flash. Media
// stays encrypted at rest — nothing extra is written to disk. LRU (Map
// insertion order), bounded by total string length; only successes are kept.
const MAX_CACHED_CHARS = 50 * 1024 * 1024;
const dataUrls = new Map<string, string>();
let cachedChars = 0;
// In-flight loads, so the same media in two panes is fetched once. One still
// unsettled after JOIN_WINDOW_MS is presumed stuck (a stalled download) and a
// new mount starts its own, as every mount did before loads were shared.
const JOIN_WINDOW_MS = 15_000;
const inflight = new Map<string, { pending: Promise<string>; started: number }>();

/** A cached data URL, marked most-recently-used. */
function takeDataUrl(guid: string): string | undefined {
  const url = dataUrls.get(guid);
  if (url !== undefined) {
    dataUrls.delete(guid);
    dataUrls.set(guid, url);
  }
  return url;
}

function remember(guid: string, url: string) {
  // Larger than the whole budget (a huge document): don't flush everything else.
  if (url.length > MAX_CACHED_CHARS) return;
  const prev = dataUrls.get(guid);
  if (prev !== undefined) cachedChars -= prev.length;
  dataUrls.delete(guid);
  dataUrls.set(guid, url);
  cachedChars += url.length;
  for (const [key, value] of dataUrls) {
    if (cachedChars <= MAX_CACHED_CHARS) break;
    dataUrls.delete(key);
    cachedChars -= value.length;
  }
}

function loadDataUrl(guid: string, request: () => Promise<string>): Promise<string> {
  const joinable = inflight.get(guid);
  if (joinable && Date.now() - joinable.started <= JOIN_WINDOW_MS) return joinable.pending;
  const load = {
    pending: request().then((url) => {
      remember(guid, url);
      return url;
    }),
    started: Date.now(),
  };
  const settled = () => {
    if (inflight.get(guid) === load) inflight.delete(guid);
  };
  load.pending.then(settled, settled);
  inflight.set(guid, load);
  return load.pending;
}

// tgmedia:<accountId>:<chatId>:<messageId>:<type>:<cacheKey>
function parse(guid: string) {
  const [, account, chat, message, type, cacheKey] = guid.split(":");
  return {
    accountId: Number(account),
    chatId: Number(chat),
    messageId: Number(message),
    type,
    cacheKey,
  };
}

export function TelegramMedia({ att }: { att: Attachment }) {
  const { accountId, chatId, messageId, type, cacheKey } = parse(att.guid);
  const mime = att.mimeType ?? "";
  const isVideo = mime.startsWith("video/");
  const [url, setUrl] = useState<string | null>(() =>
    isVideo ? null : (dataUrls.get(att.guid) ?? null)
  );
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (isVideo) {
      // Stream from a decrypted temp file via the asset protocol (range
      // requests / seeking, no full-video base64 in the JS heap).
      const ext = mime.split("/")[1] || "mp4";
      tg.mediaFile(accountId, chatId, messageId, cacheKey, ext)
        .then((path) => {
          if (!cancelled) setUrl(convertFileSrc(path));
        })
        .catch(() => {
          if (!cancelled) setFailed(true);
        });
    } else {
      const cached = takeDataUrl(att.guid);
      if (cached !== undefined) {
        setUrl(cached);
        return;
      }
      loadDataUrl(att.guid, () =>
        tg.mediaDataUrl(accountId, chatId, messageId, cacheKey, att.mimeType)
      )
        .then((u) => {
          if (!cancelled) setUrl(u);
        })
        .catch(() => {
          if (!cancelled) setFailed(true);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [att.guid]);

  const isSticker = type === "sticker";
  // Photos and stickers are images; a "document" with an image mime is one too.
  const isImage = type === "photo" || type === "sticker" || mime.startsWith("image/");

  if (isVideo) {
    if (url) {
      return (
        <video
          src={url}
          controls
          preload="metadata"
          className="rounded-md max-h-80 max-w-full -mx-1 mb-1"
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
    return (
      <div className="rounded-md bg-muted/40 text-muted-foreground text-xs px-3 py-6 my-1 text-center min-w-32">
        {failed ? "⚠ video unavailable" : "Loading video…"}
      </div>
    );
  }

  if (isImage) {
    if (url) {
      return (
        <img
          src={url}
          alt={att.transferName}
          style={{ imageOrientation: "from-image" }}
          className={
            isSticker
              ? "max-h-32 max-w-[8rem] -mx-1 mb-1"
              : "rounded-md max-h-80 max-w-full -mx-1 mb-1 object-cover"
          }
        />
      );
    }
    return (
      <div className="rounded-md bg-muted/40 text-muted-foreground text-xs px-3 py-6 my-1 text-center min-w-32">
        {failed ? "⚠ media unavailable" : "Loading media…"}
      </div>
    );
  }

  // Other documents: a download card.
  return (
    <a
      href={url ?? undefined}
      download={att.transferName}
      className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 my-1 text-sm hover:bg-muted/60"
      title={att.transferName}
    >
      <FileDown className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span className="truncate">{att.transferName}</span>
    </a>
  );
}
