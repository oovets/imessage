// @vitest-environment jsdom
import { fireEvent, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Chat } from "@/types";
import { useAppStore } from "@/store/useAppStore";
import { Toolbar } from "@/components/Toolbar";

// The dialogs are lazy chunks of their own; only the status menu is under test.
vi.mock("@/components/ToolbarDialogs", () => ({
  AiSimulatorDialog: () => null,
  SettingsDialog: () => null,
  SocialGraphDialog: () => null,
}));
vi.mock("@/components/ThemeToggle", () => ({ ThemeToggle: () => null }));

const chat = (guid: string): Chat =>
  ({ guid, displayName: guid, chatIdentifier: guid, participants: [], lastMessage: null, unreadCount: 0 }) as Chat;

beforeEach(() => {
  useAppStore.setState({
    isConfigured: true,
    wsConnected: true,
    pollingFallback: false,
    telegramAvailable: true,
    slackAvailable: true,
    ircAvailable: false,
    // Slack is set up but has no chats yet: still connecting.
    chats: [chat("iMessage;-;+4670"), chat("tg:1:5")],
  });
});

describe("Toolbar sources", () => {
  it("counts live sources and lists each one's state", () => {
    const view = render(<Toolbar />);
    const status = view.getByText("2 sources live");
    expect(view.queryByRole("dialog", { name: "Sources" })).toBeNull();

    fireEvent.click(status);
    const menu = view.getByRole("dialog", { name: "Sources" });
    const rows = [...menu.querySelectorAll("li")].map((li) => li.textContent);
    expect(rows).toEqual([
      "iMessagelive",
      "Telegramlive",
      "Slackconnecting…",
      "IRCnot set up",
    ]);
  });

  it("opens Settings from the menu", () => {
    const onOpen = vi.fn();
    window.addEventListener("app:open-settings", onOpen);
    const view = render(<Toolbar />);
    fireEvent.click(view.getByText("2 sources live"));
    fireEvent.click(view.getByText("Settings…"));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(view.queryByRole("dialog", { name: "Sources" })).toBeNull();
    window.removeEventListener("app:open-settings", onOpen);
  });
});

describe("command bar jump", () => {
  const enter = (view: ReturnType<typeof render>) =>
    fireEvent.keyDown(view.getByPlaceholderText("Search, or jump to a chat…"), { key: "Enter" });

  beforeEach(() => {
    useAppStore.setState({
      chats: [{ ...chat("tg:1:5"), activityAt: 9 }, { ...chat("iMessage;-;+4670"), activityAt: 8 }, { ...chat("sl:w:C1"), activityAt: 7 }],
      starredChats: [],
      chatQuery: "",
      chatSourceFilter: null,
      chatListGrouping: "time",
      collapsedAccounts: [],
      sidebarHidden: false,
      selectedChatGUID: null,
    });
  });

  it("opens what the sidebar lists first under its network filter", () => {
    useAppStore.setState({ chatSourceFilter: "slack" });
    const view = render(<Toolbar />);
    enter(view);
    expect(useAppStore.getState().selectedChatGUID).toBe("sl:w:C1");
  });

  it("follows Recent's network order", () => {
    useAppStore.setState({ chatListGrouping: "network" });
    const view = render(<Toolbar />);
    enter(view);
    // iMessage comes first by network, though Telegram is the most recent.
    expect(useAppStore.getState().selectedChatGUID).toBe("iMessage;-;+4670");
  });
});
