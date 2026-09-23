// @vitest-environment jsdom
import { useLayoutEffect } from "react";
import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

beforeEach(() => {
  useAppStore.setState({
    chats: [chat("tg:1:55", "Pontus"), chat("sl:work:C1", "#daily")],
    isConfigured: true,
    loadingChats: false,
    starredChats: [],
    sidebarHidden: false,
    chatQuery: "",
  });
});

const setQuery = (q: string) => act(() => useAppStore.getState().setChatQuery(q));

describe("command-bar query in the sidebar", () => {
  it("lets the query's own commit paint before the list is rebuilt", () => {
    // Stands in for the command-bar input: bound to the live query. Its layout
    // effect sees the DOM exactly as each commit left it.
    const commits: Array<{ query: string; dailyShown: boolean }> = [];
    function Input() {
      const query = useAppStore((s) => s.chatQuery);
      useLayoutEffect(() => {
        commits.push({ query, dailyShown: document.body.textContent?.includes("#daily") ?? false });
      });
      return null;
    }
    const { queryByText } = render(
      <>
        <Input />
        <ChatList />
      </>
    );
    commits.length = 0;

    setQuery("pon");
    // The keystroke's commit still shows the previous results...
    expect(commits[0]).toEqual({ query: "pon", dailyShown: true });
    // ...and the deferred render then filters, with identical results.
    expect(queryByText("Pontus")).toBeTruthy();
    expect(queryByText("#daily")).toBeNull();
  });

  it("names the query in the empty state once it settles", () => {
    const { getByText, queryByText } = render(<ChatList />);
    setQuery("zzz");
    expect(getByText('No chats match "zzz".')).toBeTruthy();
    setQuery("");
    expect(queryByText(/No chats match/)).toBeNull();
    expect(getByText("Pontus")).toBeTruthy();
  });

  it("hides the Starred teaching hint while a query filters", () => {
    const { queryByText } = render(<ChatList />);
    expect(queryByText("Starred")).toBeTruthy();
    setQuery("pon");
    expect(queryByText("Starred")).toBeNull();
    expect(queryByText("Pontus")).toBeTruthy();
    setQuery("");
    expect(queryByText("Starred")).toBeTruthy();
  });
});
