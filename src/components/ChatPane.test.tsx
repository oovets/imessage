// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getClient } from "@/api/clientFactory";
import { useAppStore } from "@/store/useAppStore";
import type { Message } from "@/types";
import { ChatPane } from "./ChatPane";

vi.mock("@/api/clientFactory", () => ({ getClient: vi.fn() }));
vi.mock("@/telegram/api", () => ({
  tg: { messages: vi.fn().mockResolvedValue([]), markRead: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock("./MessageList", () => ({ MessageList: () => null }));
vi.mock("./MessageInput", () => ({ MessageInput: () => null }));

const IMESSAGE = "iMessage;-;+46701234567";
const getMessages = vi.fn();

function cachedMessage(): Message {
  return {
    guid: "srv-1",
    text: "hej",
    isFromMe: false,
    dateCreated: 1_000,
    handle: null,
    attachments: [],
    associatedMessageGuid: "",
    associatedMessageType: "",
    chatGUID: IMESSAGE,
  };
}

function renderPane(chatGUID: string) {
  return render(
    <ChatPane paneId="p1" chatGUID={chatGUID} isActive canClose={false} />
  );
}

beforeEach(() => {
  getMessages.mockReset().mockResolvedValue([]);
  vi.mocked(getClient).mockReturnValue({ getMessages } as never);
  useAppStore.setState({
    serverUrl: "http://s:1234",
    password: "pw",
    isConfigured: true,
    chats: [
      {
        guid: IMESSAGE,
        displayName: "Test",
        chatIdentifier: IMESSAGE,
        participants: [],
        lastMessage: null,
        unreadCount: 0,
      },
    ],
    messages: { [IMESSAGE]: [cachedMessage()] },
    messageFetchedAt: { [IMESSAGE]: 1_000 },
    telegramReloadNonce: 0,
  });
});

describe("ChatPane message loading", () => {
  it("issues a single request when a cached chat has nothing new", async () => {
    // Regression: an empty delta — the normal "nothing new" answer — used to
    // trigger a second, full-window fetch, doubling every reopen.
    renderPane(IMESSAGE);

    await vi.waitFor(() => expect(getMessages).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));

    expect(getMessages).toHaveBeenCalledTimes(1);
    // …and it was the incremental one.
    expect(getMessages.mock.calls[0][2]).toBe(1_000);
  });

  it("does not refetch an iMessage pane when Telegram reloads", async () => {
    // Regression: telegramReloadNonce sat unconditionally in the effect's
    // dependency array, so every tg:ready re-ran the BlueBubbles fetch in every
    // open pane.
    renderPane(IMESSAGE);
    await vi.waitFor(() => expect(getMessages).toHaveBeenCalledTimes(1));

    useAppStore.setState({ telegramReloadNonce: 1 });
    await new Promise((r) => setTimeout(r, 20));

    expect(getMessages).toHaveBeenCalledTimes(1);
  });
});
