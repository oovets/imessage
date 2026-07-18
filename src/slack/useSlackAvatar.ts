// Lazily resolves Slack profile photos for in-conversation mini avatars,
// mirroring useTelegramSenderAvatar. The sender address on Slack messages is
// the Slack user id (set by both the history adapter and the realtime
// handler), which is what the backend's user cache keys on. The URL itself is
// a public avatars.slack-edge.com link, so the webview loads it directly.

import { useEffect, useState } from "react";
import { useAppStore } from "@/store/useAppStore";
import { isSource } from "@/lib/source";
import { sl } from "./api";
import { parseSlChatGuid } from "./adapters";

// `has(key)` distinguishes "resolved: none" (cached null) from "not asked yet".
const cache = new Map<string, string | null>();

export function useSlackSenderAvatar(
  chatGuid: string,
  senderAddress: string | null | undefined
): string | null {
  const showAvatars = useAppStore((s) => s.showAvatars);
  const key = `${chatGuid}:${senderAddress ?? ""}`;
  const [url, setUrl] = useState<string | null>(() => cache.get(key) ?? null);

  useEffect(() => {
    if (!showAvatars || !senderAddress || !isSource(chatGuid, "slack")) return;
    // U/W = humans (users.info), B = apps (bots.info); anything else is a
    // display name that can't be resolved to an avatar.
    if (!/^[UVWB][A-Z0-9]+$/.test(senderAddress)) return;
    if (cache.has(key)) {
      setUrl(cache.get(key) ?? null);
      return;
    }
    let cancelled = false;
    const { workspaceId } = parseSlChatGuid(chatGuid);
    sl.userAvatar(workspaceId, senderAddress)
      .then((resolved) => {
        cache.set(key, resolved);
        if (!cancelled) setUrl(resolved);
      })
      .catch(() => cache.set(key, null));
    return () => {
      cancelled = true;
    };
  }, [key, chatGuid, senderAddress, showAvatars]);

  return showAvatars ? url : null;
}
