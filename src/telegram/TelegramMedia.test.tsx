// @vitest-environment jsdom
import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { Attachment } from "@/types";

const { mediaDataUrl, mediaFile } = vi.hoisted(() => ({
  mediaDataUrl: vi.fn(),
  mediaFile: vi.fn(),
}));
vi.mock("./api", () => ({ tg: { mediaDataUrl, mediaFile } }));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => `asset://${p}` }));

let TelegramMedia: typeof import("./TelegramMedia").TelegramMedia;

beforeEach(async () => {
  mediaDataUrl.mockReset().mockImplementation(async (_a, _c, m: number) => `data:image/jpeg;base64,${m}`);
  mediaFile.mockReset().mockImplementation(async (_a, _c, m: number) => `/tmp/${m}.mp4`);
  // Fresh module per test: the data-URL cache is module-level.
  vi.resetModules();
  ({ TelegramMedia } = await import("./TelegramMedia"));
});

const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

function att(messageId: number, type = "photo", mimeType = "image/jpeg"): Attachment {
  return {
    guid: `tgmedia:1:2:${messageId}:${type}:k${messageId}`,
    mimeType,
    transferName: `file-${messageId}`,
  } as Attachment;
}

describe("TelegramMedia", () => {
  it("renders a revisited photo from memory on the first render", async () => {
    const first = render(<TelegramMedia att={att(7)} />);
    expect(first.getByText("Loading media…")).toBeTruthy();
    await flush();
    expect(first.container.querySelector("img")?.getAttribute("src")).toBe("data:image/jpeg;base64,7");
    first.unmount();

    const { container, queryByText } = render(<TelegramMedia att={att(7)} />);
    // No flush: the cached URL is there before any effect runs.
    expect(queryByText("Loading media…")).toBeNull();
    expect(container.querySelector("img")?.getAttribute("src")).toBe("data:image/jpeg;base64,7");
    expect(mediaDataUrl).toHaveBeenCalledTimes(1);
    expect(mediaDataUrl).toHaveBeenCalledWith(1, 2, 7, "k7", "image/jpeg");
  });

  it("shares one request between two panes showing the same media", async () => {
    const { container } = render(
      <>
        <TelegramMedia att={att(7)} />
        <TelegramMedia att={att(7)} />
      </>
    );
    await flush();
    expect(mediaDataUrl).toHaveBeenCalledTimes(1);
    expect(container.querySelectorAll("img")).toHaveLength(2);
  });

  it("does not cache failures", async () => {
    mediaDataUrl.mockRejectedValueOnce(new Error("offline"));
    const first = render(<TelegramMedia att={att(7)} />);
    await flush();
    expect(first.getByText("⚠ media unavailable")).toBeTruthy();
    first.unmount();

    const { container } = render(<TelegramMedia att={att(7)} />);
    await flush();
    expect(mediaDataUrl).toHaveBeenCalledTimes(2);
    expect(container.querySelector("img")).toBeTruthy();
  });

  it("caches document hrefs too", async () => {
    mediaDataUrl.mockResolvedValue("data:application/pdf;base64,AA");
    const doc = att(9, "document", "application/pdf");
    const first = render(<TelegramMedia att={doc} />);
    await flush();
    first.unmount();
    const { container } = render(<TelegramMedia att={doc} />);
    const a = container.querySelector("a")!;
    expect(a.getAttribute("href")).toBe("data:application/pdf;base64,AA");
    expect(a.getAttribute("download")).toBe("file-9");
    expect(mediaDataUrl).toHaveBeenCalledTimes(1);
  });

  it("leaves videos on the streamed temp-file path, uncached", async () => {
    const video = att(5, "document", "video/mp4");
    const first = render(<TelegramMedia att={video} />);
    expect(first.getByText("Loading video…")).toBeTruthy();
    await flush();
    expect(first.container.querySelector("video")?.getAttribute("src")).toBe("asset:///tmp/5.mp4");
    first.unmount();
    render(<TelegramMedia att={video} />);
    await flush();
    expect(mediaFile).toHaveBeenCalledTimes(2);
    expect(mediaDataUrl).not.toHaveBeenCalled();
  });

  it("evicts least-recently-used entries past the size budget", async () => {
    // Two ~27M-char URLs exceed the 50 Mi-char budget together.
    const big = (m: number) => `data:image/jpeg;base64,${String(m).repeat(27_000_000)}`;
    mediaDataUrl.mockImplementation(async (_a, _c, m: number) => big(m));
    render(<TelegramMedia att={att(1)} />).unmount();
    await flush();
    render(<TelegramMedia att={att(2)} />).unmount();
    await flush();
    expect(mediaDataUrl).toHaveBeenCalledTimes(2);

    render(<TelegramMedia att={att(2)} />).unmount(); // still cached
    expect(mediaDataUrl).toHaveBeenCalledTimes(2);
    render(<TelegramMedia att={att(1)} />).unmount(); // evicted: fetched again
    await flush();
    expect(mediaDataUrl).toHaveBeenCalledTimes(3);
  });

  it("does not join a load stalled past the join window", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    onTestFinished(() => now.mockRestore());
    mediaDataUrl.mockImplementationOnce(() => new Promise(() => {}));
    render(<TelegramMedia att={att(7)} />).unmount();
    now.mockReturnValue(1_010_000);
    render(<TelegramMedia att={att(7)} />).unmount(); // joins the pending one
    expect(mediaDataUrl).toHaveBeenCalledTimes(1);

    now.mockReturnValue(1_016_000);
    const { container } = render(<TelegramMedia att={att(7)} />);
    await flush();
    expect(mediaDataUrl).toHaveBeenCalledTimes(2);
    expect(container.querySelector("img")?.getAttribute("src")).toBe("data:image/jpeg;base64,7");
  });
});
