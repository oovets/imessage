// Lazily resolves Telegram profile photos as data URLs, cached so each is
// fetched once (not per render / scroll). Returns null for non-Telegram chats,
// chats/users without a photo, or when avatars are disabled in settings.

import { useEffect, useState } from "react";
import { useAppStore } from "@/store/useAppStore";
import { isSource } from "@/lib/source";
import { tg } from "./api";
import { parseTgChatGuid } from "./adapters";

// `undefined` = not yet resolved, `null` = resolved: no photo. Only successful
// lookups land here: a failure (typically "Telegram is not ready" for chats
// restored from the persisted list before the core starts) stays unresolved so
// a later mount — or the re-run once telegramAvailable flips — retries it
// (after a backoff, for a failure that wasn't "not ready").
const cache = new Map<string, string | null>();
// In-flight lookups, so every tile/bubble showing the same avatar shares one.
// One still unsettled after JOIN_WINDOW_MS is presumed stuck (a stalled
// download) and a new mount starts its own, as every mount did before.
const JOIN_WINDOW_MS = 15_000;
const inflight = new Map<string, { pending: Promise<string | null>; started: number }>();
// A real failure (the core was up) isn't cached as "no photo", but isn't
// retried by every remount either: clearing the chat search remounts every
// row, and a persistent error (a peer that can't be resolved, or being
// offline) would cost a Telegram round trip each time. A mount retries it once
// a backoff has passed, doubling per consecutive failure.
const RETRY_BASE_MS = 2_000;
const RETRY_MAX_MS = 5 * 60_000;
const failures = new Map<string, { at: number; count: number }>();

function load(key: string, request: () => Promise<string | null>): Promise<string | null> {
  const joinable = inflight.get(key);
  if (joinable && Date.now() - joinable.started <= JOIN_WINDOW_MS) return joinable.pending;
  const entry = {
    pending: request().then(
      (resolved) => {
        cache.set(key, resolved);
        failures.delete(key);
        return resolved;
      },
      (e: unknown) => {
        // "not ready" is the startup race above: always retryable.
        if (!String(e).includes("not ready")) {
          const count = (failures.get(key)?.count ?? 0) + 1;
          failures.set(key, { at: Date.now(), count });
        }
        throw e;
      }
    ),
    started: Date.now(),
  };
  const settled = () => {
    if (inflight.get(key) === entry) inflight.delete(key);
  };
  entry.pending.then(settled, settled);
  inflight.set(key, entry);
  return entry.pending;
}

/** Whether `key` failed so recently that a mount shouldn't retry it yet. */
function coolingDown(key: string): boolean {
  const failed = failures.get(key);
  if (!failed) return false;
  const backoff = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (failed.count - 1));
  return Date.now() - failed.at < backoff;
}

/** A Telegram chat's profile photo (chat-list avatar). */
export function useTelegramAvatar(guid: string): string | null {
  const showAvatars = useAppStore((s) => s.showAvatars);
  // The backend answers "not ready" until the core has started; wait for it.
  const telegramAvailable = useAppStore((s) => s.telegramAvailable);
  const [url, setUrl] = useState<string | null>(() => cache.get(guid) ?? null);

  useEffect(() => {
    if (!showAvatars || !isSource(guid, "telegram")) return;
    if (cache.has(guid)) {
      setUrl(cache.get(guid) ?? null);
      return;
    }
    if (!telegramAvailable || coolingDown(guid)) return;
    let cancelled = false;
    const { accountId, chatId } = parseTgChatGuid(guid);
    load(guid, () => tg.avatarDataUrl(accountId, chatId))
      .then((resolved) => {
        if (!cancelled) setUrl(resolved);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [guid, showAvatars, telegramAvailable]);

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
  const telegramAvailable = useAppStore((s) => s.telegramAvailable);
  const userId = senderAddress ? Number(senderAddress) : NaN;
  const eligible =
    showAvatars && isSource(chatGuid, "telegram") && Number.isFinite(userId) && userId > 0;
  const key = eligible ? `user:${parseTgChatGuid(chatGuid).accountId}:${userId}` : "";
  const [url, setUrl] = useState<string | null>(() => (key ? (cache.get(key) ?? null) : null));

  useEffect(() => {
    if (!eligible) return;
    if (cache.has(key)) {
      setUrl(cache.get(key) ?? null);
      return;
    }
    if (!telegramAvailable || coolingDown(key)) return;
    let cancelled = false;
    const { accountId } = parseTgChatGuid(chatGuid);
    load(key, () => tg.userAvatarDataUrl(accountId, userId))
      .then((resolved) => {
        if (!cancelled) setUrl(resolved);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [eligible, key, telegramAvailable]);

  return eligible ? url : null;
}
