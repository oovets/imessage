import { useEffect, useRef } from "react";
import { useAppStore } from "@/store/useAppStore";
import { getClient } from "@/api/clientFactory";
import { notifyIncomingMessage } from "@/lib/desktopNotifications";
import { getChatDisplayName } from "@/types";

const CHAT_POLL_MS = 15_000;
const MSG_POLL_MS = 4_000;

export function usePollingFallback() {
  const pollingFallback = useAppStore((s) => s.pollingFallback);
  const isConfigured = useAppStore((s) => s.isConfigured);
  const serverUrl = useAppStore((s) => s.serverUrl);
  const password = useAppStore((s) => s.password);
  const selectedChatGUID = useAppStore((s) => s.selectedChatGUID);
  const setConnectionNotice = useAppStore((s) => s.setConnectionNotice);

  const lastSeenRef = useRef<Record<string, string>>({});

  useEffect(() => {
    if (!pollingFallback || !isConfigured || !selectedChatGUID) return;

    let cancelled = false;
    const client = getClient(serverUrl, password);
    const { upsertMessage, markChatHasNewMessage } = useAppStore.getState();

    async function tick() {
      if (cancelled) return;
      try {
        const { messageFetchedAt } = useAppStore.getState();
        const after = messageFetchedAt[selectedChatGUID!] ?? 0;
        const msgs = await client.getMessages(
          selectedChatGUID!,
          25,
          after > 0 ? after : undefined
        );
        if (msgs.length === 0) return;

        for (const m of msgs) {
          upsertMessage(m);
        }

        const newest = msgs[msgs.length - 1];
        if (newest) {
          const prev = lastSeenRef.current[selectedChatGUID!];
          if (prev && prev !== newest.guid && !newest.isFromMe) {
            markChatHasNewMessage(selectedChatGUID!);
            const chat = useAppStore.getState().chats.find((c) => c.guid === selectedChatGUID);
            const name = chat ? getChatDisplayName(chat) : "New message";
            void notifyIncomingMessage(name, newest);
          }
          lastSeenRef.current[selectedChatGUID!] = newest.guid;
        }
        setConnectionNotice(null);
      } catch {
        setConnectionNotice("Polling fallback active, but server is currently unreachable.");
      }
    }

    tick();
    const id = setInterval(tick, MSG_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [pollingFallback, isConfigured, serverUrl, password, selectedChatGUID, setConnectionNotice]);

  useEffect(() => {
    if (!pollingFallback || !isConfigured) return;
    let cancelled = false;
    const client = getClient(serverUrl, password);

    async function tick() {
      if (cancelled) return;
      try {
        const chats = await client.getChats();
        const current = useAppStore.getState().chats;
        const previousByGuid = new Map(current.map((c) => [c.guid, c]));
        const merged = chats.map((chat) => {
          const prev = previousByGuid.get(chat.guid);
          if (!prev) return chat;
          return {
            ...chat,
            // Carry forward what the server didn't send: a response without
            // lastMessage would otherwise reset activityAt and sink every
            // iMessage chat below every Telegram chat.
            activityAt: chat.activityAt ?? prev.activityAt,
            lastMessageText:
              chat.lastMessageText ??
              chat.lastMessage?.text ??
              prev.lastMessageText ??
              prev.lastMessage?.text ??
              "",
          };
        });
        useAppStore.getState().setChats(merged);
        setConnectionNotice(null);
      } catch {
        setConnectionNotice("Cannot refresh chats while disconnected from server.");
      }
    }

    const id = setInterval(tick, CHAT_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [pollingFallback, isConfigured, serverUrl, password, setConnectionNotice]);
}
