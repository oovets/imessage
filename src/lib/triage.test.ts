import { afterEach, describe, expect, it, vi } from "vitest";
import type { Chat } from "@/types";
import { isMuted, nextTriageChange, triage } from "./triage";

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
