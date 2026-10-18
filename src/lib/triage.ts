/**
 * Sidebar triage: the command-bar filter and the three sidebar sections
 * (Waiting on you → Starred → Recent). Shared by the sidebar and the command
 * bar so Enter in the bar jumps to exactly what the sidebar shows first.
 */

import { SOURCES_IN_ORDER, networkGroups } from "@/lib/accounts";
import { sourceOfGuid, type ChatSource } from "@/lib/source";
import { decodeEscapedUnicode, getChatDisplayName, type Chat } from "@/types";

/** Short mono tag shown on rows and cards. */
export const SOURCE_TAG: Record<ChatSource, string> = {
  imessage: "imsg",
  telegram: "tg",
  slack: "slack",
  irc: "irc",
};

export function sourceTag(guid: string): string {
  return SOURCE_TAG[sourceOfGuid(guid)];
}

/** A source's name, as the sidebar's network filter spells it. */
export const SOURCE_NAME: Record<ChatSource, string> = {
  imessage: "iMessage",
  telegram: "Telegram",
  slack: "Slack",
  irc: "IRC",
};

/** How the sidebar orders Recent: by recency, or in per-network groups. */
export type ChatListGrouping = "time" | "network";

// "tg: anna" / "slack:" / "imsg: …" narrow the search to one source, over
// the sidebar's network filter if one is set.
const PREFIXES: Record<string, ChatSource> = {
  "imsg:": "imessage",
  "imessage:": "imessage",
  "tg:": "telegram",
  "telegram:": "telegram",
  "slack:": "slack",
  "sl:": "slack",
  "irc:": "irc",
};

/** `chats` matching `query`, and from `only` when a network filter is set. */
export function filterChats(chats: Chat[], query: string, only: ChatSource | null = null): Chat[] {
  let q = query.trim().toLowerCase();
  if (!q && !only) return chats;
  let source: ChatSource | null = only;
  for (const [prefix, src] of Object.entries(PREFIXES)) {
    if (q.startsWith(prefix)) {
      source = src;
      q = q.slice(prefix.length).trim();
      break;
    }
  }
  return chats.filter((c) => {
    if (source && sourceOfGuid(c.guid) !== source) return false;
    if (!q) return true;
    const name = getChatDisplayName(c).toLowerCase();
    const preview = decodeEscapedUnicode(c.lastMessageText ?? c.lastMessage?.text ?? "").toLowerCase();
    return name.includes(q) || preview.includes(q);
  });
}

export interface SourceSummary {
  source: ChatSource;
  /** Chats in "Waiting on you" (unread, not muted). */
  waiting: number;
}

/** The sources `chats` come from, in sidebar order, with what each has waiting. */
export function summarizeSources(chats: Chat[], now: number = Date.now()): SourceSummary[] {
  const waiting = new Map<ChatSource, number>();
  for (const c of chats) {
    const source = sourceOfGuid(c.guid);
    waiting.set(source, (waiting.get(source) ?? 0) + (isWaiting(c, now) ? 1 : 0));
  }
  return SOURCES_IN_ORDER.filter((s) => waiting.has(s)).map((source) => ({
    source,
    waiting: waiting.get(source)!,
  }));
}

/**
 * The network filter in effect: none while no chat comes from that source
 * (it was disconnected), so the sidebar never strands on an empty list with
 * its filter row gone.
 */
export function activeSourceFilter(chats: Chat[], filter: ChatSource | null): ChatSource | null {
  return filter && chats.some((c) => sourceOfGuid(c.guid) === filter) ? filter : null;
}

/** Recent in the order the sidebar lists it; folded network groups left out. */
export function listedRecent(
  recent: Chat[],
  grouping: ChatListGrouping,
  labels: Record<string, string>,
  collapsed: readonly string[]
): Chat[] {
  if (grouping === "time") return recent;
  return networkGroups(recent, labels, collapsed).flatMap((g) => (g.collapsed ? [] : g.chats));
}

export interface TriageSections {
  /** Unread and not muted, recency order. */
  waiting: Chat[];
  /** Starred, and read or muted. */
  starred: Chat[];
  /** Everything else, recency order, all sources mixed. */
  recent: Chat[];
}

/** Whether the chat is muted (in Telegram) at `now`. */
export function isMuted(chat: Chat, now: number = Date.now()): boolean {
  return chat.mutedUntil !== undefined && chat.mutedUntil > now;
}

/** Whether the chat belongs in "Waiting on you" at `now`. */
function isWaiting(chat: Chat, now: number): boolean {
  return (chat.unreadCount ?? 0) > 0 && !isMuted(chat, now);
}

/**
 * Split an already-filtered, recency-sorted list into the sidebar sections.
 * A muted chat is placed as if it were read (its unread count is kept), until
 * its mute lapses at `now`.
 */
export function triage(
  chats: Chat[],
  starredGuids: string[],
  now: number = Date.now()
): TriageSections {
  const starredSet = new Set(starredGuids);
  const waiting: Chat[] = [];
  const starred: Chat[] = [];
  const recent: Chat[] = [];
  for (const c of chats) {
    if (isWaiting(c, now)) waiting.push(c);
    else if (starredSet.has(c.guid)) starred.push(c);
    else recent.push(c);
  }
  return { waiting, starred, recent };
}

/**
 * The next instant after `now` at which triage(chats, …) can place a chat
 * differently on its own: the earliest lapsing mute of an unread chat, which
 * then joins the queue. Infinity when nothing is due.
 */
export function nextTriageChange(chats: Chat[], now: number): number {
  let due = Infinity;
  for (const c of chats) {
    const until = c.mutedUntil;
    // IRC channels are muted for good (Number.MAX_SAFE_INTEGER); that never
    // lapses, so it schedules nothing.
    if (until !== undefined && until > now && until < Number.MAX_SAFE_INTEGER && (c.unreadCount ?? 0) > 0) {
      due = Math.min(due, until);
    }
  }
  return due;
}

/** Drag payload type for sidebar rows/cards dropped onto panes. */
export const CHAT_DRAG_MIME = "application/x-messages-chat";
