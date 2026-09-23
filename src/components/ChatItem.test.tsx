// @vitest-environment jsdom
import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Chat } from "@/types";
import { ChatItem } from "./ChatItem";

vi.mock("@/telegram/useTelegramAvatar", () => ({ useTelegramAvatar: () => null }));
vi.mock("@/lib/contactAvatars", () => ({ useContactAvatar: () => null }));

const chat = (over: Partial<Chat> = {}): Chat =>
  ({
    guid: "sl:work:C1",
    displayName: "#daily",
    chatIdentifier: "C1",
    participants: [],
    lastMessage: null,
    unreadCount: 0,
    ...over,
  }) as Chat;

describe("ChatItem star", () => {
  it("renders the star affordance and toggles on click without selecting", () => {
    const onToggleStar = vi.fn();
    const onSelect = vi.fn();
    const { getByLabelText } = render(
      <ChatItem
        chat={chat()}
        isSelected={false}
        onSelect={onSelect}
        starred={false}
        onToggleStar={onToggleStar}
      />
    );
    fireEvent.click(getByLabelText("Star chat"));
    expect(onToggleStar).toHaveBeenCalledWith("sl:work:C1");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("shows a filled star when pinned", () => {
    const { getByLabelText } = render(
      <ChatItem
        chat={chat()}
        isSelected={false}
        onSelect={() => {}}
        starred
        onToggleStar={() => {}}
      />
    );
    expect(getByLabelText("Unstar chat").querySelector("svg")!.getAttribute("class")).toContain(
      "fill-current"
    );
  });
});

describe("ChatItem variants", () => {
  it("queue card: E done calls onDone without opening the chat", () => {
    const onDone = vi.fn();
    const onSelect = vi.fn();
    const { getByLabelText } = render(
      <ChatItem chat={chat({ unreadCount: 2 })} variant="card" isSelected={false} onSelect={onSelect} onDone={onDone} />
    );
    fireEvent.click(getByLabelText("Mark done"));
    expect(onDone).toHaveBeenCalledWith("sl:work:C1");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("alt-click opens in a new pane", () => {
    const onSelect = vi.fn();
    const { getByText } = render(<ChatItem chat={chat()} isSelected={false} onSelect={onSelect} />);
    fireEvent.click(getByText("#daily"), { altKey: true });
    expect(onSelect).toHaveBeenCalledWith("sl:work:C1", { newPane: true });
  });

  it("row shows the source tag and the pane key chip", () => {
    const { getByText } = render(
      <ChatItem chat={chat()} isSelected={false} onSelect={() => {}} paneKey={2} />
    );
    expect(getByText("slack")).toBeTruthy();
    expect(getByText("⌘2")).toBeTruthy();
  });
});

describe("ChatItem typing on queue cards", () => {
  it("clears 'typing…' at expiry without any other store write", async () => {
    vi.useFakeTimers();
    try {
      const { useAppStore } = await import("@/store/useAppStore");
      const { act } = await import("@testing-library/react");
      useAppStore.setState({ typingChats: { "sl:work:C1": Date.now() + 1000 } });
      const { queryByText } = render(
        <ChatItem chat={chat({ unreadCount: 1, lastMessageText: "hej" })} variant="card" isSelected={false} onSelect={() => {}} />
      );
      expect(queryByText("typing…")).toBeTruthy();
      act(() => {
        vi.advanceTimersByTime(1100);
      });
      expect(queryByText("typing…")).toBeNull();
      expect(queryByText("hej")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});
