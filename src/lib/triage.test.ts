import { afterEach, describe, expect, it, vi } from "vitest";
import type { Chat } from "@/types";
import {
  activeSourceFilter,
  filterChats,
  isMuted,
  listedRecent,
  nextTriageChange,
  summarizeSources,
  triage,
} from "./triage";

const NOW = 1_800_000_000_000;

function chat(guid: string, extra: Partial<Chat> = {}): Chat {
  return {
    guid,
    displayName: guid,
    chatIdentifier: guid,
    participants: [],
    lastMessage: null,
    unreadCount: 0,
    activityAt: 1,
    ...extra,
  };
}

const guids = (list: Chat[]) => list.map((c) => c.guid);

afterEach(() => {
  vi.useRealTimers();
});

describe("triage with Telegram mutes", () => {
  it("places a muted unread chat like a read one, keeping its count and the order", () => {
    const chats = [
      chat("tg:1:1", { unreadCount: 2, mutedUntil: NOW + 60_000 }),
      chat("tg:1:2", { unreadCount: 1 }),
      chat("tg:1:3", { unreadCount: 4, mutedUntil: NOW + 60_000 }),
      chat("tg:1:4"),
      chat("tg:1:5", { unreadCount: 1, mutedUntil: NOW + 60_000 }),
    ];
    const { waiting, starred, recent } = triage(chats, ["tg:1:3"], NOW);
    expect(guids(waiting)).toEqual(["tg:1:2"]);
    expect(guids(starred)).toEqual(["tg:1:3"]);
    expect(guids(recent)).toEqual(["tg:1:1", "tg:1:4", "tg:1:5"]);
    // Only the placement changes.
    expect(recent[0].unreadCount).toBe(2);
    expect(starred[0].unreadCount).toBe(4);
  });

  it("puts a chat back in the queue once its mute has lapsed", () => {
    const chats = [
      chat("tg:1:1", { unreadCount: 1, mutedUntil: NOW - 1 }),
      // Lapsing exactly now counts as lapsed.
      chat("tg:1:2", { unreadCount: 1, mutedUntil: NOW }),
      chat("tg:1:3", { unreadCount: 1, mutedUntil: NOW + 1 }),
    ];
    expect(guids(triage(chats, [], NOW).waiting)).toEqual(["tg:1:1", "tg:1:2"]);
    expect(guids(triage(chats, [], NOW + 1).waiting)).toEqual(["tg:1:1", "tg:1:2", "tg:1:3"]);
  });

  it("leaves other sources and unmuted chats as before", () => {
    const chats = [
      chat("iMessage;-;+4670", { unreadCount: 1 }),
      chat("sl:work:C1", { unreadCount: 3 }),
      chat("tg:1:1", { unreadCount: 1 }),
      chat("iMessage;-;+4671"),
      chat("sl:work:C2"),
    ];
    const { waiting, starred, recent } = triage(chats, ["sl:work:C2"], NOW);
    expect(guids(waiting)).toEqual(["iMessage;-;+4670", "sl:work:C1", "tg:1:1"]);
    expect(guids(starred)).toEqual(["sl:work:C2"]);
    expect(guids(recent)).toEqual(["iMessage;-;+4671"]);
  });

  it("reads the clock when no time is given", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const chats = [chat("tg:1:1", { unreadCount: 1, mutedUntil: NOW + 1_000 })];
    expect(triage(chats, []).waiting).toHaveLength(0);
    expect(isMuted(chats[0])).toBe(true);
    vi.setSystemTime(NOW + 1_000);
    expect(triage(chats, []).waiting).toHaveLength(1);
    expect(isMuted(chats[0])).toBe(false);
  });
});

describe("nextTriageChange", () => {
  it("is the earliest lapse among muted unread chats", () => {
    const chats = [
      chat("tg:1:1", { unreadCount: 1, mutedUntil: NOW + 5_000 }),
      chat("tg:1:2", { unreadCount: 1, mutedUntil: NOW + 2_000 }),
      // A read chat moves nowhere when its mute lapses.
      chat("tg:1:3", { mutedUntil: NOW + 1_000 }),
      // Already lapsed: already in the queue.
      chat("tg:1:4", { unreadCount: 1, mutedUntil: NOW - 1_000 }),
      chat("iMessage;-;+4670", { unreadCount: 1 }),
    ];
    expect(nextTriageChange(chats, NOW)).toBe(NOW + 2_000);
  });

  it("is Infinity when nothing is due", () => {
    expect(nextTriageChange([chat("tg:1:1", { unreadCount: 1 }), chat("sl:w:C1")], NOW)).toBe(
      Infinity
    );
    expect(nextTriageChange([], NOW)).toBe(Infinity);
  });
});

describe("the sidebar's network filter", () => {
  const chats = [
    chat("sl:w:C1", { displayName: "#general" }),
    chat("tg:1:55", { displayName: "Pontus", unreadCount: 2 }),
    chat("iMessage;-;+4670", { displayName: "Elin" }),
    chat("tg:1:56", { displayName: "Anna", unreadCount: 1, mutedUntil: NOW + 60_000 }),
  ];

  it("narrows to one source, and a search prefix overrides it", () => {
    expect(guids(filterChats(chats, "", "telegram"))).toEqual(["tg:1:55", "tg:1:56"]);
    expect(guids(filterChats(chats, "pon", "telegram"))).toEqual(["tg:1:55"]);
    // "slack:" asks for Slack whatever the chips say.
    expect(guids(filterChats(chats, "slack:", "telegram"))).toEqual(["sl:w:C1"]);
    expect(filterChats(chats, "", null)).toBe(chats);
  });

  it("lists the sources present in sidebar order, with what each has waiting", () => {
    // A muted unread chat is not waiting.
    expect(summarizeSources(chats, NOW)).toEqual([
      { source: "imessage", waiting: 0 },
      { source: "telegram", waiting: 1 },
      { source: "slack", waiting: 0 },
    ]);
  });

  it("drops a filter for a source with no chats left", () => {
    expect(activeSourceFilter(chats, "slack")).toBe("slack");
    expect(activeSourceFilter(chats, "irc")).toBeNull();
    expect(activeSourceFilter(chats, null)).toBeNull();
  });
});

describe("listedRecent", () => {
  const recent = [
    chat("sl:w:D1", { displayName: "Maja", slackSection: "DirectMessage", activityAt: 9 }),
    chat("tg:1:55", { activityAt: 8 }),
    chat("iMessage;-;+4670", { activityAt: 7 }),
    chat("sl:w:C1", { displayName: "#general", slackSection: "Public", activityAt: 6 }),
    chat("tg:1:56", { activityAt: 5 }),
  ];

  it("keeps recency by time", () => {
    expect(listedRecent(recent, "time", {}, [])).toBe(recent);
  });

  it("groups by network: iMessage, Telegram, Slack (channels first), IRC", () => {
    expect(guids(listedRecent(recent, "network", {}, []))).toEqual([
      "iMessage;-;+4670",
      "tg:1:55",
      "tg:1:56",
      "sl:w:C1",
      "sl:w:D1",
    ]);
  });

  it("leaves folded groups out, but never folds a lone group", () => {
    expect(guids(listedRecent(recent, "network", {}, ["telegram:1"]))).toEqual([
      "iMessage;-;+4670",
      "sl:w:C1",
      "sl:w:D1",
    ]);
    // With one network there is no header to unfold it from.
    const telegram = recent.filter((c) => c.guid.startsWith("tg:"));
    expect(guids(listedRecent(telegram, "network", {}, ["telegram:1"]))).toEqual(["tg:1:55", "tg:1:56"]);
  });
});
