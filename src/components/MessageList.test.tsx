// @vitest-environment jsdom
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "@/store/useAppStore";
import type { Message } from "@/types";
import { OLDER_PAGE_SIZE, fetchOlderMessages } from "@/lib/olderHistory";
import { mergeChatThreads } from "@/lib/chatThreadMerge";
import { getClient } from "@/api/clientFactory";
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
vi.mock("@/lib/olderHistory", async (actual) => ({
  ...(await actual<typeof import("@/lib/olderHistory")>()),
  fetchOlderMessages: vi.fn(),
}));

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
  // This session's chat list is merged, with no split iMessage/SMS pairs.
  mergeChatThreads([]);
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
    historyStart: {},
    loadingMessages: false,
    superlightMode: false,
    showTimestamps: true,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

// The list pins and shows its history in the commit that mounts it.
async function renderReady(chatGUID = CHAT) {
  return render(<MessageList chatGUID={chatGUID} />);
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
    expect(lastProps("m1")!.reactions).toEqual([{ emoji: "❤️", count: 1, mine: true }]);

    // A new message in its own group: the old bubbles' props are all the
    // same references (message, reactions, handlers), so they skip.
    act(() => useAppStore.getState().upsertMessage(msg("m3", { dateCreated: T0 + 30 * MIN })));
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
    expect(lastProps("m1")!.reactions).toEqual([
      { emoji: "❤️", count: 1, mine: true },
      { emoji: "👍", count: 1, mine: false },
    ]);
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

// Records what each observer watches, so a test can resize an element.
class FakeResizeObserver {
  static all: FakeResizeObserver[] = [];
  targets = new Set<Element>();
  constructor(private callback: ResizeObserverCallback) {
    FakeResizeObserver.all.push(this);
  }
  observe(el: Element) {
    this.targets.add(el);
  }
  unobserve(el: Element) {
    this.targets.delete(el);
  }
  disconnect() {
    this.targets.clear();
  }
  static resized(el: Element) {
    for (const ro of FakeResizeObserver.all) {
      if (ro.targets.has(el)) ro.callback([], ro as unknown as ResizeObserver);
    }
  }
}

/**
 * The list's scroll box, which jsdom doesn't lay out, clamped the way a
 * browser clamps. On the prototype, so it is in place before the list mounts
 * (the list pins in its mounting commit); restoreMocks removes it after.
 */
function fakeScrollBox(
  initialClientHeight: number,
  /** A height, or one read off the rendered list on every access. */
  initialScrollHeight: number | (() => number)
) {
  let clientHeight = initialClientHeight;
  let height = initialScrollHeight;
  let scrollTop = 0;
  const scrollHeightNow = () => (typeof height === "function" ? height() : height);
  const clamp = (v: number) => Math.max(0, Math.min(v, scrollHeightNow() - clientHeight));
  const isList = (el: Element) => el.classList.contains("scrollbar-autohide");
  vi.spyOn(Element.prototype, "clientHeight", "get").mockImplementation(function (this: Element) {
    return isList(this) ? clientHeight : 0;
  });
  vi.spyOn(Element.prototype, "scrollHeight", "get").mockImplementation(function (this: Element) {
    return isList(this) ? scrollHeightNow() : 0;
  });
  vi.spyOn(Element.prototype, "scrollTop", "get").mockImplementation(function (this: Element) {
    return isList(this) ? scrollTop : 0;
  });
  vi.spyOn(Element.prototype, "scrollTop", "set").mockImplementation(function (this: Element, v: number) {
    if (isList(this)) scrollTop = clamp(v);
  });
  const list = () => document.querySelector<HTMLElement>(".scrollbar-autohide")!;
  /** scrollTop clamps, observers run, and a moved scrollTop fires a scroll event. */
  function relayout(resized: Element) {
    const before = scrollTop;
    scrollTop = clamp(scrollTop);
    act(() => FakeResizeObserver.resized(resized));
    if (scrollTop !== before) act(() => void list().dispatchEvent(new Event("scroll")));
  }
  return {
    /** The content changed height (to `next`, or to what it now reads). */
    resize(next?: number) {
      if (next !== undefined) height = next;
      relayout(list().firstElementChild!);
    },
    /** The scroll box changed height (a pane resize, the composer growing). */
    resizeBox(height: number) {
      clientHeight = height;
      relayout(list());
    },
    /** The reader scrolls to `top`. */
    scrollTo(top: number) {
      scrollTop = clamp(top);
      act(() => void list().dispatchEvent(new Event("scroll")));
    },
  };
}

describe("MessageList scroll pinning", () => {
  beforeEach(() => {
    FakeResizeObserver.all.length = 0;
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const history = [msg("m1"), msg("m2", { dateCreated: T0 + MIN })];

  // The list's scroll wiring hangs off the scroll container, which a chat
  // opened without a cache only mounts once the history arrives.
  function open(path: "skeleton" | "cached", scrollHeight: number) {
    const box = fakeScrollBox(530, scrollHeight);
    if (path === "skeleton") useAppStore.setState({ loadingMessages: true });
    else useAppStore.setState({ messages: { [CHAT]: history } });
    const view = render(<MessageList chatGUID={CHAT} />);
    if (path === "skeleton") {
      expect(view.queryByTestId("skeleton")).not.toBeNull();
      act(() => useAppStore.setState({ loadingMessages: false, messages: { [CHAT]: history } }));
    }
    const list = view.container.querySelector<HTMLElement>(".scrollbar-autohide")!;
    const pill = () => view.getByLabelText("Jump to latest").classList.contains("opacity-100");
    return { list, box, pill };
  }

  it.each(["skeleton", "cached"] as const)(
    "opens on the newest message in the commit that mounts the list (%s)",
    (path) => {
      // No frames have run: the first paint is already at the bottom, so
      // nothing has to be hidden while it settles.
      const { list } = open(path, 617);
      expect(list.scrollTop).toBe(87);
      expect(list.querySelector(".opacity-0")).toBeNull();
    }
  );

  it.each(["skeleton", "cached"] as const)(
    "re-pins content that shrinks and grows back after first paint (%s)",
    (path) => {
      const { list, box } = open(path, 617);
      expect(list.scrollTop).toBe(87);

      // A link card's image swaps in: the list stops overflowing, then grows.
      box.resize(530);
      expect(list.scrollTop).toBe(0);
      box.resize(619);
      expect(list.scrollTop).toBe(89);
    }
  );

  it("keeps a pinned reader pinned when the scroll box shrinks", () => {
    const { list, box } = open("cached", 619);
    expect(list.scrollTop).toBe(89);
    // The composer grows a line.
    box.resizeBox(510);
    expect(list.scrollTop).toBe(109);
  });

  it.each(["skeleton", "cached"] as const)(
    "leaves a reader who scrolled up where they are (%s)",
    (path) => {
      const { list, box, pill } = open(path, 619);
      expect(list.scrollTop).toBe(89);
      expect(pill()).toBe(false);

      // The first scroll after opening is the reader's, not growth.
      box.scrollTo(0);
      expect(list.scrollTop).toBe(0);
      expect(pill()).toBe(true);

      box.resize(819);
      box.resizeBox(510);
      expect(list.scrollTop).toBe(0);
    }
  );
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

describe("MessageList in IRC", () => {
  const IRC = "irc:net:#isp";
  const anna = { address: "anna", firstName: "anna" };
  const bob = { address: "bob", firstName: "bob" };

  function seed(messages: Message[]) {
    useAppStore.setState({
      chats: [
        {
          guid: IRC,
          displayName: "#isp",
          chatIdentifier: "#isp",
          participants: [],
          lastMessage: null,
          unreadCount: 0,
        },
      ],
      messages: { [IRC]: messages.map((m) => ({ ...m, chatGUID: IRC })) },
    });
  }

  it("names the sender even when only one person has spoken", async () => {
    seed([msg("a1", { isFromMe: false, handle: anna })]);
    await renderReady(IRC);
    expect(lastProps("a1")?.showSender).toBe(true);
  });

  it("keeps a run of lines from one nick under one name, minutes apart", async () => {
    seed([
      msg("a1", { isFromMe: false, handle: anna, dateCreated: T0 }),
      msg("a2", { isFromMe: false, handle: anna, dateCreated: T0 + 3 * MIN }),
      msg("a3", { isFromMe: false, handle: anna, dateCreated: T0 + 8 * MIN }),
      msg("b1", { isFromMe: false, handle: bob, dateCreated: T0 + 9 * MIN }),
      // Past the 15-minute gap: a new group, named again.
      msg("b2", { isFromMe: false, handle: bob, dateCreated: T0 + 30 * MIN }),
      msg("me", { isFromMe: true, dateCreated: T0 + 31 * MIN }),
    ]);
    await renderReady(IRC);
    expect(["a1", "a2", "a3", "b1", "b2", "me"].map((g) => lastProps(g)?.showSender)).toEqual([
      true,
      false,
      false,
      true,
      true,
      false,
    ]);
    expect(lastProps("a2")?.isFirstInGroup).toBe(false);
    // Reactions and replies aren't offered for IRC.
    expect(lastProps("a1")?.onReact).toBeUndefined();
    expect(lastProps("a1")?.onReply).toBeUndefined();
  });

  it("groups other sources' consecutive messages until a time header", async () => {
    useAppStore.setState({
      messages: {
        [CHAT]: [
          msg("x1", { isFromMe: false, handle: alice, dateCreated: T0 }),
          msg("x2", { isFromMe: false, handle: alice, dateCreated: T0 + 3 * MIN }),
          // Past the 15-minute gap: a new group.
          msg("x3", { isFromMe: false, handle: alice, dateCreated: T0 + 20 * MIN }),
        ],
      },
    });
    await renderReady();
    expect(lastProps("x1")?.isLastInGroup).toBe(false);
    expect(lastProps("x2")?.isFirstInGroup).toBe(false);
    expect(lastProps("x2")?.isLastInGroup).toBe(true);
    expect(lastProps("x3")?.isFirstInGroup).toBe(true);
    // One sender in a 1:1 iMessage chat: no name, as before.
    expect(lastProps("x1")?.showSender).toBe(false);
  });
});

describe("MessageList earlier history", () => {
  it("prepends the page before the oldest message, until the start", async () => {
    const m3 = msg("m3", { dateCreated: T0 + 30 * MIN });
    const m4 = msg("m4", { dateCreated: T0 + 31 * MIN });
    useAppStore.setState({ messages: { [CHAT]: [m3, m4] } });
    const m1 = msg("m1", { dateCreated: T0 });
    const m2 = msg("m2", { dateCreated: T0 + MIN });
    // A full page, which may overlap what is loaded; m3 must not double up.
    const between = Array.from({ length: OLDER_PAGE_SIZE - 3 }, (_, i) =>
      msg(`f${i}`, { dateCreated: T0 + 2 * MIN + i })
    );
    vi.mocked(fetchOlderMessages)
      .mockResolvedValueOnce([m1, m2, ...between, m3])
      .mockResolvedValueOnce([]);
    const view = await renderReady();

    fireEvent.click(view.getByText("Load earlier messages"));
    await waitFor(() => expect(rendersOf("m1")).toHaveLength(1));
    expect(vi.mocked(fetchOlderMessages).mock.calls[0]).toEqual([CHAT, m3]);
    const order = [...new Set(spy.bubbles.map((b) => b.guid))];
    expect(order.indexOf("m1")).toBeLessThan(order.indexOf("m2"));
    expect(rendersOf("m3").length).toBeGreaterThan(0);

    // The next page is empty: the start of the chat, so the button goes.
    fireEvent.click(view.getByText("Load earlier messages"));
    await waitFor(() => expect(view.queryByText("Load earlier messages")).toBeNull());
    expect(vi.mocked(fetchOlderMessages).mock.calls[1]).toEqual([CHAT, m1]);
    expect(useAppStore.getState().historyStart[CHAT]).toBe("m1");
  });

  it("takes a short iMessage page for the start and asks for no more", async () => {
    useAppStore.setState({ messages: { [CHAT]: [msg("m3", { dateCreated: T0 + 30 * MIN })] } });
    // BlueBubbles answers with everything up to the limit: two is all.
    vi.mocked(fetchOlderMessages).mockResolvedValueOnce([
      msg("m1", { dateCreated: T0 }),
      msg("m2", { dateCreated: T0 + MIN }),
    ]);
    const view = await renderReady();

    fireEvent.click(view.getByText("Load earlier messages"));
    await waitFor(() => expect(rendersOf("m1")).toHaveLength(1));
    expect(view.queryByText("Load earlier messages")).toBeNull();
    expect(useAppStore.getState().historyStart[CHAT]).toBe("m1");
    expect(fetchOlderMessages).toHaveBeenCalledTimes(1);
  });

  it("keeps paging a Slack chat after a short page, until one comes back empty", async () => {
    const SLACK = "sl:work:C1";
    useAppStore.setState({ messages: { [SLACK]: [msg("m3", { dateCreated: T0 + 30 * MIN })] } });
    // Slack can answer short in the middle of a history.
    vi.mocked(fetchOlderMessages)
      .mockResolvedValueOnce([msg("m1", { dateCreated: T0 }), msg("m2", { dateCreated: T0 + MIN })])
      .mockResolvedValueOnce([]);
    const view = await renderReady(SLACK);

    fireEvent.click(view.getByText("Load earlier messages"));
    await waitFor(() => expect(rendersOf("m1")).toHaveLength(1));
    fireEvent.click(view.getByText("Load earlier messages"));
    await waitFor(() => expect(view.queryByText("Load earlier messages")).toBeNull());
    // Ends paging for this list, but proves no start to remember.
    expect(useAppStore.getState().historyStart[SLACK]).toBeUndefined();
  });

  it("remembers no start from an empty Telegram page, which a failed backfill looks like", async () => {
    const TG = "tg:1:55";
    useAppStore.setState({ messages: { [TG]: [msg("m3", { dateCreated: T0 + 30 * MIN })] } });
    vi.mocked(fetchOlderMessages).mockResolvedValueOnce([]);
    const view = await renderReady(TG);

    fireEvent.click(view.getByText("Load earlier messages"));
    await waitFor(() => expect(view.queryByText("Load earlier messages")).toBeNull());
    expect(useAppStore.getState().historyStart[TG]).toBeUndefined();
  });

  it("remembers no start for a merged iMessage/SMS pair: the next open asks again", async () => {
    const thread = (guid: string) =>
      ({ guid, displayName: "", chatIdentifier: guid, participants: [], lastMessage: null, unreadCount: 0 });
    mergeChatThreads([thread(CHAT), thread("SMS;-;+46700000000")]);
    useAppStore.setState({ messages: { [CHAT]: [msg("m3", { dateCreated: T0 + 30 * MIN })] } });
    // With the server out of reach, the pair's fetch answers empty.
    vi.mocked(fetchOlderMessages).mockResolvedValueOnce([]);
    const view = await renderReady();

    fireEvent.click(view.getByText("Load earlier messages"));
    await waitFor(() => expect(view.queryByText("Load earlier messages")).toBeNull());
    expect(useAppStore.getState().historyStart[CHAT]).toBeUndefined();
    view.unmount();
    expect((await renderReady()).getByText("Load earlier messages")).toBeTruthy();
  });

  it("opens at a known start without the button, and scrolling asks for nothing", async () => {
    useAppStore.setState({
      messages: { [CHAT]: [msg("m1"), msg("m2", { dateCreated: T0 + MIN })] },
      historyStart: { [CHAT]: "m1" },
    });
    const view = await renderReady();
    expect(view.queryByText("Load earlier messages")).toBeNull();

    // At the top of the list, where a scroll would fetch the page before.
    fireEvent.scroll(view.container.querySelector(".scrollbar-autohide")!);
    expect(fetchOlderMessages).not.toHaveBeenCalled();
  });

  it("asks again once the cached history no longer reaches the start", async () => {
    // The cache keeps the newest messages; m0, the first, has dropped out.
    useAppStore.setState({
      messages: { [CHAT]: [msg("m1"), msg("m2", { dateCreated: T0 + MIN })] },
      historyStart: { [CHAT]: "m0" },
    });
    const view = await renderReady();
    expect(view.getByText("Load earlier messages")).toBeTruthy();
  });

  // 100px a row (the button row and each message), so a page landing above
  // grows the list the way a browser lays it out.
  function openScrolledBack(cached: number, scrollTo: number, page: number) {
    FakeResizeObserver.all.length = 0;
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    const rows = () => document.querySelector(".scrollbar-autohide > div")?.children.length ?? 0;
    const box = fakeScrollBox(530, () => rows() * 100);
    const at = (i: number) => T0 + i * MIN;
    useAppStore.setState({
      messages: { [CHAT]: Array.from({ length: cached }, (_, i) => msg(`c${i}`, { dateCreated: at(100 + i) })) },
    });
    vi.mocked(fetchOlderMessages).mockResolvedValueOnce(
      Array.from({ length: page }, (_, i) => msg(`o${i}`, { dateCreated: at(i) }))
    );
    const view = render(<MessageList chatGUID={CHAT} />);
    const list = view.container.querySelector<HTMLElement>(".scrollbar-autohide")!;
    // Near the top: the scroll fetches the page before.
    box.scrollTo(scrollTo);
    return { list, box };
  }

  it("keeps what was on screen in place when an earlier page lands", async () => {
    // 11 rows: 1100px in a 530px box, pinned at 570; the reader goes to 100.
    const { list, box } = openScrolledBack(10, 100, 5);
    await waitFor(() => expect(rendersOf("o0")).toHaveLength(1));
    // 15 rows now: five more, and the button row gone (a short iMessage page
    // is the start). What was 100px from the top still is.
    expect(list.querySelector("button")).toBeNull();
    expect(list.scrollTop).toBe(1500 - 1100 + 100);
    box.resize();
    expect(list.scrollTop).toBe(500);
    vi.unstubAllGlobals();
  });

  it("keeps the anchor in a list that overflows by less than the bottom zone", async () => {
    // 6 rows: 600px in 530px. At the very top the reader is 70px from the
    // bottom, which still counts as being there.
    const { list, box } = openScrolledBack(5, 0, 5);
    await waitFor(() => expect(rendersOf("o0")).toHaveLength(1));
    // 10 rows: five more, the button row gone.
    expect(list.scrollTop).toBe(1000 - 600);
    // The page's growth is above the reader: not a reason to re-pin.
    box.resize();
    expect(list.scrollTop).toBe(400);
    vi.unstubAllGlobals();
  });

  it("anchors the button row's removal when an empty page ends paging", async () => {
    // A merged iMessage/SMS pair proves no start, so its paging ends on an
    // empty page, with nothing prepended to anchor the row going.
    const thread = (guid: string) =>
      ({ guid, displayName: "", chatIdentifier: guid, participants: [], lastMessage: null, unreadCount: 0 });
    mergeChatThreads([thread(CHAT), thread("SMS;-;+46700000000")]);
    // 11 rows (1100px) pinned at 570; at 100 a short page of five lands:
    // 16 rows, the button stays, what was at 100 stays put.
    const { list, box } = openScrolledBack(10, 100, 5);
    await waitFor(() => expect(rendersOf("o0")).toHaveLength(1));
    expect(list.scrollTop).toBe(1600 - 1100 + 100);

    // Near the top again: the next page is empty, and the row goes.
    vi.mocked(fetchOlderMessages).mockResolvedValueOnce([]);
    box.scrollTo(250);
    await waitFor(() => expect(list.querySelector("button")).toBeNull());
    // 15 rows: what was 250px down is now 150px down, still in view as it was.
    expect(list.scrollTop).toBe(1500 - 1600 + 250);
    vi.unstubAllGlobals();
  });

  it("offers a retry when a page fails", async () => {
    useAppStore.setState({ messages: { [CHAT]: [msg("m1")] } });
    vi.mocked(fetchOlderMessages).mockRejectedValueOnce(new Error("offline"));
    const view = await renderReady();

    fireEvent.click(view.getByText("Load earlier messages"));
    await waitFor(() =>
      expect(view.getByText("Couldn’t load earlier messages · retry")).toBeTruthy()
    );
  });
});

describe("MessageList reactions", () => {
  const tapback = (guid: string, from: "me" | typeof alice, type: string, at: number) =>
    msg(guid, {
      text: "",
      isFromMe: from === "me",
      handle: from === "me" ? null : from,
      dateCreated: at,
      associatedMessageGuid: "m1",
      associatedMessageType: type,
    });

  it("counts people per emoji, and a new tapback replaces that person's last", async () => {
    const bob = { address: "bob@example.com", firstName: "Bob" };
    useAppStore.setState({
      messages: {
        [CHAT]: [
          msg("m1", { isFromMe: false, handle: alice }),
          tapback("t1", alice, "2000", T0 + 1),
          tapback("t2", bob, "2000", T0 + 2),
          tapback("t3", "me", "2001", T0 + 3),
          // Mine changes from 👍 to ❤️.
          tapback("t4", "me", "2000", T0 + 4),
        ],
      },
    });
    await renderReady();
    expect(lastProps("m1")!.reactions).toEqual([{ emoji: "❤️", count: 3, mine: true }]);
  });

  it("takes our own tapback back when toggled again", async () => {
    const sendReaction = vi.fn().mockResolvedValue(undefined);
    vi.mocked(getClient).mockReturnValue({ sendReaction } as never);
    useAppStore.setState({
      messages: { [CHAT]: [msg("m1", { isFromMe: false, handle: alice }), tapback("t1", "me", "2000", T0 + 1)] },
    });
    await renderReady();

    const onReact = lastProps("m1")!.onReact as (m: Message, key: string) => Promise<void>;
    await act(() => onReact(useAppStore.getState().messages[CHAT][0], "love"));
    expect(sendReaction).toHaveBeenCalledWith(CHAT, "m1", "-love");
    expect(lastProps("m1")!.reactions).toBeUndefined();
  });
});
