// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";

const { avatarDataUrl, userAvatarDataUrl } = vi.hoisted(() => ({
  avatarDataUrl: vi.fn(),
  userAvatarDataUrl: vi.fn(),
}));
vi.mock("./api", () => ({ tg: { avatarDataUrl, userAvatarDataUrl } }));

type Hooks = typeof import("./useTelegramAvatar");
let useTelegramAvatar: Hooks["useTelegramAvatar"];
let useTelegramSenderAvatar: Hooks["useTelegramSenderAvatar"];
let useAppStore: typeof import("@/store/useAppStore").useAppStore;

beforeEach(async () => {
  avatarDataUrl.mockReset().mockImplementation(async (_a, c: number) => `data:image/jpeg;base64,c${c}`);
  userAvatarDataUrl.mockReset().mockImplementation(async (_a, u: number) => `data:image/jpeg;base64,u${u}`);
  // Fresh modules per test: the avatar cache is module-level. The store is
  // re-imported too so the test drives the same instance the hooks read.
  vi.resetModules();
  ({ useTelegramAvatar, useTelegramSenderAvatar } = await import("./useTelegramAvatar"));
  ({ useAppStore } = await import("@/store/useAppStore"));
  useAppStore.setState({ showAvatars: true, telegramAvailable: true });
});

const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

describe("useTelegramAvatar", () => {
  it("waits for the Telegram core and loads once it becomes available", async () => {
    useAppStore.setState({ telegramAvailable: false });
    const { result } = renderHook(() => useTelegramAvatar("tg:1:55"));
    await flush();
    expect(avatarDataUrl).not.toHaveBeenCalled();
    expect(result.current).toBeNull();

    act(() => useAppStore.setState({ telegramAvailable: true }));
    await flush();
    expect(avatarDataUrl).toHaveBeenCalledWith(1, 55);
    expect(result.current).toBe("data:image/jpeg;base64,c55");
  });

  it("does not cache a failure as 'no photo'", async () => {
    avatarDataUrl.mockRejectedValueOnce("Telegram is not ready");
    const first = renderHook(() => useTelegramAvatar("tg:1:55"));
    await flush();
    expect(first.result.current).toBeNull();
    first.unmount();

    const { result } = renderHook(() => useTelegramAvatar("tg:1:55"));
    await flush();
    expect(avatarDataUrl).toHaveBeenCalledTimes(2);
    expect(result.current).toBe("data:image/jpeg;base64,c55");
  });

  it("backs off a real failure instead of retrying it on every remount", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    onTestFinished(() => now.mockRestore());
    avatarDataUrl.mockRejectedValue("CHANNEL_INVALID");
    const mountOnce = async () => {
      renderHook(() => useTelegramAvatar("tg:1:55")).unmount();
      await flush();
    };
    await mountOnce();
    expect(avatarDataUrl).toHaveBeenCalledTimes(1);
    await mountOnce(); // e.g. clearing the search remounts every row
    expect(avatarDataUrl).toHaveBeenCalledTimes(1);

    now.mockReturnValue(1_002_000); // 2s backoff passed: retried, fails again
    await mountOnce();
    expect(avatarDataUrl).toHaveBeenCalledTimes(2);
    now.mockReturnValue(1_005_000); // now 4s from the second failure
    await mountOnce();
    expect(avatarDataUrl).toHaveBeenCalledTimes(2);

    avatarDataUrl.mockResolvedValue("data:image/jpeg;base64,c55");
    now.mockReturnValue(1_006_000);
    const { result } = renderHook(() => useTelegramAvatar("tg:1:55"));
    await flush();
    expect(avatarDataUrl).toHaveBeenCalledTimes(3);
    expect(result.current).toBe("data:image/jpeg;base64,c55");
  });

  it("does not join a lookup stalled past the join window", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    onTestFinished(() => now.mockRestore());
    avatarDataUrl.mockImplementationOnce(() => new Promise(() => {}));
    renderHook(() => useTelegramAvatar("tg:1:55")).unmount();
    now.mockReturnValue(1_016_000);
    const { result } = renderHook(() => useTelegramAvatar("tg:1:55"));
    await flush();
    expect(avatarDataUrl).toHaveBeenCalledTimes(2);
    expect(result.current).toBe("data:image/jpeg;base64,c55");
  });

  it("caches a successful 'no photo'", async () => {
    avatarDataUrl.mockResolvedValue(null);
    renderHook(() => useTelegramAvatar("tg:1:55")).unmount();
    await flush();
    const { result } = renderHook(() => useTelegramAvatar("tg:1:55"));
    await flush();
    expect(result.current).toBeNull();
    expect(avatarDataUrl).toHaveBeenCalledTimes(1);
  });

  it("shares one request between concurrent tiles", async () => {
    const a = renderHook(() => useTelegramAvatar("tg:1:55"));
    const b = renderHook(() => useTelegramAvatar("tg:1:55"));
    await flush();
    expect(avatarDataUrl).toHaveBeenCalledTimes(1);
    expect(a.result.current).toBe("data:image/jpeg;base64,c55");
    expect(b.result.current).toBe("data:image/jpeg;base64,c55");
  });

  it("ignores non-Telegram chats", async () => {
    const { result } = renderHook(() => useTelegramAvatar("iMessage;-;+4670"));
    await flush();
    expect(result.current).toBeNull();
    expect(avatarDataUrl).not.toHaveBeenCalled();
  });
});

describe("useTelegramSenderAvatar", () => {
  it("retries after a failure and waits for the core", async () => {
    useAppStore.setState({ telegramAvailable: false });
    userAvatarDataUrl.mockRejectedValueOnce("Telegram is not ready");
    const { result } = renderHook(() => useTelegramSenderAvatar("tg:1:55", "42"));
    await flush();
    expect(userAvatarDataUrl).not.toHaveBeenCalled();

    act(() => useAppStore.setState({ telegramAvailable: true }));
    await flush();
    expect(userAvatarDataUrl).toHaveBeenCalledTimes(1);
    expect(result.current).toBeNull();

    const again = renderHook(() => useTelegramSenderAvatar("tg:1:55", "42"));
    await flush();
    expect(userAvatarDataUrl).toHaveBeenCalledTimes(2);
    expect(userAvatarDataUrl).toHaveBeenLastCalledWith(1, 42);
    expect(again.result.current).toBe("data:image/jpeg;base64,u42");
  });
});
