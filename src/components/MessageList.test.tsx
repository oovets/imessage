// @vitest-environment jsdom
import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "@/store/useAppStore";
import type { Message } from "@/types";
import { MessageList } from "./MessageList";

// The bubble is swapped for a memoized recorder, so the tests see exactly
// which bubbles a list render re-renders — i.e. whether the list's props are
// stable enough for the real memoized bubble to skip.
const spy = vi.hoisted(() => ({
  bubbles: [] as Array<{ guid: string; props: Record<string, unknown> }>,
  listRenders: 0,
}));

vi.mock("@/components/MessageBubble", async () => {
  const { memo } = await import("react");
  return {
    MessageBubble: memo(function MessageBubble(props: { message: Message }) {
      spy.bubbles.push({ guid: props.message.guid, props });
      return null;
    }),
  };
});
// Rendered unmemoized in every list render: counts them.
vi.mock("@/components/TypingIndicator", () => ({
  TypingIndicator: () => {
    spy.listRenders++;
    return null;
  },
}));
vi.mock("@/components/MessageListSkeleton", () => ({
  MessageListSkeleton: () => <div data-testid="skeleton" />,
}));
vi.mock("@/api/clientFactory", () => ({ getClient: vi.fn() }));
vi.mock("@/telegram/api", () => ({ tg: { react: vi.fn() } }));

const CHAT = "iMessage;-;+46700000000";
const OTHER = "iMessage;-;+46700000001";
const MIN = 60_000;
const T0 = Date.UTC(2026, 8, 20, 9, 0);

function msg(guid: string, over: Partial<Message> = {}): Message {
  return {
    guid,
    text: guid,
    isFromMe: true,
    dateCreated: T0,
    handle: null,
    attachments: [],
    associatedMessageGuid: "",
    associatedMessageType: "",
    chatGUID: CHAT,
    ...over,
  };
}

const alice = { address: "alice@example.com", firstName: "Alice" };

function rendersOf(guid: string) {
  return spy.bubbles.filter((b) => b.guid === guid);
}

function lastProps(guid: string) {
  const r = rendersOf(guid);
  return r[r.length - 1]?.props;
}

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

beforeEach(() => {
  spy.bubbles.length = 0;
  spy.listRenders = 0;
  useAppStore.setState({
    chats: [
      {
        guid: CHAT,
        displayName: "Test",
        chatIdentifier: CHAT,
        participants: [],
        lastMessage: null,
        unreadCount: 0,
      },
    ],
    messages: {},
    loadingMessages: false,
    superlightMode: false,
    showTimestamps: true,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

async function renderReady(chatGUID = CHAT) {
  const view = render(<MessageList chatGUID={chatGUID} />);
  // The list fades in after two animation frames; wait for that render too.
  await waitFor(() =>
    expect(view.container.querySelector(".opacity-100")).not.toBeNull()
  );
  return view;
}

describe("MessageList memo boundaries", () => {
  it("re-renders only the bubbles whose props changed", async () => {
    const m1 = msg("m1", { isFromMe: false, handle: alice, text: "hi" });
    const love = msg("t1", {
      text: "",
      dateCreated: T0 + 1000,
      associatedMessageGuid: "m1",
      associatedMessageType: "2000",
    });
    const m2 = msg("m2", { dateCreated: T0 + 10 * MIN });
    useAppStore.setState({ messages: { [CHAT]: [m1, love, m2] } });
    await renderReady();

    expect(rendersOf("m1")).toHaveLength(1);
    expect(rendersOf("m2")).toHaveLength(1);
    expect(lastProps("m1")!.reactions).toEqual(["❤️"]);

    // A new message in its own group: the old bubbles' props are all the
    // same references (message, reactions, handlers), so they skip.
    act(() => useAppStore.getState().upsertMessage(msg("m3", { dateCreated: T0 + 20 * MIN })));
    expect(rendersOf("m3")).toHaveLength(1);
    expect(rendersOf("m1")).toHaveLength(1);
    expect(rendersOf("m2")).toHaveLength(1);
    expect(lastProps("m3")!.onReply).toBe(lastProps("m1")!.onReply);
    expect(lastProps("m3")!.onReact).toBe(lastProps("m1")!.onReact);

    // A new tapback on m1 changes only m1's reactions.
    act(() =>
      useAppStore.getState().upsertMessage(
        msg("t2", {
          text: "",
          isFromMe: false,
          handle: alice,
          dateCreated: T0 + 21 * MIN,
          associatedMessageGuid: "m1",
          associatedMessageType: "2001",
        })
      )
    );
    expect(rendersOf("m1")).toHaveLength(2);
    expect(lastProps("m1")!.reactions).toEqual(["❤️", "👍"]);
    expect(rendersOf("m2")).toHaveLength(1);
    expect(rendersOf("m3")).toHaveLength(1);
    // Tapbacks never render as bubbles.
    expect(rendersOf("t1")).toHaveLength(0);
    expect(rendersOf("t2")).toHaveLength(0);
  });

  it("re-renders a bubble whose group position changes", async () => {
    useAppStore.setState({ messages: { [CHAT]: [msg("m1")] } });
    await renderReady();
    expect(lastProps("m1")!.timeLabel).toBeDefined();

    // Same sender within a minute: m1 is no longer last in its group.
    act(() => useAppStore.getState().upsertMessage(msg("m2", { dateCreated: T0 + 30_000 })));
    expect(rendersOf("m1")).toHaveLength(2);
    expect(lastProps("m1")!.timeLabel).toBeUndefined();
    expect(lastProps("m2")!.timeLabel).toBeDefined();
    expect(lastProps("m2")!.isFirstInGroup).toBe(false);
  });

  it("ignores store changes that don't affect this list", async () => {
    useAppStore.setState({ messages: { [CHAT]: [msg("m1")] } });
    await renderReady();
    const before = spy.listRenders;

    // Another pane loading an uncached chat flips the global flag.
    act(() => useAppStore.getState().setLoadingMessages(true));
    act(() => useAppStore.getState().setLoadingMessages(false));
    // Another chat's history, and this chat's own sidebar fields.
    act(() =>
      useAppStore.setState((s) => ({ messages: { ...s.messages, [OTHER]: [msg("o1", { chatGUID: OTHER })] } }))
    );
    act(() =>
      useAppStore.setState((s) => ({
        chats: s.chats.map((c) => ({ ...c, unreadCount: 3, lastMessageText: "new" })),
      }))
    );

    expect(spy.listRenders).toBe(before);
    expect(rendersOf("m1")).toHaveLength(1);
  });

  it("does not re-render when the parent re-renders with the same chat", async () => {
    useAppStore.setState({ messages: { [CHAT]: [msg("m1")] } });
    const view = await renderReady();
    const before = spy.listRenders;
    view.rerender(<MessageList chatGUID={CHAT} />);
    expect(spy.listRenders).toBe(before);
  });
});

describe("MessageList loading state", () => {
  it("shows the skeleton only while this chat is empty and a load is running", async () => {
    useAppStore.setState({ loadingMessages: true });
    const view = render(<MessageList chatGUID={CHAT} />);
    expect(view.queryByTestId("skeleton")).not.toBeNull();

    act(() => useAppStore.getState().setLoadingMessages(false));
    expect(view.queryByTestId("skeleton")).toBeNull();
    expect(view.getByText("No messages yet")).toBeTruthy();

    act(() => useAppStore.getState().setLoadingMessages(true));
    expect(view.queryByTestId("skeleton")).not.toBeNull();

    // Content arrives while the flag is still up: the list, not the skeleton.
    act(() => useAppStore.setState({ messages: { [CHAT]: [msg("m1")] } }));
    expect(view.queryByTestId("skeleton")).toBeNull();
    expect(rendersOf("m1")).toHaveLength(1);
  });

  it("shows the superlight loading text in superlight mode", () => {
    useAppStore.setState({ loadingMessages: true, superlightMode: true });
    const view = render(<MessageList chatGUID={CHAT} />);
    expect(view.getByText("Loading messages…")).toBeTruthy();
  });
});

// The pre-cache chip and label code, verbatim, as the reference output.
function oldFormatDateChip(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const diffDays = Math.floor(
    (new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() -
      new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) /
      (1000 * 60 * 60 * 24)
  );
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return d.toLocaleDateString([], { weekday: "long" });
  return d.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    year: d.getFullYear() === now.getFullYear() ? undefined : "numeric",
  });
}

function oldFormatTimeOnly(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function oldFormatMessageTime(dateCreated: number): string {
  const date = new Date(dateCreated);
  const now = new Date();
  const diffDays = Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24));
  if (diffDays === 0) return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (diffDays < 7) return date.toLocaleDateString([], { weekday: "short" });
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function chipTexts(container: HTMLElement): string[] {
  return [...container.querySelectorAll(".text-cc-chip > span.whitespace-nowrap")].map(
    (el) => el.textContent ?? ""
  );
}

describe("MessageList date chips and time labels", () => {
  const NOW = new Date(2026, 8, 23, 15, 0).getTime();
  const DAY = 24 * 60 * MIN;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });

  it("renders every chip branch exactly as before", async () => {
    // Last year, this year >7 days back, the weekday range, yesterday, and a
    // later-today message, plus a 20-minute gap that earns a time header.
    const stamps = [
      NOW - 400 * DAY,
      NOW - 30 * DAY,
      NOW - 8 * DAY,
      NOW - 6 * DAY,
      NOW - 3 * DAY,
      NOW - 1 * DAY,
      NOW - 1 * DAY + 20 * MIN,
      NOW - 2 * 60 * MIN,
    ];
    const history = stamps.map((t, i) => msg(`m${i}`, { dateCreated: t }));
    useAppStore.setState({ messages: { [CHAT]: history } });
    const { container } = await renderReady();

    const expected: string[] = [];
    history.forEach((m, i) => {
      const prev = history[i - 1];
      const sameDay = prev && new Date(prev.dateCreated).toDateString() === new Date(m.dateCreated).toDateString();
      if (!sameDay) expected.push(oldFormatDateChip(m.dateCreated).toUpperCase());
      else if (m.dateCreated - prev.dateCreated > 15 * MIN) expected.push(oldFormatTimeOnly(m.dateCreated));
    });
    expect(expected).toContain("TODAY");
    expect(expected).toContain("YESTERDAY");
    expect(chipTexts(container)).toEqual(expected);

    // Each message is alone in its group, so each carries its label.
    for (const m of history) {
      expect(lastProps(m.guid)!.timeLabel).toBe(oldFormatMessageTime(m.dateCreated));
    }
  });

  it("opens an all-today history on the time rather than TODAY", async () => {
    const t = NOW - 3 * 60 * MIN;
    useAppStore.setState({ messages: { [CHAT]: [msg("m1", { dateCreated: t })] } });
    const { container } = await renderReady();
    expect(chipTexts(container)).toEqual([oldFormatTimeOnly(t)]);
  });

  it("adds and drops the labels when the timestamps setting is toggled", async () => {
    useAppStore.setState({ messages: { [CHAT]: [msg("m1", { dateCreated: NOW - MIN })] } });
    await renderReady();
    expect(lastProps("m1")!.timeLabel).toBe(oldFormatMessageTime(NOW - MIN));

    act(() => useAppStore.getState().setShowTimestamps(false));
    expect(lastProps("m1")!.timeLabel).toBeUndefined();
    act(() => useAppStore.getState().setShowTimestamps(true));
    expect(lastProps("m1")!.timeLabel).toBe(oldFormatMessageTime(NOW - MIN));
  });

  it("passes no time label when timestamps are off", async () => {
    useAppStore.setState({
      showTimestamps: false,
      messages: { [CHAT]: [msg("m1", { dateCreated: NOW - MIN })] },
    });
    await renderReady();
    expect(lastProps("m1")!.timeLabel).toBeUndefined();
  });
});

describe("MessageList relative labels over time", () => {
  const DAY = 24 * 60 * MIN;

  beforeEach(() => {
    // A second useFakeTimers is ignored, so start from real ones.
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  });

  it("re-renders itself when a bubble's time label is due to change", () => {
    const t = new Date(2026, 8, 22, 15, 0).getTime();
    vi.setSystemTime(t + DAY - 5 * MIN);
    useAppStore.setState({ messages: { [CHAT]: [msg("m1", { dateCreated: t })] } });
    render(<MessageList chatGUID={CHAT} />);
    const before = lastProps("m1")!.timeLabel;
    expect(before).toBe(oldFormatMessageTime(t));
    const listRenders = spy.listRenders;

    // Nothing is due yet: no render.
    act(() => vi.advanceTimersByTime(5 * MIN - 1));
    expect(spy.listRenders).toBe(listRenders);
    expect(rendersOf("m1")).toHaveLength(1);

    // 24 h on, "15:00" reads as a weekday.
    act(() => vi.advanceTimersByTime(1));
    expect(lastProps("m1")!.timeLabel).toBe(oldFormatMessageTime(t));
    expect(lastProps("m1")!.timeLabel).not.toBe(before);
    expect(rendersOf("m1")).toHaveLength(2);
  });

  it("rolls the day chips over at midnight", () => {
    const yesterday = new Date(2026, 8, 22, 10, 0).getTime();
    const today = new Date(2026, 8, 23, 10, 0).getTime();
    vi.setSystemTime(new Date(2026, 8, 23, 23, 59, 30).getTime());
    useAppStore.setState({
      showTimestamps: false,
      messages: {
        [CHAT]: [msg("m1", { dateCreated: yesterday }), msg("m2", { dateCreated: today })],
      },
    });
    const { container } = render(<MessageList chatGUID={CHAT} />);
    expect(chipTexts(container)).toEqual(["YESTERDAY", "TODAY"]);

    act(() => vi.advanceTimersByTime(30_000));
    expect(chipTexts(container)).toEqual([
      oldFormatDateChip(yesterday).toUpperCase(),
      "YESTERDAY",
    ]);
    expect(chipTexts(container)[0]).not.toBe("YESTERDAY");
  });
});
