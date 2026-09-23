import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  tauri: true,
  invoke: vi.fn(),
  tauriFetch: vi.fn(),
}));

vi.mock("@/lib/tauriEnv", () => ({ isTauriRuntime: () => mocks.tauri }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mocks.invoke(...args),
}));
vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: (...args: unknown[]) => mocks.tauriFetch(...args),
}));

import { BlueBubblesClient } from "./client";

const SERVER = "https://bb.example.test:1234/";
const PASSWORD = "p@ss wörd!";
const ENDPOINT =
  "https://bb.example.test:1234/api/v1/message/attachment?guid=p%40ss%20w%C3%B6rd%21";

function client() {
  return new BlueBubblesClient(SERVER, PASSWORD);
}

function invokeCall() {
  expect(mocks.invoke).toHaveBeenCalledTimes(1);
  const [cmd, body, options] = mocks.invoke.mock.calls[0] as [
    string,
    unknown,
    { headers: Record<string, string> },
  ];
  const raw = options.headers["x-upload-meta"];
  return { cmd, body, raw, meta: JSON.parse(decodeURIComponent(raw)) };
}

describe("BlueBubblesClient.sendAttachment in the desktop shell", () => {
  const fetchSpy = vi.fn();

  beforeEach(() => {
    mocks.tauri = true;
    mocks.invoke.mockReset().mockResolvedValue(undefined);
    mocks.tauriFetch.mockReset();
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts the raw file bytes through bb_send_attachment, not the HTTP plugin", async () => {
    const file = new Blob([new Uint8Array([0xff, 0xd8, 0x00, 0x7f])], { type: "image/jpeg" });

    await client().sendAttachment("iMessage;-;+46701234567", file, "IMG_0001.jpg", "temp-1");

    const { cmd, body, meta } = invokeCall();
    expect(cmd).toBe("bb_send_attachment");
    expect(body).toBeInstanceOf(Uint8Array);
    expect(Array.from(body as Uint8Array)).toEqual([0xff, 0xd8, 0x00, 0x7f]);
    expect(meta).toEqual({
      url: ENDPOINT,
      chatGuid: "iMessage;-;+46701234567",
      tempGuid: "temp-1",
      name: "IMG_0001.jpg",
      mimeType: "image/jpeg",
    });
    expect(mocks.tauriFetch).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("defaults tempGuid to a fresh UUID and passes an untyped Blob's empty type", async () => {
    await client().sendAttachment("chat", new Blob([new Uint8Array([1])]), "upload");

    const { meta } = invokeCall();
    expect(meta.tempGuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    // Rust falls back to application/octet-stream, like FormData does.
    expect(meta.mimeType).toBe("");
  });

  it("keeps unicode names header-safe", async () => {
    const name = "Skärmavbild 2026-09-23 kl. 10.00.00 \"😀\".png";

    await client().sendAttachment("chat", new Blob([new Uint8Array([1])]), name);

    const { raw, meta } = invokeCall();
    expect(raw).toMatch(/^[\x21-\x7e]+$/);
    expect(meta.name).toBe(name);
  });

  it("rethrows the command's error string as an Error with the same text", async () => {
    mocks.invoke.mockRejectedValueOnce("sendAttachment failed: HTTP 500 - boom");

    const err = await client()
      .sendAttachment("chat", new Blob([new Uint8Array([1])]), "a.png")
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("sendAttachment failed: HTTP 500 - boom");
  });
});

describe("BlueBubblesClient.sendAttachment in the browser", () => {
  beforeEach(() => {
    mocks.tauri = false;
    mocks.invoke.mockReset();
    mocks.tauriFetch.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("still posts a FormData body with window.fetch", async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200, text: async () => "" }));
    vi.stubGlobal("fetch", fetchSpy);
    const file = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });

    await client().sendAttachment("iMessage;-;chat123", file, "shot.png", "temp-9");

    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(mocks.tauriFetch).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(ENDPOINT);
    expect(init.method).toBe("POST");
    const form = init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get("chatGuid")).toBe("iMessage;-;chat123");
    expect(form.get("tempGuid")).toBe("temp-9");
    expect(form.get("name")).toBe("shot.png");
    expect(form.get("method")).toBe("apple-script");
    const attachment = form.get("attachment") as File;
    expect(attachment.name).toBe("shot.png");
    expect(attachment.type).toBe("image/png");
    expect(Array.from(new Uint8Array(await attachment.arrayBuffer()))).toEqual([1, 2, 3]);
  });

  it("maps a non-2xx response to the usual error text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 413, text: async () => "x".repeat(300) })),
    );

    const err = await client()
      .sendAttachment("chat", new Blob([new Uint8Array([1])]), "a.png")
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe(`sendAttachment failed: HTTP 413 - ${"x".repeat(160)}`);
  });
});
