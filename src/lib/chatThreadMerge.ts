// Merge per-service 1-on-1 threads into one conversation.
//
// macOS 26 hosts already store a single merged "any;-;<address>" thread per
// contact in chat.db, but older hosts (≤ macOS 15) keep separate
// "iMessage;-;<address>" and "SMS;-;<address>" threads for the same person.
// BlueBubbles serves chat.db verbatim, so on old hosts the raw list shows the
// same contact twice, each thread holding only part of the history. Apple's
// Messages app merges them at display time — this module does the same.
//
// Cost: a few small module-level Maps rebuilt on each chat-list load, and one
// extra limit-1 (or history) request per *merged pair* when previewing/opening.
// On macOS 26 servers no pairs exist and everything here is a no-op.

import type { Chat } from "@/types";

const DM_GUID_RE = /^(iMessage|SMS|RCS);-;(.+)$/;

// alias guid -> canonical guid (e.g. "SMS;-;+46…" -> "iMessage;-;+46…")
let aliasToCanonical = new Map<string, string>();
// canonical guid -> every underlying thread guid (canonical first)
let variantsByCanonical = new Map<string, string[]>();
// canonical guid -> the variant whose thread saw the latest traffic; sends go
// there so we answer on the service the contact is actually using.
const preferredSendByCanonical = new Map<string, string>();

/** Map any thread guid to the merged conversation's guid. */
export function canonicalChatGuid(guid: string): string {
  return aliasToCanonical.get(guid) ?? guid;
}

/** All underlying thread guids for a conversation (just [guid] if unmerged). */
export function chatGuidVariants(guid: string): string[] {
  return variantsByCanonical.get(guid) ?? [guid];
}

/** The thread to send on for a conversation (falls back to the guid itself). */
export function preferredSendGuid(guid: string): string {
  return preferredSendByCanonical.get(canonicalChatGuid(guid)) ?? guid;
}

/** Record which variant last saw traffic, so replies use the same service. */
export function notePreferredSendGuid(variantGuid: string): void {
  const canonical = canonicalChatGuid(variantGuid);
  if (canonical !== variantGuid || variantsByCanonical.has(canonical)) {
    preferredSendByCanonical.set(canonical, variantGuid);
  }
}

/**
 * Collapse per-service DM threads for the same address into one Chat. The
 * iMessage thread is kept as the canonical entry (stable guid; most likely to
 * accept sends), unread counts are summed, and the alias maps are rebuilt.
 * Group chats and unmatched guids pass through untouched.
 */
export function mergeChatThreads(chats: Chat[]): Chat[] {
  const byAddress = new Map<string, Chat[]>();
  for (const chat of chats) {
    const m = DM_GUID_RE.exec(chat.guid);
    if (!m) continue;
    const list = byAddress.get(m[2]);
    if (list) list.push(chat);
    else byAddress.set(m[2], [chat]);
  }

  const alias = new Map<string, string>();
  const variants = new Map<string, string[]>();
  const drop = new Set<string>();
  const extraUnread = new Map<string, number>();

  for (const group of byAddress.values()) {
    if (group.length < 2) continue;
    const canonical =
      group.find((c) => c.guid.startsWith("iMessage;")) ?? group[0];
    const guids = [
      canonical.guid,
      ...group.filter((c) => c !== canonical).map((c) => c.guid),
    ];
    variants.set(canonical.guid, guids);
    let unread = 0;
    for (const c of group) {
      if (c !== canonical) {
        alias.set(c.guid, canonical.guid);
        drop.add(c.guid);
        unread += c.unreadCount ?? 0;
      }
    }
    if (unread > 0) extraUnread.set(canonical.guid, unread);
  }

  aliasToCanonical = alias;
  variantsByCanonical = variants;
  // Keep existing send preferences only for conversations that still exist.
  for (const key of preferredSendByCanonical.keys()) {
    if (!variants.has(key)) preferredSendByCanonical.delete(key);
  }

  if (drop.size === 0) return chats;
  return chats
    .filter((c) => !drop.has(c.guid))
    .map((c) => {
      const extra = extraUnread.get(c.guid);
      return extra ? { ...c, unreadCount: (c.unreadCount ?? 0) + extra } : c;
    });
}
