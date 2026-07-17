import type { Message } from "@/types";
import type { PaneNode } from "./useAppStore";

// Maximum number of *conversations* whose message arrays are retained in
// memory (and persisted to localStorage). Each conversation is already capped
// at MAX_CACHED_MESSAGES entries by the store, so the hard ceiling on cached
// message objects is MAX_CACHED_CHATS * MAX_CACHED_MESSAGES. Without this bound
// the `messages` map grows once per distinct conversation ever opened or
// touched by a background WebSocket event, and never shrinks — unbounded growth
// over the lifetime of the app.
export const MAX_CACHED_CHATS = 30;

/** Collect every chatGUID currently displayed in a pane leaf. */
export function collectOpenChatGuids(node: PaneNode): Set<string> {
  const out = new Set<string>();
  const stack: PaneNode[] = [node];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (n.type === "leaf") {
      if (n.chatGUID) out.add(n.chatGUID);
    } else {
      stack.push(n.children[0], n.children[1]);
    }
  }
  return out;
}

/**
 * Drop stale entries (guids no longer present in the map) and append any live
 * guid missing from the order list, so `order` always mirrors the map's keys
 * exactly, most-recently-used last.
 */
function reconcileOrder(order: string[], guids: string[]): string[] {
  const live = new Set(guids);
  const seen = new Set<string>();
  const next: string[] = [];
  for (const g of order) {
    if (live.has(g) && !seen.has(g)) {
      next.push(g);
      seen.add(g);
    }
  }
  for (const g of guids) {
    if (!seen.has(g)) next.push(g);
  }
  return next;
}

/** Move `guid` to the most-recently-used position (end of the list). */
export function touchOrder(order: string[], guid: string): string[] {
  const next = order.filter((g) => g !== guid);
  next.push(guid);
  return next;
}

export interface MessageCacheState {
  messages: Record<string, Message[]>;
  messageFetchedAt: Record<string, number>;
  messageOrder: string[];
}

/**
 * Evict least-recently-used conversations so at most `max` remain cached.
 * Conversations in `keep` are never evicted — they are open in a pane and
 * evicting them would blank the visible message list. `messageFetchedAt` is
 * pruned in lockstep so it cannot outgrow the message map.
 */
export function evictMessageCache(
  state: MessageCacheState,
  keep: Set<string>,
  max = MAX_CACHED_CHATS
): MessageCacheState {
  const guids = Object.keys(state.messages);
  const order = reconcileOrder(state.messageOrder, guids);
  if (guids.length <= max) {
    return { messages: state.messages, messageFetchedAt: state.messageFetchedAt, messageOrder: order };
  }

  const removeCount = guids.length - max;
  const evictable = order.filter((g) => !keep.has(g));
  const toRemove = new Set(evictable.slice(0, removeCount));
  if (toRemove.size === 0) {
    return { messages: state.messages, messageFetchedAt: state.messageFetchedAt, messageOrder: order };
  }

  const messages: Record<string, Message[]> = {};
  const messageFetchedAt: Record<string, number> = {};
  for (const g of guids) {
    if (toRemove.has(g)) continue;
    messages[g] = state.messages[g];
    if (g in state.messageFetchedAt) messageFetchedAt[g] = state.messageFetchedAt[g];
  }
  const messageOrder = order.filter((g) => !toRemove.has(g));
  return { messages, messageFetchedAt, messageOrder };
}
