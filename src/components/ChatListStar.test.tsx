// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Chat } from "@/types";
import { useAppStore } from "@/store/useAppStore";
import { ChatList } from "@/components/ChatList";
import { ThemeProvider } from "@/components/ThemeProvider";

vi.mock("@/api/clientFactory", () => ({
  getClient: () => ({ getChats: vi.fn().mockResolvedValue([]), enrichChatActivity: vi.fn().mockResolvedValue([]) }),
}));
vi.mock("@/telegram/useTelegramAvatar", () => ({ useTelegramAvatar: () => null }));
vi.mock("@/lib/contactAvatars", () => ({ useContactAvatar: () => null }));
vi.mock("@/components/SettingsDialog", () => ({ SettingsDialog: () => null }));
vi.mock("@/components/AiSimulatorDialog", () => ({ AiSimulatorDialog: () => null }));

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
    const { getAllByLabelText } = render(<ThemeProvider><ChatList /></ThemeProvider>);
    const stars = getAllByLabelText("Star chat");
    // Three rows, three stars — if a source lost its star this fails.
    expect(stars.length).toBe(3);
  });
});
