// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getClient } from "@/api/clientFactory";
import { trackHistoryFetch } from "@/lib/historyInFlight";
import { useAppStore } from "@/store/useAppStore";
import type { Message } from "@/types";
import { usePollingFallback } from "./usePollingFallback";

vi.mock("@/api/clientFactory", () => ({ getClient: vi.fn() }));
vi.mock("@/lib/desktopNotifications", () => ({ notifyIncomingMessage: vi.fn() }));

const CHAT = "iMessage;-;+46700000000";
const getMessages = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  getMessages.mockReset().mockResolvedValue([]);
  vi.mocked(getClient).mockReturnValue({ getMessages, getChats: vi.fn().mockResolvedValue([]) } as never);
  useAppStore.setState({
    serverUrl: "http://localhost:1234",
    password: "pw",
    isConfigured: true,
    pollingFallback: true,
    selectedChatGUID: CHAT,
    messageFetchedAt: {},
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("usePollingFallback message poll", () => {
  it("leaves a chat its pane is fetching to that fetch", async () => {
    // The pane that just opened the chat fetches its history.
    let finish!: (msgs: Message[]) => void;
    void trackHistoryFetch(CHAT, new Promise<Message[]>((resolve) => (finish = resolve)));

    renderHook(() => usePollingFallback());
    expect(getMessages).not.toHaveBeenCalled();

    // Once that fetch is done, the next tick polls as usual.
    finish([]);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(getMessages).toHaveBeenCalledTimes(1);
    expect(getMessages).toHaveBeenCalledWith(CHAT, 25, undefined);
  });

  it("polls a selected chat at once when nothing is fetching it", () => {
    // Selecting a chat that is already open in a pane: no pane fetches it.
    renderHook(() => usePollingFallback());
    expect(getMessages).toHaveBeenCalledTimes(1);
  });
});
