// @vitest-environment jsdom
import { render } from "@testing-library/react";
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
    const { getByText } = render(<ChatList />);
    expect(getByText("Waiting on you")).toBeTruthy();
    expect(getByText("1 new")).toBeTruthy();
    expect(getByText("Starred")).toBeTruthy();
    expect(getByText("Recent")).toBeTruthy();
    // The queue card carries the keyboard hints.
    expect(getByText("E done")).toBeTruthy();
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
