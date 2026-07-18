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
