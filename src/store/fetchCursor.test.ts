// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import type { Message } from "@/types";
import { useAppStore } from "./useAppStore";

const CHAT = "iMessage;-;+46701234567";

function message(guid: string, dateCreated: number, extra: Partial<Message> = {}): Message {
  return {
    guid,
    text: "hej",
    isFromMe: false,
    dateCreated,
    handle: null,
    attachments: [],
    associatedMessageGuid: "",
    associatedMessageType: "",
    chatGUID: CHAT,
    ...extra,
  };
}

beforeEach(() => {
  useAppStore.setState({ messages: {}, messageFetchedAt: {}, messageOrder: [], chats: [] });
});

describe("messageFetchedAt as the polling cursor", () => {
  it("advances on server-acknowledged messages", () => {
    useAppStore.getState().upsertMessage(message("srv-1", 1_000));
    expect(useAppStore.getState().messageFetchedAt[CHAT]).toBe(1_000);
  });

  it("is not advanced by an optimistic message stamped with a fast client clock", () => {
    // Regression: the cursor took the newest message outright, including
    // optimistic sends stamped with Date.now(). On a machine running ahead of
    // the server, `after=` jumped into the future and every message that
    // followed was hidden forever — and the cursor only ever moves forward.
    useAppStore.getState().upsertMessage(message("srv-1", 1_000));

    const anHourAhead = 1_000 + 3_600_000;
    useAppStore
      .getState()
      .upsertMessage(message("local-abc", anHourAhead, { isFromMe: true, pending: true }));

    expect(useAppStore.getState().messageFetchedAt[CHAT]).toBe(1_000);
  });

  it("advances once the server echo replaces the optimistic copy", () => {
    useAppStore
      .getState()
      .upsertMessage(message("local-abc", 5_000, { isFromMe: true, pending: true, tempGuid: "t1" }));
    expect(useAppStore.getState().messageFetchedAt[CHAT]).toBe(0);

    useAppStore
      .getState()
      .upsertMessage(message("srv-9", 5_000, { isFromMe: true, tempGuid: "t1" }));

    expect(useAppStore.getState().messageFetchedAt[CHAT]).toBe(5_000);
  });
});
