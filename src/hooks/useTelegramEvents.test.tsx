// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { onTelegramEvent } from "@/telegram/api";
import type { TgChat, TgMessage } from "@/telegram/types";
import { useAppStore } from "@/store/useAppStore";
import { useTelegramEvents } from "./useTelegramEvents";

vi.mock("@/telegram/api", () => ({ onTelegramEvent: vi.fn() }));

const onTelegramEventMock = vi.mocked(onTelegramEvent);
let emit: (event: unknown) => void;

function tgChat(id: number, extra: Partial<TgChat> = {}): TgChat {
  return {
    account_id: 1,
    id,
    kind: "private",
    title: `Chat ${id}`,
    username: null,
    unread_count: 0,
    pinned: false,
    last_message_at: "2026-09-01T10:00:00Z",
    last_message_preview: "preview",
    avatar_key: null,
    ...extra,
  };
}

function tgMessage(chatId: number, id: number, extra: Partial<TgMessage> = {}): TgMessage {
  return {
    account_id: 1,
    chat_id: chatId,
    id,
    sender_id: 7,
    sender_name: "Anna",
    text: "hej",
    media: null,
    reactions: [],
    reply_to: null,
    date: "2026-09-01T10:00:00Z",
    edited: false,
    outgoing: false,
    send_state: "sent",
    ...extra,
  };
}

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
}

beforeEach(() => {
  vi.useFakeTimers();
  setVisibility("visible");
  onTelegramEventMock.mockImplementation(async (handler) => {
    emit = handler;
    return () => {};
  });
  useAppStore.setState({ chats: [], messages: {}, messageFetchedAt: {}, messageOrder: [] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useTelegramEvents chat_updated coalescing", () => {
  it("applies a burst of chat updates as one commit", () => {
    renderHook(() => useTelegramEvents());
    const listener = vi.fn();
    const unsubscribe = useAppStore.subscribe(listener);

    for (let id = 1; id <= 100; id++) emit({ kind: "chat_updated", chat: tgChat(id) });
    expect(useAppStore.getState().chats).toHaveLength(0);

    vi.advanceTimersByTime(16);
    expect(useAppStore.getState().chats).toHaveLength(100);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("applies held chat updates before any later event, keeping arrival order", () => {
    renderHook(() => useTelegramEvents());

    // A new message: Telegram sends chat_updated, then message_added.
    emit({
      kind: "chat_updated",
      chat: tgChat(5, { unread_count: 1, last_message_preview: "[photo]" }),
    });
    emit({ kind: "message_added", message: tgMessage(5, 9, { text: "caption" }) });

    // No timer needed: the message flushed the held update first, so the
    // message's text wins over the preview, exactly as when applied one by one.
    const chat = useAppStore.getState().chats.find((c) => c.guid === "tg:1:5");
    expect(chat?.unreadCount).toBe(1);
    expect(chat?.lastMessageText).toBe("caption");
    expect(useAppStore.getState().messages["tg:1:5"]).toHaveLength(1);
  });

  it("keeps the last update per chat", () => {
    renderHook(() => useTelegramEvents());
    emit({ kind: "chat_updated", chat: tgChat(1, { unread_count: 3 }) });
    emit({ kind: "chat_updated", chat: tgChat(1, { unread_count: 0 }) });
    vi.advanceTimersByTime(16);
    expect(useAppStore.getState().chats).toHaveLength(1);
    expect(useAppStore.getState().chats[0].unreadCount).toBe(0);
  });

  it("holds nothing while the window is hidden", () => {
    setVisibility("hidden");
    renderHook(() => useTelegramEvents());
    emit({ kind: "chat_updated", chat: tgChat(1, { unread_count: 2 }) });
    expect(useAppStore.getState().chats[0]?.unreadCount).toBe(2);
  });

  it("applies held updates when the window becomes hidden", () => {
    renderHook(() => useTelegramEvents());
    emit({ kind: "chat_updated", chat: tgChat(1) });
    setVisibility("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(useAppStore.getState().chats).toHaveLength(1);
  });

  it("applies held updates on unmount", () => {
    const { unmount } = renderHook(() => useTelegramEvents());
    emit({ kind: "chat_updated", chat: tgChat(1) });
    unmount();
    expect(useAppStore.getState().chats).toHaveLength(1);
  });
});
