import { describe, expect, it } from "vitest";
import { accountOfGuid } from "@/lib/accounts";
import { triage } from "@/lib/triage";
import {
  IRC_CHANNEL_MUTE,
  ircBufferToChat,
  ircEscapeCommands,
  ircMessageGuid,
  ircMessageToMessage,
  parseIrcChatGuid,
} from "./adapters";
import type { IrcBuffer, IrcMessage } from "./types";

function buffer(extra: Partial<IrcBuffer> = {}): IrcBuffer {
  return {
    id: "#rust",
    name: "#Rust",
    kind: "Channel",
    topic: null,
    last_ts: 1_700_000_000_000,
    last_text: "hi",
    ...extra,
  };
}

function message(extra: Partial<IrcMessage> = {}): IrcMessage {
  return {
    id: "abc",
    ts: 1_700_000_000_000,
    from: "anna",
    text: "hej",
    kind: "Privmsg",
    is_self: false,
    highlight: false,
    ...extra,
  };
}

describe("irc adapters", () => {
  it("namespaces chats per network and round-trips the guid", () => {
    const chat = ircBufferToChat("irccloud", buffer());
    expect(chat.guid).toBe("irc:irccloud:#rust");
    expect(chat.displayName).toBe("#Rust");
    expect(chat.activityAt).toBe(1_700_000_000_000);
    expect(chat.lastMessageText).toBe("hi");
    expect(parseIrcChatGuid(chat.guid)).toEqual({ networkId: "irccloud", bufferId: "#rust" });
    expect(accountOfGuid(chat.guid)).toMatchObject({ source: "irc", id: "irccloud" });
  });

  it("keeps message guids splittable when a server msgid has colons", () => {
    const guid = ircMessageGuid("net", "#rust", "a:b:c");
    expect(guid.split(":")).toHaveLength(4);
    expect(parseIrcChatGuid(guid)).toEqual({ networkId: "net", bufferId: "#rust" });
  });

  it("renders actions and notices the IRC way", () => {
    expect(ircMessageToMessage("n", "#rust", message({ kind: "Action", text: "waves" })).text).toBe(
      "* anna waves"
    );
    expect(ircMessageToMessage("n", "#rust", message({ kind: "Notice", text: "psst" })).text).toBe(
      "-anna- psst"
    );
  });

  it("marks our own messages and names other senders", () => {
    const mine = ircMessageToMessage("n", "#rust", message({ is_self: true, from: "me" }));
    expect(mine.isFromMe).toBe(true);
    expect(mine.handle).toBeNull();
    const theirs = ircMessageToMessage("n", "#rust", message());
    expect(theirs.handle).toEqual({ address: "anna", firstName: "anna" });
    expect(theirs.chatGUID).toBe("irc:n:#rust");
  });

  it("keeps unread channels out of Waiting on you, but not queries", () => {
    const channel = { ...ircBufferToChat("n", buffer()), unreadCount: 12 };
    const query = {
      ...ircBufferToChat("n", buffer({ id: "anna", name: "Anna", kind: "Query" })),
      unreadCount: 1,
    };
    expect(channel.mutedUntil).toBe(IRC_CHANNEL_MUTE);
    expect(query.mutedUntil).toBeUndefined();
    const { waiting, recent } = triage([channel, query], []);
    expect(waiting.map((c) => c.guid)).toEqual(["irc:n:anna"]);
    expect(recent.map((c) => c.guid)).toEqual(["irc:n:#rust"]);
  });

  it("escapes lines that would be read as commands", () => {
    expect(ircEscapeCommands("/shrug\nok\n/me no")).toBe("//shrug\nok\n//me no");
    expect(ircEscapeCommands("plain")).toBe("plain");
  });
});
