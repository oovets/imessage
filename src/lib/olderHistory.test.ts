// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getClient } from "@/api/clientFactory";
import { irc } from "@/irc/api";
import { sl } from "@/slack/api";
import { tg } from "@/telegram/api";
import { useAppStore } from "@/store/useAppStore";
import type { Message } from "@/types";
import { fetchOlderMessages, OLDER_PAGE_SIZE } from "@/lib/olderHistory";

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
