import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { tg } from "./api";

/** The single tg_send_file call: [cmd, body, options]. */
function sentCall() {
  expect(invoke).toHaveBeenCalledTimes(1);
  const [cmd, body, options] = invoke.mock.calls[0] as [
    string,
    unknown,
    { headers: Record<string, string> },
  ];
  return { cmd, body, headers: options.headers };
}

function decodeMeta(headers: Record<string, string>) {
  return JSON.parse(decodeURIComponent(headers["x-upload-meta"]));
}

describe("tg.sendFile", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue({ id: 7 });
  });

  it("sends the bytes as the raw IPC body, never inside a JSON args object", async () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0x00, 0x42]);

    const result = await tg.sendFile(1001, -1002003, "photo.jpg", bytes, "hej");

    expect(result).toEqual({ id: 7 });
    const { cmd, body, headers } = sentCall();
    expect(cmd).toBe("tg_send_file");
    // The very same Uint8Array: the IPC layer posts it as-is (octet-stream)
    // instead of JSON-serializing it into a number array.
    expect(body).toBe(bytes);
    expect(decodeMeta(headers)).toEqual({
      accountId: 1001,
      chatId: -1002003,
      fileName: "photo.jpg",
      caption: "hej",
    });
  });

  it("keeps the caption semantics: omitted is null, empty stays empty", async () => {
    await tg.sendFile(1, 2, "a.png", new Uint8Array());
    expect(decodeMeta(sentCall().headers).caption).toBeNull();

    invoke.mockClear();
    await tg.sendFile(1, 2, "a.png", new Uint8Array(), "");
    expect(decodeMeta(sentCall().headers).caption).toBe("");
  });

  it("carries long unicode captions and names as a header-safe ASCII value", async () => {
    const caption = "Skärgården 🌊 \"citat\"\nrad två — ".repeat(200);
    const fileName = "Skärmavbild 2026-09-23 kl. 10.00.00 (😀).png";

    await tg.sendFile(1, 2, fileName, new Uint8Array([1]), caption);

    const raw = sentCall().headers["x-upload-meta"];
    // Only visible ASCII: valid in a fetch header and in Rust's HeaderValue.
    expect(raw).toMatch(/^[\x21-\x7e]+$/);
    expect(decodeMeta({ "x-upload-meta": raw })).toMatchObject({ fileName, caption });
  });

  it("propagates backend errors unchanged", async () => {
    invoke.mockRejectedValueOnce("Telegram is not ready");
    await expect(tg.sendFile(1, 2, "a.png", new Uint8Array([1]))).rejects.toBe(
      "Telegram is not ready",
    );
  });
});
