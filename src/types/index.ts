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
  // Unified inbox: Telegram's own emoji reaction chips (already aggregated),
  // shown instead of the iMessage tapback aggregation for tg messages.
  tgReactions?: string[];
}

export interface Chat {
  guid: string;
  displayName: string;
  chatIdentifier: string;
  participants: Handle[];
  lastMessage: Message | null;
  unreadCount: number;
  lastMessageText?: string;
  // Single source of truth for chat-list ordering (ms epoch). Both iMessage
  // (via enrichChatActivity) and Telegram (via the adapter) set this, since
  // lastMessage.dateCreated isn't reliably populated on the iMessage side.
  activityAt?: number;
  /** Ready-to-load avatar URL, when the source hands one over (Slack DMs). */
  avatarUrl?: string;
  /** Slack's conversation grouping ("Public" | "DirectMessage" | …), used by
   *  the per-workspace sort. Absent on other sources. */
  slackSection?: string;
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

// Every toLocale*String call builds a fresh ICU formatter (~100 µs in
// JavaScriptCore), and a conversation formats a date or two per
// bubble on every render. So each style below is built once as the exact
// Intl.DateTimeFormat its toLocale*String counterpart constructs internally,
// and reused: output is byte-identical.
const DATE_STYLES = {
  /** toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) */
  time: { hour: "2-digit", minute: "2-digit" },
  /** toLocaleDateString([], { weekday: "short" }) */
  weekdayShort: { weekday: "short" },
  /** toLocaleDateString([], { weekday: "long" }) */
  weekdayLong: { weekday: "long" },
  /** toLocaleDateString([], { month: "short", day: "numeric" }) */
  monthDay: { month: "short", day: "numeric" },
  /** toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" }) */
  monthDayYear: { month: "short", day: "numeric", year: "numeric" },
  /** toLocaleString(): with no options it defaults every numeric field. */
  full: {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  },
} satisfies Record<string, Intl.DateTimeFormatOptions>;

export type DateStyle = keyof typeof DATE_STYLES;

// A formatter pins the locale and time zone it was built with, where
// toLocale*String reads them on every call. Re-resolve them at most once a
// second and drop the cache when either moved, so a time-zone change while the
// app runs (a laptop crossing zones) still shows up as it did before.
const FORMATTER_RECHECK_MS = 1000;
let formatters: Partial<Record<DateStyle, Intl.DateTimeFormat>> = {};
let formattersEnv = "";
let formattersCheckedAt = Number.NEGATIVE_INFINITY;

function formatterFor(style: DateStyle): Intl.DateTimeFormat {
  const now = Date.now();
  if (Math.abs(now - formattersCheckedAt) >= FORMATTER_RECHECK_MS) {
    formattersCheckedAt = now;
    const { locale, timeZone } = new Intl.DateTimeFormat().resolvedOptions();
    const env = `${locale}|${timeZone}`;
    if (env !== formattersEnv) {
      formattersEnv = env;
      formatters = {};
    }
  }
  return (formatters[style] ??= new Intl.DateTimeFormat(undefined, DATE_STYLES[style]));
}

/**
 * `date` rendered exactly as the toLocale*String call `style` stands for —
 * including "Invalid Date" for an invalid one, where Intl's format() throws.
 */
export function formatDate(date: Date | number, style: DateStyle): string {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return "Invalid Date";
  return formatterFor(style).format(d);
}

export function formatMessageTime(dateCreated: number): string {
  const date = new Date(dateCreated);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) {
    return formatDate(date, "time");
  }
  if (diffDays < 7) {
    return formatDate(date, "weekdayShort");
  }
  return formatDate(date, "monthDay");
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The first instant after `now` at which formatMessageTime(dateCreated) can
 * read differently: the timestamp itself (one from a server clock ahead of
 * ours reads as a weekday until then), 24 h on (time → weekday) and 7 days on
 * (weekday → date).
 */
export function nextMessageTimeChange(dateCreated: number, now: number): number {
  const t = new Date(dateCreated).getTime();
  for (const days of [0, 1, 7]) {
    const at = t + days * DAY_MS;
    if (at > now) return at;
  }
  return Infinity;
}

/** The next local midnight after `now`, when day labels ("Today", "Yesterday") roll over. */
export function nextLocalMidnight(now: number): number {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
}

/**
 * Calls `onDue` once the clock reaches `due` (never for Infinity) and returns a
 * cancel function. It waits at most a minute at a time, so a timer stretched
 * by system sleep still fires soon after wake.
 */
export function whenDue(due: number, onDue: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const wait = () => {
    const left = due - Date.now();
    if (left <= 0) onDue();
    else timer = setTimeout(wait, Math.min(left, 60_000));
  };
  if (Number.isFinite(due)) wait();
  return () => clearTimeout(timer);
}
