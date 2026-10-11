// Map IRC wire types onto the app's Chat/Message shapes.
//
// GUIDs are namespaced per network the way Slack namespaces per workspace:
// irc:<network>:<buffer> for chats, plus the message id for messages. Buffer
// ids are casefolded channel names or nicks, which can't contain a colon.

import type { Chat, Message } from "@/types";
import type { IrcBuffer, IrcMessage } from "./types";

export function ircChatGuid(networkId: string, bufferId: string): string {
  return `irc:${networkId}:${bufferId}`;
}

export function ircMessageGuid(networkId: string, bufferId: string, id: string): string {
  // Server msgids are opaque and may contain colons; keep the GUID splittable.
  return `irc:${networkId}:${bufferId}:${id.replace(/:/g, "_")}`;
}

export function parseIrcChatGuid(guid: string): { networkId: string; bufferId: string } {
  const [, networkId = "", bufferId = ""] = guid.split(":");
  return { networkId, bufferId };
}

/**
 * Channels count as muted for good. On a busy network every channel line
 * would otherwise land in "Waiting on you"; muted, they still show unread
 * but only queries and mentions of our nick ask for attention (and notify).
 */
export const IRC_CHANNEL_MUTE = Number.MAX_SAFE_INTEGER;

export function ircBufferToChat(networkId: string, buffer: IrcBuffer): Chat {
  return {
    guid: ircChatGuid(networkId, buffer.id),
    displayName: buffer.name,
    chatIdentifier: buffer.name,
    participants: [],
    lastMessage: null,
    unreadCount: 0,
    lastMessageText: buffer.last_text ?? "",
    activityAt: buffer.last_ts ?? 0,
    ...(buffer.kind === "Channel" ? { mutedUntil: IRC_CHANNEL_MUTE } : {}),
  };
}

/** How a message reads in a bubble: actions as "* nick waves", notices as "-nick- text". */
export function ircDisplayText(m: IrcMessage): string {
  switch (m.kind) {
    case "Action":
      return `* ${m.from} ${m.text}`;
    case "Notice":
      return `-${m.from}- ${m.text}`;
    default:
      return m.text;
  }
}

export function ircMessageToMessage(networkId: string, bufferId: string, m: IrcMessage): Message {
  return {
    guid: ircMessageGuid(networkId, bufferId, m.id),
    text: ircDisplayText(m),
    isFromMe: m.is_self,
    dateCreated: m.ts,
    handle: m.is_self ? null : { address: m.from, firstName: m.from },
    attachments: [],
    associatedMessageGuid: "",
    associatedMessageType: "",
    chatGUID: ircChatGuid(networkId, bufferId),
  };
}

/**
 * Text for the AI auto-reply path, which must never be read as a command: a
 * model answering "/shrug" would otherwise send an unknown /command.
 */
export function ircEscapeCommands(text: string): string {
  return text
    .split("\n")
    .map((line) => (line.startsWith("/") ? `/${line}` : line))
    .join("\n");
}
