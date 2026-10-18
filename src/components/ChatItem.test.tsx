// @vitest-environment jsdom
import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { formatMessageTime, type Chat } from "@/types";
import { modLabel } from "@/lib/shortcuts";
import { useAppStore } from "@/store/useAppStore";
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
    expect(getByText(modLabel(2))).toBeTruthy();
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

describe("ChatItem rows and cards", () => {
  const at = Date.now() - 60_000;

  it("row shows the last message and its time", () => {
    // A typing indicator would stand in for the preview.
    useAppStore.setState({ typingChats: {} });
    const { getByText } = render(
      <ChatItem
        chat={chat({ lastMessageText: "see you at *noon*", activityAt: at })}
        isSelected={false}
        onSelect={() => {}}
      />
    );
    // Slack marks are stripped from the preview.
    expect(getByText("see you at noon")).toBeTruthy();
    expect(getByText(`slack · ${formatMessageTime(at)}`)).toBeTruthy();
  });

  it("opens on Enter, in a new pane on Alt+Enter, and is a Tab stop when told", () => {
    const onSelect = vi.fn();
    const { getByText } = render(
      <ChatItem chat={chat()} isSelected={false} onSelect={onSelect} tabStop />
    );
    const row = getByText("#daily").closest<HTMLElement>("[data-chat-guid]")!;
    expect(row.tabIndex).toBe(0);
    fireEvent.keyDown(row, { key: "Enter" });
    expect(onSelect).toHaveBeenLastCalledWith("sl:work:C1", { newPane: false });
    fireEvent.keyDown(row, { key: "Enter", altKey: true });
    expect(onSelect).toHaveBeenLastCalledWith("sl:work:C1", { newPane: true });
  });

  it("queue card spells out its keys only under the keyboard cursor", () => {
    const props = { chat: chat({ unreadCount: 1 }), variant: "card" as const, isSelected: false, onSelect: () => {}, onDone: () => {} };
    const { queryByText, rerender } = render(<ChatItem {...props} />);
    expect(queryByText("E done")).toBeNull();
    rerender(<ChatItem {...props} isCursor />);
    expect(queryByText("E done")).toBeTruthy();
  });
});
