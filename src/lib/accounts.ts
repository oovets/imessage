/**
 * Which *account* a chat belongs to — one level finer than its source.
 *
 * A source answers "which backend?"; an account answers "which of my logins on
 * that backend?". With two Slack workspaces and several Telegram accounts, a
 * few hundred conversations arrive in one flat list and the only way to tell
 * them apart is the GUID: `tg:<accountId>:<chatId>`, `sl:<workspace>:<channel>`,
 * and bare identifiers for iMessage.
 *
 * Like {@link sourceOfGuid}, this is *derived* rather than stored, so a chat's
 * account can never drift out of sync with the chat itself.
 */

import { sourceOfGuid, type ChatSource } from "@/lib/source";
import type { Chat } from "@/types";

export interface AccountRef {
  source: ChatSource;
  /** Backend-local account id: Telegram account id, Slack workspace id, "" for iMessage. */
  id: string;
  /** Stable key for lookups and persisted collapse state. */
  key: string;
}

/** iMessage has exactly one account, so its key needs no id. */
export const IMESSAGE_ACCOUNT_KEY = "imessage";

export function accountKey(source: ChatSource, id: string): string {
  return source === "imessage" ? IMESSAGE_ACCOUNT_KEY : `${source}:${id}`;
}

export function accountOfGuid(guid: string): AccountRef {
  const source = sourceOfGuid(guid);
  if (source === "imessage") {
    return { source, id: "", key: IMESSAGE_ACCOUNT_KEY };
  }
  // Both prefixed forms put the account in the second colon-separated field.
  const id = guid.split(":")[1] ?? "";
  return { source, id, key: accountKey(source, id) };
}

/** Fallback shown before a backend reports its account names. */
export function fallbackAccountLabel(ref: AccountRef): string {
  switch (ref.source) {
    case "imessage":
      return "iMessage";
    case "telegram":
      return `Telegram ${ref.id}`;
    case "slack":
      return ref.id;
  }
}

/**
 * Group ordering: iMessage first, then Telegram, then Slack, alphabetically
 * within each source. Stable across reloads regardless of which backend
 * happened to answer first.
 */
const SOURCE_ORDER: Record<ChatSource, number> = {
  imessage: 0,
  telegram: 1,
  slack: 2,
};

export function compareAccounts(
  a: { ref: AccountRef; label: string },
  b: { ref: AccountRef; label: string }
): number {
  const bySource = SOURCE_ORDER[a.ref.source] - SOURCE_ORDER[b.ref.source];
  return bySource !== 0 ? bySource : a.label.localeCompare(b.label);
}

export interface AccountGroup {
  ref: AccountRef;
  label: string;
  chats: Chat[];
  /** Unread across the group — the only signal left once it is collapsed. */
  unread: number;
}

/**
 * Split a chat list into per-account groups, preserving the incoming order
 * (recency) within each group.
 */
export function groupChatsByAccount(
  chats: Chat[],
  labels: Record<string, string>
): AccountGroup[] {
  const groups = new Map<string, AccountGroup>();
  for (const chat of chats) {
    const ref = accountOfGuid(chat.guid);
    let group = groups.get(ref.key);
    if (!group) {
      group = {
        ref,
        label: labels[ref.key] ?? fallbackAccountLabel(ref),
        chats: [],
        unread: 0,
      };
      groups.set(ref.key, group);
    }
    group.chats.push(chat);
    group.unread += chat.unreadCount ?? 0;
  }
  return [...groups.values()].sort(compareAccounts);
}
