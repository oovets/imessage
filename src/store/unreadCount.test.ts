// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import type { Chat } from "@/types";
import { useAppStore } from "./useAppStore";

function chat(guid: string, extra: Partial<Chat> = {}): Chat {
  return {
    guid,
    displayName: "Test",
    chatIdentifier: guid,
    participants: [],
    lastMessage: null,
    unreadCount: 0,
    ...extra,
  };
}

beforeEach(() => {
  useAppStore.setState({ chats: [] });
});

describe("markChatHasNewMessage", () => {
  it("increments a normal counter", () => {
    useAppStore.setState({ chats: [chat("iMessage;-;+1", { unreadCount: 2 })] });
    useAppStore.getState().markChatHasNewMessage("iMessage;-;+1");
    expect(useAppStore.getState().chats[0].unreadCount).toBe(3);
  });

  it("does not produce NaN when the server omitted unreadCount", () => {
    // Regression: Chat is cast from untrusted JSON, so the field can be absent.
    // `undefined + 1` is NaN, and NaN is sticky — the reset path only fires on
    // `unreadCount > 0`, and `NaN > 0` is false, so the badge never clears.
    useAppStore.setState({
      chats: [chat("iMessage;-;+1", { unreadCount: undefined as unknown as number })],
    });
    useAppStore.getState().markChatHasNewMessage("iMessage;-;+1");

    const count = useAppStore.getState().chats[0].unreadCount;
    expect(Number.isNaN(count)).toBe(false);
    expect(count).toBe(1);
  });

  it("recovers a counter that is already NaN", () => {
    useAppStore.setState({ chats: [chat("iMessage;-;+1", { unreadCount: NaN })] });
    useAppStore.getState().markChatHasNewMessage("iMessage;-;+1");
    expect(useAppStore.getState().chats[0].unreadCount).toBe(1);
  });
});

describe("markChatViewed", () => {
  it("zeroes the unread count for the viewed chat only", () => {
    useAppStore.setState({
      chats: [chat("a", { unreadCount: 3 }), chat("b", { unreadCount: 2 })],
    });
    useAppStore.getState().markChatViewed("a");
    const chats = useAppStore.getState().chats;
    expect(chats.find((c) => c.guid === "a")?.unreadCount).toBe(0);
    expect(chats.find((c) => c.guid === "b")?.unreadCount).toBe(2);
  });

  it("is a no-op when the chat is already read (no store churn)", () => {
    useAppStore.setState({ chats: [chat("a", { unreadCount: 0 })] });
    const before = useAppStore.getState().chats;
    useAppStore.getState().markChatViewed("a");
    expect(useAppStore.getState().chats).toBe(before);
  });
});
