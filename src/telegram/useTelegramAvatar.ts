// Lazily resolves Telegram profile photos as data URLs, cached so each is
// fetched once (not per render / scroll). Returns null for non-Telegram chats,
// chats/users without a photo, or when avatars are disabled in settings.

import { useEffect, useState } from "react";
import { isTelegramChatGuid, useAppStore } from "@/store/useAppStore";
import { tg } from "./api";
import { parseTgChatGuid } from "./adapters";

// `undefined` = not yet resolved, `null` = resolved: no photo.
const cache = new Map<string, string | null>();

/** A Telegram chat's profile photo (chat-list avatar). */
export function useTelegramAvatar(guid: string): string | null {
  const showAvatars = useAppStore((s) => s.showAvatars);
  const [url, setUrl] = useState<string | null>(() => cache.get(guid) ?? null);

  useEffect(() => {
    if (!showAvatars || !isTelegramChatGuid(guid)) return;
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
  }, [guid, showAvatars]);

  return showAvatars ? url : null;
}

/**
 * A Telegram sender's profile photo for in-conversation mini avatars. The
 * sender address is the numeric user id (set by the message adapter).
 */
export function useTelegramSenderAvatar(
  chatGuid: string,
  senderAddress: string | null | undefined
): string | null {
  const showAvatars = useAppStore((s) => s.showAvatars);
  const userId = senderAddress ? Number(senderAddress) : NaN;
  const eligible =
    showAvatars && isTelegramChatGuid(chatGuid) && Number.isFinite(userId) && userId > 0;
  const key = eligible ? `user:${parseTgChatGuid(chatGuid).accountId}:${userId}` : "";
  const [url, setUrl] = useState<string | null>(() => (key ? (cache.get(key) ?? null) : null));

  useEffect(() => {
    if (!eligible) return;
    if (cache.has(key)) {
      setUrl(cache.get(key) ?? null);
      return;
    }
    let cancelled = false;
    const { accountId } = parseTgChatGuid(chatGuid);
    tg.userAvatarDataUrl(accountId, userId)
      .then((resolved) => {
        cache.set(key, resolved);
        if (!cancelled) setUrl(resolved);
      })
      .catch(() => cache.set(key, null));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eligible, key]);

  return eligible ? url : null;
}
