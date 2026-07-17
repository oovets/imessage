// Adapters: Telegram domain types -> the host's iMessage-shaped Chat/Message,
// so the existing components render Telegram conversations unchanged.
//
// Telegram chats get a namespaced GUID `tg:<accountId>:<chatId>`; messages get
// `tg:<accountId>:<chatId>:<messageId>`. The prefix is what the store and the
// message router use to tell the two sources apart.

import type { Chat, Message } from "@/types";
import type { TgChat, TgMedia, TgMessage } from "./types";

export function tgChatGuid(accountId: number, chatId: number): string {
  return `tg:${accountId}:${chatId}`;
}

export function tgMessageGuid(
  accountId: number,
  chatId: number,
  messageId: number,
): string {
  return `tg:${accountId}:${chatId}:${messageId}`;
}

/** Parse `tg:<accountId>:<chatId>` back into its numeric parts. */
export function parseTgChatGuid(guid: string): { accountId: number; chatId: number } {
  const [account, chat] = guid.slice(3).split(":");
  return { accountId: Number(account), chatId: Number(chat) };
}

function mediaPlaceholder(media: TgMedia | null): string {
  if (!media) return "";
  switch (media.type) {
    case "photo":
      return "📷 Photo";
    case "sticker":
      return `${media.emoji} Sticker`;
    case "document":
      return `📎 ${media.file_name}`;
    case "other":
      return media.description;
  }
}

export function tgChatToChat(accountId: number, c: TgChat): Chat {
  const guid = tgChatGuid(accountId, c.id);
  const preview = c.last_message_preview ?? "";
  const ts = c.last_message_at ? Date.parse(c.last_message_at) : 0;
  return {
    guid,
    displayName: c.title,
    chatIdentifier: c.username ?? String(c.id),
    participants: [],
    unreadCount: c.unread_count,
    lastMessageText: preview,
    // A minimal last-message stub carries the timestamp used to sort the
    // unified chat list and the preview shown under the title.
    lastMessage: ts
      ? {
          guid: `${guid}:last`,
          text: preview,
          isFromMe: false,
          dateCreated: ts,
          handle: null,
          attachments: [],
          associatedMessageGuid: "",
          associatedMessageType: "",
        }
      : null,
  };
}

export function tgMessageToMessage(m: TgMessage): Message {
  return {
    guid: tgMessageGuid(m.account_id, m.chat_id, m.id),
    text: m.text || mediaPlaceholder(m.media),
    isFromMe: m.outgoing,
    dateCreated: Date.parse(m.date),
    handle:
      m.sender_id != null
        ? { address: String(m.sender_id), firstName: m.sender_name ?? "" }
        : null,
    // Media and reactions are wired up in a later phase.
    attachments: [],
    associatedMessageGuid: "",
    associatedMessageType: "",
    chatGUID: tgChatGuid(m.account_id, m.chat_id),
    pending: m.send_state === "pending",
    failed: m.send_state === "failed",
  };
}
