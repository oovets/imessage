// Map Slack wire types onto the app's Chat/Message shapes.
//
// GUIDs are namespaced per workspace the same way Telegram namespaces per
// account: sl:<workspace>:<channel> for chats, plus the message ts for
// messages. Slack timestamps are "1700000000.123456" — seconds with
// microseconds — so they convert to epoch millis rather than parse as dates.

import type { Chat, Message } from "@/types";
import { SlChatSection, type SlChat, type SlMessage } from "./types";

export function slChatGuid(workspaceId: string, channelId: string): string {
  return `sl:${workspaceId}:${channelId}`;
}

export function slMessageGuid(workspaceId: string, channelId: string, ts: string): string {
  return `sl:${workspaceId}:${channelId}:${ts}`;
}

export function parseSlChatGuid(guid: string): {
  workspaceId: string;
  channelId: string;
} {
  const [, workspaceId = "", channelId = ""] = guid.split(":");
  return { workspaceId, channelId };
}

/** Slack ts ("1700000000.123456") → epoch millis. */
export function slTsToMillis(ts: string): number {
  const seconds = Number.parseFloat(ts);
  return Number.isFinite(seconds) ? Math.round(seconds * 1000) : 0;
}

/** Channels get a leading #; DMs and groups keep their name as-is. */
export function slDisplayName(chat: SlChat): string {
  const isChannel =
    chat.section === SlChatSection.Public ||
    chat.section === SlChatSection.Private ||
    chat.section === SlChatSection.Shared;
  return isChannel ? `#${chat.name}` : chat.name;
}

export function slChatToChat(workspaceId: string, chat: SlChat): Chat {
  return {
    guid: slChatGuid(workspaceId, chat.id),
    displayName: slDisplayName(chat),
    chatIdentifier: chat.id,
    participants: [],
    lastMessage: null,
    unreadCount: chat.unread ?? 0,
    lastMessageText: "",
    // Real activity arrives with the first history load / realtime event; until
    // then a chat with no timestamp sorts last rather than jumping to the top.
    activityAt: 0,
  } as Chat;
}

export function slMessageToMessage(
  workspaceId: string,
  channelId: string,
  m: SlMessage,
  selfUserId: string | null
): Message {
  // Slack file URLs need the workspace token to fetch, which the webview
  // doesn't hold — so they render as named cards rather than inline media
  // until a host-side fetch exists.
  const attachments = (m.files ?? []).map((f) => ({
    guid: f.id,
    transferName: f.name,
    mimeType: f.mimetype ?? "",
    url: "",
  }));
  return {
    guid: slMessageGuid(workspaceId, channelId, m.ts),
    text: m.text ?? "",
    isFromMe: !!selfUserId && m.user === selfUserId,
    dateCreated: slTsToMillis(m.ts),
    handle: m.user
      ? { address: m.user, firstName: m.username ?? "" }
      : m.username
        ? { address: m.username, firstName: m.username }
        : null,
    attachments,
    associatedMessageGuid: "",
    associatedMessageType: "",
    chatGUID: slChatGuid(workspaceId, channelId),
  } as Message;
}
