import { describe, expect, it } from "vitest";
import {
  accountOfGuid,
  fallbackAccountLabel,
  groupChatsByAccount,
  IMESSAGE_ACCOUNT_KEY,
} from "./accounts";
import type { Chat } from "@/types";

const chat = (guid: string, unreadCount = 0): Chat =>
  ({ guid, displayName: guid, unreadCount }) as Chat;

describe("accountOfGuid", () => {
  it("treats every unprefixed guid as the single iMessage account", () => {
    expect(accountOfGuid("iMessage;-;+46701234567")).toEqual({
      source: "imessage",
      id: "",
      key: IMESSAGE_ACCOUNT_KEY,
    });
  });

  it("reads the account id out of a Telegram guid", () => {
    expect(accountOfGuid("tg:7:-100123")).toMatchObject({
      source: "telegram",
      id: "7",
      key: "telegram:7",
    });
  });

  it("reads the workspace out of a Slack guid", () => {
    expect(accountOfGuid("sl:work:C123")).toMatchObject({
      source: "slack",
      id: "work",
      key: "slack:work",
    });
  });
});

describe("groupChatsByAccount", () => {
  it("splits sources and workspaces apart, keeping incoming order per group", () => {
    const groups = groupChatsByAccount(
      [
        chat("sl:work:C1"),
        chat("iMessage;-;+4670"),
        chat("sl:mirkk:C9"),
        chat("sl:work:C2"),
        chat("tg:1:55"),
      ],
      { "slack:work": "Work", "slack:mirkk": "Mirkk", "telegram:1": "Stefan" }
    );

    // iMessage, then Telegram, then Slack alphabetically.
    expect(groups.map((g) => g.label)).toEqual([
      "iMessage",
      "Stefan",
      "Mirkk",
      "Work",
    ]);
    expect(groups[3].chats.map((c) => c.guid)).toEqual([
      "sl:work:C1",
      "sl:work:C2",
    ]);
  });

  it("sums unread per group so a collapsed group still shows a badge", () => {
    const groups = groupChatsByAccount(
      [chat("sl:work:C1", 3), chat("sl:work:C2", 4), chat("tg:1:9", 1)],
      {}
    );
    expect(groups.find((g) => g.ref.key === "slack:work")?.unread).toBe(7);
  });

  it("falls back to the workspace id before its name has loaded", () => {
    expect(fallbackAccountLabel(accountOfGuid("sl:mirkk:C1"))).toBe("mirkk");
    const [group] = groupChatsByAccount([chat("sl:mirkk:C1")], {});
    expect(group.label).toBe("mirkk");
  });
});
