export interface Handle {
  address: string;
  firstName: string;
}

export interface Attachment {
  guid: string;
  mimeType: string;
  transferName: string;
  url: string;
}

export interface Message {
  guid: string;
  text: string;
  isFromMe: boolean;
  dateCreated: number;
  handle: Handle | null;
  attachments: Attachment[];
  associatedMessageGuid: string;
  associatedMessageType: string;
  chatGUID?: string;
  pending?: boolean;
  failed?: boolean;
  failedReason?: string;
  tempGuid?: string;
}

export interface Chat {
  guid: string;
  displayName: string;
  chatIdentifier: string;
  participants: Handle[];
  lastMessage: Message | null;
  unreadCount: number;
  lastMessageText?: string;
}

export interface LinkPreview {
  url: string;
  siteName: string;
  title: string;
  description: string;
  image: string;
  favicon: string;
  status: "ready" | "failed";
  fetchedAt: number;
  error?: string;
}

export interface WSEvent {
  type: string;
  data: unknown;
}

export interface AppConfig {
  serverUrl: string;
  password: string;
}

const ESCAPED_UNICODE_SEQUENCE = /\\u[0-9a-fA-F]{4}/;
const ESCAPED_UNICODE = /\\u([0-9a-fA-F]{4})/g;

export function decodeEscapedUnicode(text: string | null | undefined): string {
  if (!text) return "";
  if (!ESCAPED_UNICODE_SEQUENCE.test(text)) return text;
  return text.replace(ESCAPED_UNICODE, (_, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16))
  );
}

export function getChatDisplayName(chat: Chat): string {
  if (chat.participants.length === 1 && chat.participants[0].firstName) {
    return chat.participants[0].firstName;
  }
  if (chat.participants.length > 1) {
    const names = chat.participants
      .map((p) => p.firstName || p.address)
      .filter(Boolean);
    if (names.length > 3) {
      return names.slice(0, 3).join(", ") + ` +${names.length - 3}`;
    }
    return names.join(", ");
  }
  if (chat.displayName) return chat.displayName;
  if (chat.chatIdentifier) return chat.chatIdentifier;
  if (chat.participants[0]?.address) return chat.participants[0].address;
  return "Unknown";
}

export function getChatInitials(chat: Chat): string {
  const name = getChatDisplayName(chat);
  return name
    .split(" ")
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
}

export function formatMessageTime(dateCreated: number): string {
  const date = new Date(dateCreated);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  if (diffDays < 7) {
    return date.toLocaleDateString([], { weekday: "short" });
  }
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}
