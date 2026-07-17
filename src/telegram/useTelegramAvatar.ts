// Lazily resolves a Telegram chat's profile photo as a data URL, cached per
// GUID so it's fetched once (not per render / scroll). Returns null for
// non-Telegram chats or chats without a photo.

import { useEffect, useState } from "react";
import { isTelegramChatGuid } from "@/store/useAppStore";
import { tg } from "./api";
import { parseTgChatGuid } from "./adapters";

// `undefined` = not yet resolved, `null` = resolved: no photo.
const cache = new Map<string, string | null>();

export function useTelegramAvatar(guid: string): string | null {
  const [url, setUrl] = useState<string | null>(() => cache.get(guid) ?? null);

  useEffect(() => {
    if (!isTelegramChatGuid(guid)) return;
    if (cache.has(guid)) {
      setUrl(cache.get(guid) ?? null);
      return;
    }
    let cancelled = false;
    const { accountId, chatId } = parseTgChatGuid(guid);
    tg.avatarDataUrl(accountId, chatId)
      .then((resolved) => {
        cache.set(guid, resolved);
        if (!cancelled) setUrl(resolved);
      })
      .catch(() => cache.set(guid, null));
    return () => {
      cancelled = true;
    };
  }, [guid]);

  return url;
}
