/**
 * Sidebar triage: the command-bar filter and the three sidebar sections
 * (Waiting on you → Starred → Recent). Shared by the sidebar and the command
 * bar so Enter in the bar jumps to exactly what the sidebar shows first.
 */

import { sourceOfGuid, type ChatSource } from "@/lib/source";
import { decodeEscapedUnicode, getChatDisplayName, type Chat } from "@/types";

/** Short mono tag shown on rows and cards. */
export const SOURCE_TAG: Record<ChatSource, string> = {
  imessage: "imsg",
  telegram: "tg",
  slack: "slack",
};

export function sourceTag(guid: string): string {
  return SOURCE_TAG[sourceOfGuid(guid)];
}

// "tg: anna" / "slack:" / "imsg: …" narrow to one source — the per-account
// groups are gone from the sidebar, so this is how you filter by source now.
const PREFIXES: Record<string, ChatSource> = {
  "imsg:": "imessage",
  "imessage:": "imessage",
  "tg:": "telegram",
  "telegram:": "telegram",
  "slack:": "slack",
  "sl:": "slack",
};

export function filterChats(chats: Chat[], query: string): Chat[] {
  let q = query.trim().toLowerCase();
  if (!q) return chats;
  let source: ChatSource | null = null;
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

export interface TriageSections {
  /** Unread, recency order. */
  waiting: Chat[];
  /** Starred and read. */
  starred: Chat[];
  /** Everything else, recency order, all sources mixed. */
  recent: Chat[];
}

/** Split an already-filtered, recency-sorted list into the sidebar sections. */
export function triage(chats: Chat[], starredGuids: string[]): TriageSections {
  const starredSet = new Set(starredGuids);
  const waiting: Chat[] = [];
  const starred: Chat[] = [];
  const recent: Chat[] = [];
  for (const c of chats) {
    if ((c.unreadCount ?? 0) > 0) waiting.push(c);
    else if (starredSet.has(c.guid)) starred.push(c);
    else recent.push(c);
  }
  return { waiting, starred, recent };
}

/** Drag payload type for sidebar rows/cards dropped onto panes. */
export const CHAT_DRAG_MIME = "application/x-messages-chat";
