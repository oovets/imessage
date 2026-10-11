// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { onIrcEvent } from "@/irc/api";
import type { IrcBuffer, IrcEventEnvelope, IrcMessage } from "@/irc/types";
import { notifyIncomingMessage } from "@/lib/desktopNotifications";
import { useAppStore } from "@/store/useAppStore";
import { useIrcEvents } from "./useIrcEvents";

vi.mock("@/irc/api", () => ({ onIrcEvent: vi.fn() }));
vi.mock("@/lib/desktopNotifications", () => ({ notifyIncomingMessage: vi.fn() }));

const onIrcEventMock = vi.mocked(onIrcEvent);
const notifyMock = vi.mocked(notifyIncomingMessage);
let emit: (event: IrcEventEnvelope) => void;

const channel: IrcBuffer = {
  id: "#rust",
  name: "#Rust",
  kind: "Channel",
  topic: null,
  last_ts: 0,
  last_text: "",
};
const query: IrcBuffer = { ...channel, id: "anna", name: "Anna", kind: "Query" };

function msg(extra: Partial<IrcMessage> = {}): IrcMessage {
  return {
    id: crypto.randomUUID(),
    ts: 1_800_000_000_000,
    from: "anna",
    text: "hej",
    kind: "Privmsg",
    is_self: false,
    highlight: false,
    ...extra,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  notifyMock.mockReset();
  onIrcEventMock.mockImplementation(async (handler) => {
    emit = handler;
    return () => {};
  });
  useAppStore.setState({
    chats: [],
    messages: {},
    messageFetchedAt: {},
    messageOrder: [],
    connectionNotice: null,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useIrcEvents", () => {
  it("adds opened buffers and files messages into them", () => {
    renderHook(() => useIrcEvents());
    emit({ network_id: "net", update: { type: "BufferOpened", buffer: channel } });
    emit({ network_id: "net", update: { type: "Message", buffer: channel, message: msg() } });
    vi.advanceTimersByTime(16);

    const chat = useAppStore.getState().chats.find((c) => c.guid === "irc:net:#rust");
    expect(chat?.displayName).toBe("#Rust");
    expect(chat?.unreadCount).toBe(1);
    expect(chat?.lastMessageText).toBe("hej");
    expect(chat?.activityAt).toBe(1_800_000_000_000);
    expect(useAppStore.getState().messages["irc:net:#rust"]).toHaveLength(1);
  });

  it("notifies only for highlights, and never for our own messages", () => {
    renderHook(() => useIrcEvents());
    emit({ network_id: "net", update: { type: "Message", buffer: channel, message: msg() } });
    vi.advanceTimersByTime(16);
    expect(notifyMock).not.toHaveBeenCalled();

    emit({
      network_id: "net",
      update: { type: "Message", buffer: channel, message: msg({ highlight: true, text: "me: hi" }) },
    });
    vi.advanceTimersByTime(16);
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock.mock.calls[0][0]).toBe("anna in #Rust");

    emit({
      network_id: "net",
      update: { type: "Message", buffer: query, message: msg({ is_self: true, from: "me" }) },
    });
    vi.advanceTimersByTime(16);
    expect(notifyMock).toHaveBeenCalledTimes(1);
    const q = useAppStore.getState().chats.find((c) => c.guid === "irc:net:anna");
    expect(q?.unreadCount ?? 0).toBe(0);
  });

  it("surfaces errors as a connection notice", () => {
    renderHook(() => useIrcEvents());
    emit({ network_id: "net", update: { type: "Error", buffer: null, text: "bad password" } });
    expect(useAppStore.getState().connectionNotice).toBe("IRC: bad password");
  });

  it("applies a replayed backlog as one commit, with one notification per chat", () => {
    renderHook(() => useIrcEvents());
    emit({ network_id: "net", update: { type: "BufferOpened", buffer: channel } });
    const listener = vi.fn();
    const unsubscribe = useAppStore.subscribe(listener);

    for (let i = 0; i < 200; i++) {
      emit({
        network_id: "net",
        update: {
          type: "Message",
          buffer: channel,
          message: msg({ ts: 1_800_000_000_000 + i, text: `line ${i}`, highlight: i % 20 === 0 }),
        },
      });
    }
    expect(listener).not.toHaveBeenCalled();
    vi.advanceTimersByTime(16);

    const chat = useAppStore.getState().chats.find((c) => c.guid === "irc:net:#rust");
    expect(chat?.unreadCount).toBe(200);
    expect(chat?.lastMessageText).toBe("line 199");
    // The store keeps the newest 100 per chat.
    const cached = useAppStore.getState().messages["irc:net:#rust"];
    expect(cached).toHaveLength(100);
    expect(cached[cached.length - 1].text).toBe("line 199");
    // One merge plus one chat-list commit, however long the backlog.
    expect(listener.mock.calls.length).toBeLessThanOrEqual(2);
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock.mock.calls[0][1].text).toBe("line 180");
    unsubscribe();
  });

  it("applies queued messages before a later event", () => {
    renderHook(() => useIrcEvents());
    emit({ network_id: "net", update: { type: "Message", buffer: channel, message: msg() } });
    // No timer: the error flushes the queued message first.
    emit({ network_id: "net", update: { type: "Error", buffer: null, text: "x" } });
    expect(useAppStore.getState().messages["irc:net:#rust"]).toHaveLength(1);
  });
});
