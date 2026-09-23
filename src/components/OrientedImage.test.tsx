// @vitest-environment jsdom
import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: fetchMock }));

// jsdom has neither createImageBitmap nor a 2D canvas, so both are faked: a
// bitmap is just its size plus a closed flag, and drawing a closed one throws
// (as a detached ImageBitmap does in a real engine).
class FakeBitmap {
  closed = false;
  constructor(
    public width: number,
    public height: number,
    public kind: "full" | "thumb"
  ) {}
  close() {
    this.closed = true;
    this.width = 0;
    this.height = 0;
  }
}

type Draw = { canvas: HTMLCanvasElement; bitmap: FakeBitmap; args: number[] };
let draws: Draw[] = [];
let bitmaps: FakeBitmap[] = [];
// Decoded size per src (default: a landscape phone photo, downscaled 2x).
let sizes: Record<string, [number, number]> = {};
const blobSrc = new WeakMap<Blob, string>();

function okResponse(src: string) {
  const blob = new Blob([src]);
  blobSrc.set(blob, src);
  return { ok: true, status: 200, blob: async () => blob };
}

let OrientedImage: typeof import("./OrientedImage").OrientedImage;

beforeEach(async () => {
  draws = [];
  bitmaps = [];
  sizes = {};
  fetchMock.mockReset().mockImplementation(async (src: string) => okResponse(src));
  globalThis.createImageBitmap = vi.fn(async (source: unknown) => {
    const b =
      source instanceof Blob
        ? new FakeBitmap(...(sizes[blobSrc.get(source)!] ?? [1440, 960]), "full")
        : new FakeBitmap((source as HTMLCanvasElement).width, (source as HTMLCanvasElement).height, "thumb");
    bitmaps.push(b);
    return b as unknown as ImageBitmap;
  }) as unknown as typeof createImageBitmap;
  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement) {
    return {
      drawImage: (bitmap: FakeBitmap, ...args: number[]) => {
        if (bitmap.closed) throw new Error("drew a closed bitmap");
        draws.push({ canvas: this, bitmap, args });
      },
    };
  } as unknown as typeof HTMLCanvasElement.prototype.getContext;
  // Fresh module per test: the thumbnail cache is module-level.
  vi.resetModules();
  ({ OrientedImage } = await import("./OrientedImage"));
});

// A macrotask drains every pending microtask of the fake load pipeline.
const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

const canvasIn = (c: HTMLElement) => c.querySelector("canvas") as HTMLCanvasElement;

describe("OrientedImage", () => {
  it("draws the EXIF-oriented original downscaled to 720px wide", async () => {
    const { container } = render(<OrientedImage src="https://s/a.jpg" alt="a" className="x" />);
    await flush();
    const canvas = canvasIn(container);
    expect(canvas.width).toBe(720);
    expect(canvas.height).toBe(480);
    expect(canvas.className).toBe("x");
    expect(createImageBitmap).toHaveBeenCalledWith(expect.any(Blob), { imageOrientation: "from-image" });
    // The full-resolution decode is released once downscaled.
    expect(bitmaps.find((b) => b.kind === "full")?.closed).toBe(true);
    const onScreen = draws.filter((d) => d.canvas === canvas);
    expect(onScreen).toHaveLength(1);
    expect(onScreen[0].bitmap.kind).toBe("thumb");
  });

  it("paints a remount from cache synchronously, without fetching again", async () => {
    const first = render(<OrientedImage src="https://s/a.jpg" alt="a" />);
    await flush();
    first.unmount();

    const { container } = render(<OrientedImage src="https://s/a.jpg" alt="a" />);
    // No await: the layout effect already drew it before first paint.
    const canvas = canvasIn(container);
    expect(canvas.width).toBe(720);
    expect(canvas.height).toBe(480);
    expect(draws.some((d) => d.canvas === canvas)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("shares one fetch between concurrent mounts of the same src", async () => {
    const { container } = render(
      <>
        <OrientedImage src="https://s/a.jpg" alt="a" />
        <OrientedImage src="https://s/a.jpg" alt="a" />
      </>
    );
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const canvases = [...container.querySelectorAll("canvas")];
    expect(canvases).toHaveLength(2);
    for (const c of canvases) expect(c.width).toBe(720);
  });

  it("finishes and caches a load whose component unmounted mid-flight", async () => {
    const first = render(<OrientedImage src="https://s/a.jpg" alt="a" />);
    first.unmount();
    await flush();
    const { container } = render(<OrientedImage src="https://s/a.jpg" alt="a" />);
    expect(canvasIn(container).width).toBe(720);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to <img> on failure and retries on the next mount", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404, blob: async () => new Blob() });
    const first = render(<OrientedImage src="https://s/a.jpg" alt="a" className="x" />);
    await flush();
    const img = first.container.querySelector("img")!;
    expect(img.getAttribute("src")).toBe("https://s/a.jpg");
    expect(img.className).toBe("x");
    first.unmount();

    const { container } = render(<OrientedImage src="https://s/a.jpg" alt="a" />);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(canvasIn(container).width).toBe(720);
  });

  it("keeps small images at their own size", async () => {
    sizes["https://s/s.png"] = [300, 200];
    const { container } = render(<OrientedImage src="https://s/s.png" alt="s" />);
    await flush();
    const canvas = canvasIn(container);
    expect(canvas.width).toBe(300);
    expect(canvas.height).toBe(200);
  });

  it("evicts least-recently-used thumbnails past the pixel budget", async () => {
    // Two tall 720px-wide images of 8.64 MP each exceed the 16 MP budget.
    sizes["https://s/1"] = [720, 12000];
    sizes["https://s/2"] = [720, 12000];
    const one = render(<OrientedImage src="https://s/1" alt="1" />);
    await flush();
    const firstBitmap = draws[0].bitmap;
    expect(firstBitmap.closed).toBe(false); // cached, and still drawn
    const two = render(<OrientedImage src="https://s/2" alt="2" />);
    await flush();
    // The older one is closed on eviction; it was already copied into its canvas.
    expect(firstBitmap.closed).toBe(true);
    expect(canvasIn(one.container).width).toBe(720);
    one.unmount();
    two.unmount();

    // The newest is still cached; the evicted one loads again.
    render(<OrientedImage src="https://s/2" alt="2" />);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    render(<OrientedImage src="https://s/1" alt="1" />);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not draw a superseded src after the prop changes", async () => {
    let resolveOld!: (v: unknown) => void;
    fetchMock.mockImplementationOnce(() => new Promise((r) => (resolveOld = r)));
    sizes["https://s/new"] = [300, 200];
    const { container, rerender } = render(<OrientedImage src="https://s/old" alt="a" />);
    rerender(<OrientedImage src="https://s/new" alt="a" />);
    await flush();
    const canvas = canvasIn(container);
    expect(canvas.width).toBe(300);
    resolveOld(okResponse("https://s/old"));
    await flush();
    // The old load still finished (and is cached), but never touched this canvas.
    expect(canvas.width).toBe(300);
    expect(draws.filter((d) => d.canvas === canvas)).toHaveLength(1);
  });

  it("starts a fresh load instead of joining one stalled past the join window", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    onTestFinished(() => now.mockRestore());
    let resolveStalled!: (v: unknown) => void;
    fetchMock.mockImplementationOnce(() => new Promise((r) => (resolveStalled = r)));
    const stalled = render(<OrientedImage src="https://s/a.jpg" alt="a" />);
    await flush();
    stalled.unmount();

    // Within the window a remount joins the pending load…
    now.mockReturnValue(1_010_000);
    render(<OrientedImage src="https://s/a.jpg" alt="a" />).unmount();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // …past it, it retries, as every mount did before loads were shared.
    now.mockReturnValue(1_016_000);
    const retry = render(<OrientedImage src="https://s/a.jpg" alt="a" />);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(canvasIn(retry.container).width).toBe(720);
    const cached = draws[draws.length - 1].bitmap;

    // The stalled response finally arriving doesn't displace the cached thumb.
    resolveStalled(okResponse("https://s/a.jpg"));
    await flush();
    expect(bitmaps.filter((b) => b.kind === "thumb" && b !== cached).every((b) => b.closed)).toBe(true);
    retry.unmount();
    const { container } = render(<OrientedImage src="https://s/a.jpg" alt="a" />);
    expect(draws[draws.length - 1].bitmap).toBe(cached);
    expect(canvasIn(container).width).toBe(720);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
