// Loads Telegram accounts + chats into the shared store on startup, so they
// appear in the unified chat list alongside iMessage conversations.

import { useEffect } from "react";
import { useAppStore } from "@/store/useAppStore";
import { tg } from "@/telegram/api";
import { tgChatToChat } from "@/telegram/adapters";
import type { Chat } from "@/types";

export function useTelegramInbox() {
  const setTelegramChats = useAppStore((s) => s.setTelegramChats);
  const setTelegramAvailable = useAppStore((s) => s.setTelegramAvailable);
  // Re-runs when an account is added/removed (reloadTelegram bumps this).
  const reloadNonce = useAppStore((s) => s.telegramReloadNonce);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const available = await tg.status();
        if (cancelled) return;
        setTelegramAvailable(available);
        if (!available) return;

        const accounts = (await tg.listAccounts()).filter((a) => a.authorized);
        const all: Chat[] = [];
        for (const account of accounts) {
          const chats = await tg.chatList(account.id);
          for (const chat of chats) all.push(tgChatToChat(account.id, chat));
        }
        if (!cancelled) setTelegramChats(all);
      } catch (e) {
        console.error("telegram inbox load failed:", e);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [setTelegramChats, setTelegramAvailable, reloadNonce]);
}
