// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SocketHandle, SocketHandlers } from "@/lib/wsTransport";
import { openSocket } from "@/lib/wsTransport";
import { useAppStore } from "@/store/useAppStore";
import { useWebSocket } from "./useWebSocket";

vi.mock("@/lib/wsTransport", () => ({ openSocket: vi.fn() }));
vi.mock("@/lib/desktopNotifications", () => ({ notifyIncomingMessage: vi.fn() }));

const openSocketMock = vi.mocked(openSocket);

/** Handles handed to the hook, one per connect attempt. */
let captured: SocketHandlers[] = [];
/** The handle we returned for each attempt, so we can assert it was closed. */
let handles: Array<SocketHandle & { close: ReturnType<typeof vi.fn> }> = [];

function makeHandle() {
  const handle = { send: vi.fn(), close: vi.fn() };
  handles.push(handle);
  return handle;
}

beforeEach(() => {
  captured = [];
  handles = [];
  vi.useFakeTimers();
  openSocketMock.mockImplementation(async (_url: string, handlers: SocketHandlers) => {
    captured.push(handlers);
    return makeHandle();
  });
  useAppStore.setState({
    serverUrl: "http://localhost:1234",
    password: "pw",
    isConfigured: true,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useWebSocket reconnect", () => {
  it("closes the dead socket before reconnecting", async () => {
    // Regression: scheduleReconnect used to drop the handle without close(),
    // and close() is the only path that unregisters the plugin listener and
    // tears down the Rust side. Every disconnect leaked one.
    renderHook(() => useWebSocket());
    await vi.waitFor(() => expect(handles).toHaveLength(1));

    // The server drops the connection (sleep/wake, wifi change, server flap).
    captured[0].onClose();

    expect(handles[0].close).toHaveBeenCalledTimes(1);
  });

  it("closes every dead socket across repeated disconnects", async () => {
    renderHook(() => useWebSocket());
    await vi.waitFor(() => expect(handles).toHaveLength(1));

    for (let i = 0; i < 3; i++) {
      captured[i].onClose();
      // Backoff is attempt * 2000ms; run it out so the next connect happens.
      await vi.advanceTimersByTimeAsync(31_000);
      await vi.waitFor(() => expect(handles).toHaveLength(i + 2));
    }

    // Every socket we handed out, except the currently live one, is closed.
    expect(handles.slice(0, 3).every((h) => h.close.mock.calls.length === 1)).toBe(true);
  });

  it("closes the socket when the effect tears down", async () => {
    const { unmount } = renderHook(() => useWebSocket());
    await vi.waitFor(() => expect(handles).toHaveLength(1));

    unmount();

    expect(handles[0].close).toHaveBeenCalled();
  });
});
