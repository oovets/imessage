import { describe, expect, it } from "vitest";
import {
  MAX_CACHED_CHATS,
  collectOpenChatGuids,
  evictMessageCache,
  touchOrder,
  type MessageCacheState,
} from "./messageCache";
import type { PaneNode } from "./useAppStore";
import type { Message } from "@/types";

function msg(guid: string, chatGUID: string): Message {
  return {
    guid,
    text: guid,
    isFromMe: false,
    dateCreated: 1,
    handle: null,
    attachments: [],
    associatedMessageGuid: "",
    associatedMessageType: "",
    chatGUID,
  };
}

function cacheOf(guids: string[]): MessageCacheState {
  const messages: Record<string, Message[]> = {};
  const messageFetchedAt: Record<string, number> = {};
  for (const g of guids) {
    messages[g] = [msg(`m-${g}`, g)];
    messageFetchedAt[g] = 1;
  }
  return { messages, messageFetchedAt, messageOrder: [...guids] };
}

describe("touchOrder", () => {
  it("moves an existing guid to the end", () => {
    expect(touchOrder(["a", "b", "c"], "a")).toEqual(["b", "c", "a"]);
  });
  it("appends a new guid", () => {
    expect(touchOrder(["a", "b"], "c")).toEqual(["a", "b", "c"]);
  });
  it("does not duplicate", () => {
    expect(touchOrder(["a", "b", "a"], "a")).toEqual(["b", "a"]);
  });
});

describe("collectOpenChatGuids", () => {
  it("collects guids from every leaf, ignoring empty leaves", () => {
    const tree: PaneNode = {
      type: "split",
      id: "s1",
      direction: "horizontal",
      children: [
        { type: "leaf", id: "l1", chatGUID: "a" },
        {
          type: "split",
          id: "s2",
          direction: "vertical",
          children: [
            { type: "leaf", id: "l2", chatGUID: "b" },
            { type: "leaf", id: "l3", chatGUID: null },
          ],
        },
      ],
    };
    expect(collectOpenChatGuids(tree)).toEqual(new Set(["a", "b"]));
  });
});

describe("evictMessageCache", () => {
  it("keeps the map untouched when under the cap", () => {
    const state = cacheOf(["a", "b", "c"]);
    const result = evictMessageCache(state, new Set(), 5);
    expect(Object.keys(result.messages).sort()).toEqual(["a", "b", "c"]);
  });

  it("evicts least-recently-used conversations beyond the cap", () => {
    const state = cacheOf(["a", "b", "c", "d"]); // order: a oldest, d newest
    const result = evictMessageCache(state, new Set(), 2);
    expect(Object.keys(result.messages).sort()).toEqual(["c", "d"]);
    expect(result.messageOrder).toEqual(["c", "d"]);
  });

  it("never evicts protected (open) conversations", () => {
    const state = cacheOf(["a", "b", "c", "d"]);
    // Protect the two oldest; only the next-oldest evictable ones may go.
    const result = evictMessageCache(state, new Set(["a", "b"]), 2);
    expect(Object.keys(result.messages).sort()).toEqual(["a", "b"]);
  });

  it("prunes messageFetchedAt in lockstep with the message map", () => {
    const state = cacheOf(["a", "b", "c"]);
    const result = evictMessageCache(state, new Set(), 1);
    expect(Object.keys(result.messageFetchedAt)).toEqual(Object.keys(result.messages));
  });

  it("retains more than the cap when all remaining chats are protected", () => {
    const state = cacheOf(["a", "b", "c"]);
    const result = evictMessageCache(state, new Set(["a", "b", "c"]), 1);
    expect(Object.keys(result.messages).sort()).toEqual(["a", "b", "c"]);
  });

  it("reconciles a stale order list against the actual keys", () => {
    const state: MessageCacheState = {
      messages: { a: [msg("m", "a")], b: [msg("m", "b")] },
      messageFetchedAt: { a: 1, b: 1 },
      messageOrder: ["ghost", "a"], // 'ghost' gone, 'b' missing from order
    };
    const result = evictMessageCache(state, new Set(), 10);
    expect(result.messageOrder).toEqual(["a", "b"]);
  });

  it("has a sane default cap", () => {
    expect(MAX_CACHED_CHATS).toBeGreaterThan(0);
  });
});
