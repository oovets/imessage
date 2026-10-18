// @vitest-environment jsdom
import { act, fireEvent, render, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Chat } from "@/types";
import { useAppStore } from "@/store/useAppStore";
import { ChatList } from "@/components/ChatList";

vi.mock("@/api/clientFactory", () => ({
  getClient: () => ({ getChats: vi.fn().mockResolvedValue([]), enrichChatActivity: vi.fn().mockResolvedValue([]) }),
}));
vi.mock("@/telegram/useTelegramAvatar", () => ({ useTelegramAvatar: () => null }));
vi.mock("@/lib/contactAvatars", () => ({ useContactAvatar: () => null }));

const chat = (guid: string, name: string, extra: Partial<Chat> = {}): Chat =>
  ({ guid, displayName: name, chatIdentifier: guid, participants: [], lastMessage: null, unreadCount: 0, activityAt: 1, ...extra }) as Chat;

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (q: string) => ({ matches: false, media: q, addEventListener: () => {}, removeEventListener: () => {} }),
});

beforeEach(() => {
  useAppStore.setState({
    chats: [
      chat("sl:w:C1", "#general", { activityAt: 9, slackSection: "Public" }),
      chat("tg:1:55", "Pontus", { activityAt: 8, unreadCount: 2 }),
      chat("iMessage;-;+4670", "Elin", { activityAt: 7 }),
      chat("tg:1:56", "Anna", { activityAt: 6 }),
    ],
    isConfigured: true,
    loadingChats: false,
    accountLabels: { "slack:w": "Acme", "telegram:1": "Stefan" },
    collapsedAccounts: [],
    starredChats: [],
    sidebarHidden: false,
    chatQuery: "",
    chatSourceFilter: null,
    chatListGrouping: "time",
  });
});

afterEach(() => {
  vi.useRealTimers();
});

const listed = (container: HTMLElement) =>
  [...container.querySelectorAll("[data-chat-guid]")].map((el) => el.getAttribute("data-chat-guid"));
const press = (key: string, target: Element | Window = window) =>
  act(() => void fireEvent.keyDown(target, { key }));

describe("network filter", () => {
  it("offers All plus each network present, in sidebar order, with what is waiting", () => {
    const view = render(<ChatList />);
    const chips = within(view.getByRole("toolbar", { name: "Show one network" })).getAllByRole("button");
    expect(chips.map((b) => b.getAttribute("aria-label"))).toEqual([
      "All networks",
      "iMessage",
      "Telegram, 1 waiting",
      "Slack",
    ]);
  });

  it("is not offered with a single network", () => {
    useAppStore.setState({ chats: [chat("tg:1:55", "Pontus"), chat("tg:1:56", "Anna")] });
    const view = render(<ChatList />);
    expect(view.queryByRole("toolbar", { name: "Show one network" })).toBeNull();
  });

  it("shows one network on click, and all again on a second click", () => {
    const view = render(<ChatList />);
    fireEvent.click(view.getByRole("button", { name: "Telegram, 1 waiting" }));
    expect(listed(view.container)).toEqual(["tg:1:55", "tg:1:56"]);
    fireEvent.click(view.getByRole("button", { name: "Telegram, 1 waiting" }));
    expect(listed(view.container)).toHaveLength(4);
  });

  it("follows the keys: 1–n pick a network, the same key or 0 show all", () => {
    const view = render(<ChatList />);
    press("3");
    expect(listed(view.container)).toEqual(["sl:w:C1"]);
    press("3");
    expect(listed(view.container)).toHaveLength(4);
    press("1");
    expect(listed(view.container)).toEqual(["iMessage;-;+4670"]);
    press("0");
    expect(listed(view.container)).toHaveLength(4);
    // No fifth chip, no change.
    press("1");
    press("5");
    expect(listed(view.container)).toEqual(["iMessage;-;+4670"]);
  });

  it("leaves the keys to a text field", () => {
    const view = render(
      <>
        <textarea />
        <ChatList />
      </>
    );
    press("2", view.container.querySelector("textarea")!);
    expect(listed(view.container)).toHaveLength(4);
  });

  it("recounts a hidden network's chip when a mute there lapses", () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const now = Date.UTC(2026, 9, 18, 12, 0);
    vi.setSystemTime(now);
    useAppStore.setState({
      chats: [
        chat("sl:w:C1", "#general"),
        chat("tg:1:55", "Pontus", { unreadCount: 2, mutedUntil: now + 5 * 60_000 }),
        chat("iMessage;-;+4670", "Elin"),
      ],
      // Telegram is filtered away; its chip is the only sign of it.
      chatSourceFilter: "slack",
    });
    const view = render(<ChatList />);
    expect(view.getByRole("button", { name: "Telegram" })).toBeTruthy();

    act(() => vi.advanceTimersByTime(5 * 60_000 + 1));
    expect(view.getByRole("button", { name: "Telegram, 1 waiting" })).toBeTruthy();
  });

  it("leaves focus where it was on a chip click, and ↑/↓ walk the list from a focused chip", async () => {
    const view = render(<ChatList />);
    const chip = view.getByRole("button", { name: "Slack" });
    // A click would otherwise focus the chip, keeping ↑/↓ from the list and
    // taking ↵ for itself.
    expect(fireEvent.mouseDown(chip)).toBe(false);

    // Reached by Tab, say: ↓ still moves the list's cursor (and focus).
    chip.focus();
    press("ArrowDown", chip);
    await waitFor(() => expect(document.activeElement?.getAttribute("data-chat-guid")).toBe("tg:1:55"));
  });

  it("lists every network on the compact rail, which has no filter row", () => {
    useAppStore.setState({ chatSourceFilter: "slack" });
    useAppStore.setState({ sidebarHidden: true });
    const view = render(<ChatList />);
    // The rail shows the queue: Pontus (Telegram) despite the Slack filter.
    expect(listed(view.container)).toEqual(["tg:1:55"]);
  });
});

describe("Recent by network", () => {
  it("toggles with G, grouping Recent under network headers", () => {
    const view = render(<ChatList />);
    press("g");
    expect(useAppStore.getState().chatListGrouping).toBe("network");
    const headers = view.getAllByRole("button", { expanded: true }).map((b) => b.textContent);
    expect(headers).toEqual(["iMessage1", "Telegram · Stefan1", "Slack · Acme1"]);
    // The queue first, then Recent network by network.
    expect(listed(view.container)).toEqual(["tg:1:55", "iMessage;-;+4670", "tg:1:56", "sl:w:C1"]);
    press("G");
    expect(useAppStore.getState().chatListGrouping).toBe("time");
  });

  it("folds a network from its header, remembered per account", () => {
    useAppStore.setState({ chatListGrouping: "network" });
    const view = render(<ChatList />);
    fireEvent.click(view.getByRole("button", { name: /Telegram/, expanded: true }));
    expect(useAppStore.getState().collapsedAccounts).toEqual(["telegram:1"]);
    expect(listed(view.container)).toEqual(["tg:1:55", "iMessage;-;+4670", "sl:w:C1"]);
  });

  it("drops the header of a lone network, folded or not", () => {
    useAppStore.setState({ chatListGrouping: "network", collapsedAccounts: ["telegram:1"] });
    const view = render(<ChatList />);
    press("2");
    expect(view.queryAllByRole("button", { expanded: true })).toHaveLength(0);
    expect(listed(view.container)).toEqual(["tg:1:55", "tg:1:56"]);
  });

  it("picks the order from the time · network switch", () => {
    const view = render(<ChatList />);
    fireEvent.click(within(view.getByRole("group", { name: "Sort Recent by" })).getByText("network"));
    expect(useAppStore.getState().chatListGrouping).toBe("network");
  });
});
