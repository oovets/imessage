// Bridges the Telegram core event stream (tg:core-event) into the shared
// store, mirroring how useWebSocket drives the iMessage side. This is what
// makes Telegram conversations update in real time.

import { useEffect } from "react";
import { useAppStore } from "@/store/useAppStore";
import { onTelegramEvent } from "@/telegram/api";
import { tgChatToChat, tgMessageGuid, tgMessageToMessage } from "@/telegram/adapters";
import type { TgChat, TgMessage } from "@/telegram/types";

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
  | { kind: string };

export function useTelegramEvents() {
  useEffect(() => {
    const unlisten = onTelegramEvent((raw) => {
      const event = raw as CoreEvent;
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
          const chatGuid = `tg:${e.account_id}:${e.chat_id}`;
          for (const id of e.message_ids) {
            store.removeMessage(chatGuid, tgMessageGuid(e.account_id, e.chat_id, id));
          }
          break;
        }

        case "chat_updated": {
          const c = (event as { chat: TgChat }).chat;
          store.upsertChat(tgChatToChat(c.account_id, c));
          break;
        }

        case "typing": {
          const e = event as { account_id: number; chat_id: number };
          // setTyping stores a future expiry timestamp; Telegram only signals
          // "started", so each event refreshes the window.
          store.setTyping(`tg:${e.account_id}:${e.chat_id}`, true);
          break;
        }

        // typing / presence / transfer_progress / sync_state / login are
        // handled in later phases.
        default:
          break;
      }
    });

    return () => {
      unlisten.then((f) => f()).catch(() => {});
    };
  }, []);
}
