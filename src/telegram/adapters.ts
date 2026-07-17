// Adapters: Telegram domain types -> the host's iMessage-shaped Chat/Message,
// so the existing components render Telegram conversations unchanged.
//
// Telegram chats get a namespaced GUID `tg:<accountId>:<chatId>`; messages get
// `tg:<accountId>:<chatId>:<messageId>`. The prefix is what the store and the
// message router use to tell the two sources apart.

import type { Attachment, Chat, Message } from "@/types";
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

// Renderable media (photo/sticker/document) becomes an attachment whose guid
// encodes what TelegramMedia needs to fetch the bytes lazily. cache_key never
// contains ":" (it's `photo-<id>` / `doc-<id>`), so ":" is a safe separator.
function tgMediaAttachments(m: TgMessage): Attachment[] {
  const media = m.media;
  if (!media || media.type === "other") return [];
  const mime =
    media.type === "photo"
      ? "image/jpeg"
      : media.type === "sticker"
        ? "image/webp"
        : media.mime_type;
  const name =
    media.type === "document"
      ? media.file_name
      : media.type === "sticker"
        ? `${media.emoji} sticker`
        : "Photo";
  const guid = `tgmedia:${m.account_id}:${m.chat_id}:${m.id}:${media.type}:${media.cache_key}`;
  return [{ guid, mimeType: mime, transferName: name, url: "" }];
}

export function tgMessageToMessage(m: TgMessage): Message {
  const attachments = tgMediaAttachments(m);
  // Only fall back to a media placeholder when there's nothing renderable
  // (polls, locations); otherwise let the image/document speak for itself.
  const text = m.text || (attachments.length === 0 ? mediaPlaceholder(m.media) : "");
  const tgReactions = m.reactions.length
    ? m.reactions.map((r) => (r.count > 1 ? `${r.emoji} ${r.count}` : r.emoji))
    : undefined;
  return {
    guid: tgMessageGuid(m.account_id, m.chat_id, m.id),
    text,
    isFromMe: m.outgoing,
    dateCreated: Date.parse(m.date),
    handle:
      m.sender_id != null
        ? { address: String(m.sender_id), firstName: m.sender_name ?? "" }
        : null,
    attachments,
    associatedMessageGuid: "",
    associatedMessageType: "",
    chatGUID: tgChatGuid(m.account_id, m.chat_id),
    pending: m.send_state === "pending",
    failed: m.send_state === "failed",
    tgReactions,
  };
}
