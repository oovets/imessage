// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { fetchLinkPreview } from "./linkPreview";

vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));
vi.mock("@/lib/tauriEnv", () => ({ isTauriRuntime: () => true }));

const URL_A = "https://example.com/a";

function htmlResponse(title: string) {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "text/html" }),
    text: async () => `<html><head><meta property="og:title" content="${title}"></head></html>`,
  } as unknown as Response;
}

/** A tauriFetch that stays pending until the test releases it. */
function deferredFetch() {
  let release!: (r: Response) => void;
  let fail!: (e: unknown) => void;
  vi.mocked(tauriFetch).mockReturnValueOnce(
    new Promise<Response>((res, rej) => {
      release = res;
      fail = rej;
    })
  );
  return { release: (r: Response) => release(r), fail: (e: unknown) => fail(e) };
}

beforeEach(() => {
  vi.mocked(tauriFetch).mockReset();
});

describe("fetchLinkPreview", () => {
  it("shares one request between concurrent callers for the same URL", async () => {
    const pending = deferredFetch();
    const first = fetchLinkPreview(URL_A);
    const second = fetchLinkPreview(URL_A);
    expect(second).toBe(first);

    pending.release(htmlResponse("Example A"));
    const [a, b] = await Promise.all([first, second]);
    expect(tauriFetch).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(a).toMatchObject({ url: URL_A, title: "Example A", status: "ready" });
  });

  it("fetches again once the earlier request has settled", async () => {
    vi.mocked(tauriFetch).mockResolvedValueOnce(htmlResponse("One"));
    const one = await fetchLinkPreview(URL_A);
    vi.mocked(tauriFetch).mockResolvedValueOnce(htmlResponse("Two"));
    const two = await fetchLinkPreview(URL_A);
    expect(tauriFetch).toHaveBeenCalledTimes(2);
    expect(one.title).toBe("One");
    expect(two.title).toBe("Two");
  });

  it("keeps different URLs independent", async () => {
    const a = deferredFetch();
    const b = deferredFetch();
    const pa = fetchLinkPreview(URL_A);
    const pb = fetchLinkPreview("https://example.com/b");
    expect(pb).not.toBe(pa);
    b.release(htmlResponse("B"));
    a.release(htmlResponse("A"));
    expect((await pa).title).toBe("A");
    expect((await pb).title).toBe("B");
    expect(tauriFetch).toHaveBeenCalledTimes(2);
  });

  it("shares a failure too, then lets a retry through", async () => {
    const pending = deferredFetch();
    const first = fetchLinkPreview(URL_A);
    const second = fetchLinkPreview(URL_A);
    pending.fail(new Error("offline"));
    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(b);
    expect(a).toMatchObject({ status: "failed", error: "Error: offline" });

    vi.mocked(tauriFetch).mockResolvedValueOnce(htmlResponse("Back"));
    expect((await fetchLinkPreview(URL_A)).title).toBe("Back");
  });
});
