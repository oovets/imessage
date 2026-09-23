// @vitest-environment jsdom
import { act, fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "@/store/useAppStore";
import { extractFirstUrl, fetchLinkPreview } from "@/lib/linkPreview";
import type { LinkPreview, Message } from "@/types";
import { MessageBubble } from "./MessageBubble";

// extractFirstUrl runs once per render of a bubble with text, so wrapping the
// real one counts renders; fetchLinkPreview is driven by each test.
vi.mock("@/lib/linkPreview", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/linkPreview")>();
  return { ...real, extractFirstUrl: vi.fn(), fetchLinkPreview: vi.fn() };
});
vi.mock("@/api/clientFactory", () => ({ getClient: vi.fn() }));

const URL_A = "https://example.com/a";

function msg(over: Partial<Message> = {}): Message {
  return {
    guid: "m1",
    text: "hello",
    isFromMe: false,
    dateCreated: Date.UTC(2026, 0, 2, 3, 4, 5),
    handle: null,
    attachments: [],
    associatedMessageGuid: "",
    associatedMessageType: "",
    chatGUID: "iMessage;-;+46700000000",
    ...over,
  };
}

function ready(url: string, title: string): LinkPreview {
  return {
    url,
    siteName: "example.com",
    title,
    description: "",
    image: "",
    favicon: "",
    status: "ready",
    fetchedAt: Date.now(),
  };
}

function rendersWith(text: string): number {
  return vi.mocked(extractFirstUrl).mock.calls.filter(([t]) => t === text).length;
}

beforeEach(async () => {
  const real = await vi.importActual<typeof import("@/lib/linkPreview")>("@/lib/linkPreview");
  vi.mocked(extractFirstUrl).mockReset().mockImplementation(real.extractFirstUrl);
  vi.mocked(fetchLinkPreview).mockReset().mockReturnValue(new Promise(() => {}));
  useAppStore.setState({
    serverUrl: "http://s:1234",
    password: "pw",
    superlightMode: false,
    linkPreviewsEnabled: true,
    linkPreviewCache: {},
  });
});

describe("MessageBubble dates", () => {
  it("titles the bubble with the full local date and time", () => {
    const m = msg();
    const { container } = render(<MessageBubble message={m} showSender={false} />);
    const bubble = container.querySelector("div.select-text")!;
    expect(bubble.getAttribute("title")).toBe(new Date(m.dateCreated).toLocaleString());
  });

  it("renders the time element only when given a label", () => {
    const m = msg();
    const { container, rerender } = render(<MessageBubble message={m} showSender={false} />);
    expect(container.querySelector("time")).toBeNull();

    rerender(<MessageBubble message={m} showSender={false} timeLabel="04:04" />);
    const time = container.querySelector("time")!;
    expect(time.textContent).toBe("04:04");
    expect(time.getAttribute("dateTime")).toBe(new Date(m.dateCreated).toISOString());
    expect(time.parentElement!.className).toContain("font-mono");
  });
});

describe("MessageBubble link previews", () => {
  it("re-renders only when its own preview entry changes", async () => {
    const plain = msg({ guid: "p", text: "hello" });
    const linked = msg({ guid: "l", text: `see ${URL_A}` });
    const view = render(
      <>
        <MessageBubble message={plain} showSender={false} />
        <MessageBubble message={linked} showSender={false} />
      </>
    );
    const plainBefore = rendersWith("hello");
    const linkedBefore = rendersWith(`see ${URL_A}`);

    // Another URL's preview landing touches neither bubble.
    act(() => useAppStore.getState().setLinkPreview("https://other.example/", ready("https://other.example/", "Other")));
    expect(rendersWith("hello")).toBe(plainBefore);
    expect(rendersWith(`see ${URL_A}`)).toBe(linkedBefore);

    // Its own entry re-renders the linked bubble, and only it.
    act(() => useAppStore.getState().setLinkPreview(URL_A, ready(URL_A, "Example A")));
    expect(rendersWith(`see ${URL_A}`)).toBeGreaterThan(linkedBefore);
    expect(rendersWith("hello")).toBe(plainBefore);
    expect(view.getByText("Example A")).toBeTruthy();
  });

  it("fetches a missing preview and stores the result", async () => {
    const preview = ready(URL_A, "Example A");
    vi.mocked(fetchLinkPreview).mockResolvedValue(preview);
    const view = render(<MessageBubble message={msg({ text: URL_A })} showSender={false} />);
    await act(async () => {});
    expect(fetchLinkPreview).toHaveBeenCalledWith(URL_A);
    expect(useAppStore.getState().linkPreviewCache[URL_A]).toBe(preview);
    expect(view.getByText("Example A")).toBeTruthy();
  });

  it("stores a shared in-flight result once for bubbles with the same URL", async () => {
    let resolve!: (p: LinkPreview) => void;
    const shared = new Promise<LinkPreview>((r) => (resolve = r));
    vi.mocked(fetchLinkPreview).mockReturnValue(shared);
    const realSet = useAppStore.getState().setLinkPreview;
    const setLinkPreview = vi.fn(realSet);
    useAppStore.setState({ setLinkPreview });

    const view = render(
      <>
        <MessageBubble message={msg({ guid: "a", text: `one ${URL_A}` })} showSender={false} />
        <MessageBubble message={msg({ guid: "b", text: `two ${URL_A}` })} showSender={false} />
      </>
    );
    expect(fetchLinkPreview).toHaveBeenCalledTimes(2);

    await act(async () => resolve(ready(URL_A, "Example A")));
    expect(setLinkPreview).toHaveBeenCalledTimes(1);
    expect(view.getAllByText("Example A")).toHaveLength(2);
    useAppStore.setState({ setLinkPreview: realSet });
  });

  it("skips previews in superlight mode or when disabled", () => {
    useAppStore.setState({ linkPreviewsEnabled: false });
    render(<MessageBubble message={msg({ text: URL_A })} showSender={false} />);
    useAppStore.setState({ linkPreviewsEnabled: true, superlightMode: true });
    render(<MessageBubble message={msg({ guid: "m2", text: URL_A })} showSender={false} />);
    expect(fetchLinkPreview).not.toHaveBeenCalled();
  });
});

describe("MessageBubble memo", () => {
  it("skips a parent re-render when its props are unchanged", () => {
    const m = msg({ text: "stable" });
    const onReply = () => {};
    const onReact = () => {};
    const reactions = ["❤️"];
    function Harness() {
      const [n, setN] = useState(0);
      const [message, setMessage] = useState(m);
      return (
        <>
          <button onClick={() => setN(n + 1)}>bump</button>
          <button onClick={() => setMessage({ ...m })}>replace</button>
          <MessageBubble
            message={message}
            showSender={false}
            reactions={reactions}
            onReply={onReply}
            onReact={onReact}
          />
        </>
      );
    }
    const view = render(<Harness />);
    const before = rendersWith("stable");

    fireEvent.click(view.getByText("bump"));
    expect(rendersWith("stable")).toBe(before);

    // A new message object (an edit, the server echo) does re-render.
    fireEvent.click(view.getByText("replace"));
    expect(rendersWith("stable")).toBe(before + 1);
  });
});
