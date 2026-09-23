// @vitest-environment jsdom
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Chat } from "@/types";
import { useAppStore } from "@/store/useAppStore";
import { ChatList } from "@/components/ChatList";

vi.mock("@/api/clientFactory", () => ({
  getClient: () => ({ getChats: vi.fn().mockResolvedValue([]), enrichChatActivity: vi.fn().mockResolvedValue([]) }),
}));
vi.mock("@/telegram/useTelegramAvatar", () => ({ useTelegramAvatar: () => null }));
vi.mock("@/lib/contactAvatars", () => ({ useContactAvatar: () => null }));

const NOW = Date.UTC(2026, 8, 23, 12, 0);
const MUTE_MS = 5 * 60_000;

const chat = (guid: string, name: string, extra: Partial<Chat> = {}): Chat =>
  ({
    guid,
    displayName: name,
    chatIdentifier: guid,
    participants: [],
    lastMessage: null,
    unreadCount: 0,
    activityAt: 1,
    ...extra,
  }) as Chat;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  useAppStore.setState({
    chats: [
      chat("tg:1:55", "Pontus", { unreadCount: 2, mutedUntil: NOW + MUTE_MS }),
      chat("iMessage;-;+4670", "Elin", { unreadCount: 1 }),
      chat("sl:work:C1", "#daily"),
    ],
    isConfigured: true,
    telegramAvailable: true,
    loadingChats: false,
    starredChats: [],
    sidebarHidden: false,
    chatQuery: "",
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("muted Telegram chats in the sidebar", () => {
  it("stay out of the queue until the mute lapses, then join it on their own", () => {
    const { getByText, getAllByText } = render(<ChatList />);
    expect(getByText("1 new")).toBeTruthy();
    expect(getAllByText("E done")).toHaveLength(1);
    // Listed in Recent meanwhile, like a read chat.
    expect(getByText("Pontus")).toBeTruthy();

    act(() => vi.advanceTimersByTime(MUTE_MS - 1));
    expect(getByText("1 new")).toBeTruthy();

    act(() => vi.advanceTimersByTime(1));
    expect(getByText("2 new")).toBeTruthy();
    expect(getAllByText("E done")).toHaveLength(2);
  });

  it("stay off the compact rail's tiles until the mute lapses", () => {
    useAppStore.setState({ sidebarHidden: true });
    const { queryByTitle } = render(<ChatList />);
    expect(queryByTitle("Elin")).toBeTruthy();
    expect(queryByTitle("Pontus")).toBeNull();

    act(() => vi.advanceTimersByTime(MUTE_MS));
    expect(queryByTitle("Pontus")).toBeTruthy();
  });

  it("show a starred muted chat on the compact rail without the queue's dot", () => {
    useAppStore.setState({ sidebarHidden: true, starredChats: ["tg:1:55"] });
    const { queryByTitle, queryByLabelText } = render(<ChatList />);
    // Listed as a starred tile, like a read one: no signal dot.
    expect(queryByTitle("Pontus")).toBeTruthy();
    expect(queryByLabelText("2 unread")).toBeNull();
    expect(queryByLabelText("1 unread")).toBeTruthy();

    act(() => vi.advanceTimersByTime(MUTE_MS));
    expect(queryByLabelText("2 unread")).toBeTruthy();
  });

  it("follow a mute change from the store", () => {
    const { getByText } = render(<ChatList />);
    expect(getByText("1 new")).toBeTruthy();
    // Unmuted on another device.
    act(() =>
      useAppStore.getState().upsertChat(chat("tg:1:55", "Pontus", { unreadCount: 2 }))
    );
    expect(getByText("2 new")).toBeTruthy();
    // Muted forever again.
    act(() =>
      useAppStore
        .getState()
        .upsertChat(chat("tg:1:55", "Pontus", { unreadCount: 2, mutedUntil: 2_147_483_647_000 }))
    );
    expect(getByText("1 new")).toBeTruthy();
  });
});
