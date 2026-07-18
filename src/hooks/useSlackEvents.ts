// Bridges `sl:core-event` into the store: new messages, edits and deletes land
// in the open conversation and bump the chat list, mirroring useTelegramEvents.

import { useEffect } from "react";
import { useAppStore } from "@/store/useAppStore";
import { onSlackEvent } from "@/slack/api";
import {
  slChatGuid,
  slFileToAttachment,
  slMessageGuid,
  slTsToMillis,
} from "@/slack/adapters";
import { slackTextToPlain } from "@/slack/mrkdwn";
import { getChatDisplayName } from "@/types";
import { notifyIncomingMessage } from "@/lib/desktopNotifications";
import type { Message } from "@/types";

export function useSlackEvents() {
  useEffect(() => {
    const unlisten = onSlackEvent((ev) => {
      const store = useAppStore.getState();
      const ws = ev.workspace_id;

      // A lagged broadcast means we missed updates; refetch rather than
      // silently showing a conversation with holes in it.
      if (ev.kind === "lagged") {
        store.reloadSlack();
        return;
      }

      const nm = ev.update?.NewMessage;
      if (nm) {
        const chatGUID = slChatGuid(ws, nm.channel_id);
        const message: Message = {
          guid: slMessageGuid(ws, nm.channel_id, nm.ts),
          text: slackTextToPlain(nm.text ?? "", store.slackUserNames[ws] ?? {}),
          isFromMe: nm.is_self,
          dateCreated: slTsToMillis(nm.ts),
          handle: nm.user_name ? { address: nm.user_name, firstName: nm.user_name } : null,
          // Same helper the history adapter uses, so a message looks the same
          // whether it arrived live or was loaded from history.
          attachments: (nm.files ?? [])
            .map((f) => slFileToAttachment(ws, f))
            .filter(Boolean),
          associatedMessageGuid: "",
          associatedMessageType: "",
          chatGUID,
        } as Message;

        store.upsertMessage(message);
        store.updateChatPreview(chatGUID, message.text);
        if (!nm.is_self) {
          store.markChatHasNewMessage(chatGUID);
          const chat = store.chats.find((c) => c.guid === chatGUID);
          void notifyIncomingMessage(
            chat ? getChatDisplayName(chat) : nm.user_name || "Slack",
            message
          );
        }
        return;
      }

      const changed = ev.update?.MessageChanged;
      if (changed) {
        const chatGUID = slChatGuid(ws, changed.channel_id);
        const existing = store.messages[chatGUID]?.find(
          (m) => m.guid === slMessageGuid(ws, changed.channel_id, changed.ts)
        );
        if (existing) store.upsertMessage({ ...existing, text: changed.new_text });
        return;
      }

      const deleted = ev.update?.MessageDeleted;
      if (deleted) {
        store.removeMessage(
          slChatGuid(ws, deleted.channel_id),
          slMessageGuid(ws, deleted.channel_id, deleted.ts)
        );
      }
    });

    return () => {
      unlisten.then((f) => f()).catch(() => {});
    };
  }, []);
}
