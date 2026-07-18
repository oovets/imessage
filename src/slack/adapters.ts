// Map Slack wire types onto the app's Chat/Message shapes.
//
// GUIDs are namespaced per workspace the same way Telegram namespaces per
// account: sl:<workspace>:<channel> for chats, plus the message ts for
// messages. Slack timestamps are "1700000000.123456" — seconds with
// microseconds — so they convert to epoch millis rather than parse as dates.

import type { Attachment, Chat, Message } from "@/types";
import { slackTextToPlain } from "./mrkdwn";
import type { SlChat, SlChatSection, SlFile, SlMessage } from "./types";

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

const CHANNEL_SECTIONS: ReadonlySet<SlChatSection> = new Set<SlChatSection>([
  "Public",
  "Private",
  "Shared",
]);

/** Channels get a leading #; DMs and groups keep their name as-is. */
export function slDisplayName(chat: SlChat): string {
  return CHANNEL_SECTIONS.has(chat.section) ? `#${chat.name}` : chat.name;
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
    avatarUrl: chat.avatar_url ?? undefined,
    slackSection: chat.section,
  } as Chat;
}

/** Attachment guid that routes to <SlackMedia>, carrying what it needs to fetch. */
export function slFileGuid(workspaceId: string, fileKey: string): string {
  return `slfile:${workspaceId}:${fileKey}`;
}

export function parseSlFileGuid(guid: string): {
  workspaceId: string;
  fileKey: string;
} {
  const [, workspaceId = "", fileKey = ""] = guid.split(":");
  return { workspaceId, fileKey };
}

/** Stable, collision-resistant key from a url, for files Slack sends without an id. */
function hashKey(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i++) hash = (hash * 31 + value.charCodeAt(i)) | 0;
  return (hash >>> 0).toString(36);
}

/**
 * One Slack file -> one attachment, shared by the history adapter and the
 * realtime handler so a message looks identical either way.
 *
 * `id` and `name` are optional on the wire. Falling back to a hash of the url
 * matters more than it looks: the key becomes the cache filename, so a shared
 * constant would make two different images collide on disk and render as each
 * other. Files with no url can't be fetched at all, so they are dropped.
 */
export function slFileToAttachment(
  workspaceId: string,
  f: SlFile
): Attachment | null {
  if (!f.url_private) return null;
  return {
    guid: slFileGuid(workspaceId, f.id ?? hashKey(f.url_private)),
    transferName: f.name ?? "Attachment",
    mimeType: f.mimetype ?? "",
    url: f.url_private,
  } as Attachment;
}

export function slMessageToMessage(
  workspaceId: string,
  channelId: string,
  m: SlMessage,
  selfUserId: string | null,
  userNames: Record<string, string> = {}
): Message {
  // Slack file URLs need the workspace token, which the webview doesn't hold —
  // the url rides along on the attachment and SlackMedia fetches it host-side.
  const attachments = (m.files ?? [])
    .map((f) => slFileToAttachment(workspaceId, f))
    .filter((a): a is Attachment => a !== null);
  return {
    guid: slMessageGuid(workspaceId, channelId, m.ts),
    text: slackTextToPlain(m.text ?? "", userNames),
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
