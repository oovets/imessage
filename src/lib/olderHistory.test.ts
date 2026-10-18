// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getClient } from "@/api/clientFactory";
import { irc } from "@/irc/api";
import { sl } from "@/slack/api";
import { tg } from "@/telegram/api";
import { useAppStore } from "@/store/useAppStore";
import type { Chat, Message } from "@/types";
import { fetchOlderMessages, OLDER_PAGE_SIZE, provesHistoryStart } from "@/lib/olderHistory";
import { mergeChatThreads } from "@/lib/chatThreadMerge";

vi.mock("@/api/clientFactory", () => ({ getClient: vi.fn() }));
vi.mock("@/irc/api", () => ({ irc: { history: vi.fn() } }));
vi.mock("@/slack/api", () => ({ sl: { history: vi.fn() } }));
vi.mock("@/telegram/api", () => ({ tg: { messages: vi.fn() } }));

const T = Date.UTC(2026, 9, 1, 12, 0, 0);

function oldest(guid: string, chatGUID: string): Message {
  return {
    guid,
    text: "x",
    isFromMe: false,
    dateCreated: T,
    handle: null,
    attachments: [],
    associatedMessageGuid: "",
    associatedMessageType: "",
    chatGUID,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useAppStore.setState({ serverUrl: "http://s:1234", password: "pw" });
});

describe("fetchOlderMessages", () => {
  it("asks BlueBubbles for messages before the oldest", async () => {
    const getMessages = vi.fn().mockResolvedValue([]);
    vi.mocked(getClient).mockReturnValue({ getMessages } as never);
    const chat = "iMessage;-;+46700000000";
    await fetchOlderMessages(chat, oldest("abc", chat));
    expect(getMessages).toHaveBeenCalledWith(chat, OLDER_PAGE_SIZE, undefined, T);
  });

  it("pages Slack back from the oldest message's ts", async () => {
    vi.mocked(sl.history).mockResolvedValue([]);
    const chat = "sl:W1:C1";
    await fetchOlderMessages(chat, oldest("sl:W1:C1:1700000000.000200", chat));
    expect(sl.history).toHaveBeenCalledWith("W1", "C1", OLDER_PAGE_SIZE, "1700000000.000200");
  });

  it("pages Telegram back from the oldest message's date and id", async () => {
    vi.mocked(tg.messages).mockResolvedValue([]);
    const chat = "tg:1:42";
    await fetchOlderMessages(chat, oldest("tg:1:42:900", chat));
    expect(tg.messages).toHaveBeenCalledWith(
      1,
      42,
      { date: new Date(T).toISOString(), id: 900 },
      OLDER_PAGE_SIZE
    );
  });

  it("pages IRC back from the oldest message's time", async () => {
    vi.mocked(irc.history).mockResolvedValue([]);
    const chat = "irc:net:#rust";
    await fetchOlderMessages(chat, oldest("irc:net:#rust:abc", chat));
    expect(irc.history).toHaveBeenCalledWith("net", "#rust", OLDER_PAGE_SIZE, T);
  });
});

describe("provesHistoryStart", () => {
  const IMSG = "iMessage;-;+46700000000";
  const thread = (guid: string) =>
    ({ guid, displayName: "", chatIdentifier: guid, participants: [], lastMessage: null, unreadCount: 0 }) as Chat;

  it("proves nothing for iMessage before this session's chat list is merged", async () => {
    // A fresh module: no chat list merged yet, so a split pair would look
    // like one thread.
    vi.resetModules();
    const fresh = await import("@/lib/olderHistory");
    expect(fresh.provesHistoryStart(IMSG, 12, OLDER_PAGE_SIZE)).toBe(false);
    expect(fresh.provesHistoryStart("irc:net:#rust", 12, 100)).toBe(true);
  });

  it("reads a short or empty answer as the start from a one-thread iMessage chat and the IRC log", () => {
    mergeChatThreads([]);
    expect(provesHistoryStart(IMSG, 12, OLDER_PAGE_SIZE)).toBe(true);
    expect(provesHistoryStart(IMSG, 0, OLDER_PAGE_SIZE)).toBe(true);
    expect(provesHistoryStart("irc:net:#rust", 12, 100)).toBe(true);
    expect(provesHistoryStart(IMSG, OLDER_PAGE_SIZE, OLDER_PAGE_SIZE)).toBe(false);
  });

  it("proves nothing for a merged iMessage/SMS pair, whose fetch reads a failed thread as empty", () => {
    mergeChatThreads([thread(IMSG), thread("SMS;-;+46700000000")]);
    expect(provesHistoryStart(IMSG, 0, OLDER_PAGE_SIZE)).toBe(false);
    expect(provesHistoryStart(IMSG, 12, OLDER_PAGE_SIZE)).toBe(false);
    mergeChatThreads([]);
  });

  it("proves nothing for Slack or Telegram, not even with an empty page", () => {
    mergeChatThreads([]);
    // Both can answer short mid-history; telegram-core answers a failed
    // network backfill with an empty page.
    for (const chat of ["sl:work:C1", "tg:1:55"]) {
      expect(provesHistoryStart(chat, 12, OLDER_PAGE_SIZE)).toBe(false);
      expect(provesHistoryStart(chat, 0, OLDER_PAGE_SIZE)).toBe(false);
    }
  });
});
