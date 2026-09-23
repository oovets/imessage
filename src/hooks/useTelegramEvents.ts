// Bridges the Telegram core event stream (tg:core-event) into the shared
// store, mirroring how useWebSocket drives the iMessage side. This is what
// makes Telegram conversations update in real time.

import { useEffect } from "react";
import { useAppStore } from "@/store/useAppStore";
import { onTelegramEvent } from "@/telegram/api";
import { tgChatGuid, tgChatToChat, tgMessageGuid, tgMessageToMessage } from "@/telegram/adapters";
import type { TgChat, TgMessage } from "@/telegram/types";
import type { Chat } from "@/types";

type CoreEvent =
  | { kind: "message_added"; message: TgMessage }
  | { kind: "message_updated"; message: TgMessage }
  | {
      kind: "message_deleted";
      account_id: number;
      chat_id: number;
      message_ids: number[];
    }
  | { kind: "chat_updated"; chat: TgChat }
  | { kind: "typing"; account_id: number; chat_id: number; user_id: number }
  | {
      kind: "presence_changed";
      account_id: number;
      user_id: number;
      presence:
        | { status: "online" }
        | { status: "offline"; last_seen: string | null }
        | { status: "hidden" };
    }
  | { kind: string };

// Every sync start (launch, reconnect, wake) announces each dialog as its own
// chat_updated, 100 per account, each a separate Tauri event. Applied one by
// one that was 100 sorts and 100 chat-list commits in a row, so chat updates
// are held for at most this long and applied together. Any other event first
// applies what is held, so the store still sees events in arrival order — a
// new message's chat_updated lands before its message_added, as before.
// A timer, not requestAnimationFrame: rAF stops while the window is hidden,
// and background unread counts and auto-reply must keep flowing. While the
// page is hidden nothing is held at all, since WebKit throttles its timers.
const CHAT_UPDATE_COALESCE_MS = 16;

export function useTelegramEvents() {
  useEffect(() => {
    let heldChats: Chat[] = [];
    let holdTimer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;

    function applyHeldChats() {
      if (holdTimer !== undefined) {
        clearTimeout(holdTimer);
        holdTimer = undefined;
      }
      if (heldChats.length === 0) return;
      const batch = heldChats;
      heldChats = [];
      useAppStore.getState().upsertChats(batch);
    }

    function holdChat(chat: Chat) {
      heldChats.push(chat);
      if (disposed || document.visibilityState === "hidden") {
        applyHeldChats();
        return;
      }
      if (holdTimer === undefined) {
        holdTimer = setTimeout(applyHeldChats, CHAT_UPDATE_COALESCE_MS);
      }
    }

    function onVisibilityChange() {
      if (document.visibilityState === "hidden") applyHeldChats();
    }
    document.addEventListener("visibilitychange", onVisibilityChange);

    const unlisten = onTelegramEvent((raw) => {
      const event = raw as CoreEvent;

      if (event.kind === "chat_updated") {
        const c = (event as { chat: TgChat }).chat;
        holdChat(tgChatToChat(c.account_id, c));
        return;
      }
      applyHeldChats();

      const store = useAppStore.getState();

      switch (event.kind) {
        case "message_added":
        case "message_updated":
          store.upsertMessage(tgMessageToMessage((event as { message: TgMessage }).message));
          break;

        case "message_deleted": {
          const e = event as {
            account_id: number;
            chat_id: number;
            message_ids: number[];
          };
          const chatGuid = tgChatGuid(e.account_id, e.chat_id);
          for (const id of e.message_ids) {
            store.removeMessage(chatGuid, tgMessageGuid(e.account_id, e.chat_id, id));
          }
          break;
        }

        case "typing": {
          const e = event as { account_id: number; chat_id: number };
          // setTyping stores a future expiry timestamp; Telegram only signals
          // "started", so each event refreshes the window.
          store.setTyping(tgChatGuid(e.account_id, e.chat_id), true);
          break;
        }

        case "presence_changed": {
          const e = event as {
            account_id: number;
            user_id: number;
            presence:
              | { status: "online" }
              | { status: "offline"; last_seen: string | null }
              | { status: "hidden" };
          };
          // A private chat's GUID is tg:<account>:<userId>, so presence keys
          // straight onto the conversation.
          const guid = tgChatGuid(e.account_id, e.user_id);
          store.setTelegramPresence(guid, {
            online: e.presence.status === "online",
            lastSeen:
              e.presence.status === "offline" && e.presence.last_seen
                ? Date.parse(e.presence.last_seen)
                : null,
          });
          break;
        }

        // typing / presence / transfer_progress / sync_state / login are
        // handled in later phases.
        default:
          break;
      }
    });

    return () => {
      // Nothing received is dropped: apply what is held, and anything still
      // arriving before the listener is gone applies immediately.
      disposed = true;
      applyHeldChats();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      unlisten.then((f) => f()).catch(() => {});
    };
  }, []);
}
