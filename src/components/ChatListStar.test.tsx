// @vitest-environment jsdom
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Chat } from "@/types";
import { useAppStore } from "@/store/useAppStore";
import { ChatList } from "@/components/ChatList";

vi.mock("@/api/clientFactory", () => ({
  getClient: () => ({ getChats: vi.fn().mockResolvedValue([]), enrichChatActivity: vi.fn().mockResolvedValue([]) }),
}));
vi.mock("@/telegram/useTelegramAvatar", () => ({ useTelegramAvatar: () => null }));
vi.mock("@/lib/contactAvatars", () => ({ useContactAvatar: () => null }));

const chat = (guid: string, name: string): Chat =>
  ({ guid, displayName: name, chatIdentifier: guid, participants: [], lastMessage: null, unreadCount: 0, activityAt: 1 }) as Chat;

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (q: string) => ({ matches: false, media: q, addEventListener: () => {}, removeEventListener: () => {} }),
});

describe("star across sources", () => {
  it("renders a star on every row: imessage, telegram, slack", () => {
    useAppStore.setState({
      chats: [
        chat("iMessage;-;+4670", "Elin"),
        chat("tg:1:55", "Pontus"),
        chat("sl:work:C1", "#daily"),
      ],
      isConfigured: true,
      telegramAvailable: true,
      slackAvailable: true,
      loadingChats: false,
      accountLabels: {},
      collapsedAccounts: [],
      starredChats: [],
      sidebarHidden: false,
    });
    const { getAllByLabelText } = render(<ChatList />);
    const stars = getAllByLabelText("Star chat");
    // Three rows, three stars — if a source lost its star this fails.
    expect(stars.length).toBe(3);
  });
});

describe("triage sections", () => {
  it("puts unread chats in the queue, starred next, the rest in Recent", () => {
    useAppStore.setState({
      chats: [
        { ...chat("tg:1:55", "Pontus"), unreadCount: 2 },
        chat("iMessage;-;+4670", "Elin"),
        chat("sl:work:C1", "#daily"),
      ],
      isConfigured: true,
      loadingChats: false,
      starredChats: ["iMessage;-;+4670"],
      sidebarHidden: false,
      chatQuery: "",
    });
    const { getByText, getByLabelText } = render(<ChatList />);
    expect(getByText("Waiting on you")).toBeTruthy();
    expect(getByText("1 new")).toBeTruthy();
    expect(getByText("Starred")).toBeTruthy();
    expect(getByText("Recent")).toBeTruthy();
    // The queue card carries its "done".
    expect(getByLabelText("Mark done")).toBeTruthy();
  });

  it("filters by source prefix from the command bar", () => {
    useAppStore.setState({
      chats: [chat("tg:1:55", "Pontus"), chat("sl:work:C1", "#daily")],
      isConfigured: true,
      loadingChats: false,
      starredChats: [],
      sidebarHidden: false,
      chatQuery: "tg:",
    });
    const { queryByText } = render(<ChatList />);
    expect(queryByText("Pontus")).toBeTruthy();
    expect(queryByText("#daily")).toBeNull();
  });
});

describe("sidebar keyboard", () => {
  function setup() {
    useAppStore.setState({
      chats: [chat("iMessage;-;+4670", "Elin"), chat("sl:work:C1", "#daily")],
      isConfigured: true,
      loadingChats: false,
      starredChats: [],
      sidebarHidden: false,
      chatQuery: "",
      selectedChatGUID: null,
    });
    return render(<ChatList />);
  }
  const rowOf = (el: HTMLElement) => el.closest<HTMLElement>("[data-chat-guid]")!;

  it("is one Tab stop, and ↓ moves focus to the next row", async () => {
    const view = setup();
    const elin = rowOf(view.getByText("Elin"));
    const daily = rowOf(view.getByText("#daily"));
    expect(elin.tabIndex).toBe(0);
    expect(daily.tabIndex).toBe(-1);

    act(() => elin.focus());
    fireEvent.keyDown(elin, { key: "ArrowDown" });
    await waitFor(() => expect(document.activeElement).toBe(daily));
    expect(daily.tabIndex).toBe(0);
    expect(elin.tabIndex).toBe(-1);
  });

  it("opens the focused row with Enter and stars it with S", () => {
    const view = setup();
    const daily = rowOf(view.getByText("#daily"));
    act(() => daily.focus());

    fireEvent.keyDown(daily, { key: "s" });
    expect(useAppStore.getState().starredChats).toEqual(["sl:work:C1"]);

    fireEvent.keyDown(rowOf(view.getByText("#daily")), { key: "Enter" });
    expect(useAppStore.getState().selectedChatGUID).toBe("sl:work:C1");
  });
});
