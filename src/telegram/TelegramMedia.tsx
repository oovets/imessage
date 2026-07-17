// Renders a Telegram media attachment by lazily fetching its bytes as a data
// URL (tg_media_data_url, cache-first on the backend). Photos and stickers
// render inline; documents render as a downloadable card.

import { useEffect, useState } from "react";
import { FileDown } from "lucide-react";
import type { Attachment } from "@/types";
import { tg } from "./api";

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
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    tg.mediaDataUrl(accountId, chatId, messageId, cacheKey, att.mimeType)
      .then((u) => {
        if (!cancelled) setUrl(u);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [att.guid]);

  const mime = att.mimeType ?? "";
  const isVideo = mime.startsWith("video/");
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
          className="rounded-lg max-h-80 max-w-full -mx-1 mb-1"
        />
      );
    }
    return (
      <div className="rounded-lg bg-muted/40 text-muted-foreground text-xs px-3 py-6 my-1 text-center min-w-32">
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
              : "rounded-lg max-h-80 max-w-full -mx-1 mb-1 object-cover"
          }
        />
      );
    }
    return (
      <div className="rounded-lg bg-muted/40 text-muted-foreground text-xs px-3 py-6 my-1 text-center min-w-32">
        {failed ? "⚠ media unavailable" : "Loading media…"}
      </div>
    );
  }

  // Other documents: a download card.
  return (
    <a
      href={url ?? undefined}
      download={att.transferName}
      className="flex items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2 my-1 text-sm hover:bg-muted/60"
      title={att.transferName}
    >
      <FileDown className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span className="truncate">{att.transferName}</span>
    </a>
  );
}
