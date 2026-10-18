// @vitest-environment jsdom
import { fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "@/store/useAppStore";
import { tg } from "@/telegram/api";
import { MessageInput } from "./MessageInput";

const spy = vi.hoisted(() => ({ renders: 0 }));

// Called once per MessageInput render: counts them.
vi.mock("@/hooks/useEmojiAutocomplete", () => ({
  useEmojiAutocomplete: () => {
    spy.renders++;
    return {
      suggestions: [],
      activeIndex: 0,
      select: () => {},
      setActiveIndex: () => {},
      handleKeyDown: () => false,
      syncCaret: () => {},
    };
  },
  autoReplaceClosedShortcode: () => null,
}));
vi.mock("@/api/clientFactory", () => ({ getClient: vi.fn() }));
vi.mock("@/telegram/api", () => ({ tg: { sendMessage: vi.fn() } }));

const TG = "tg:1:42";

beforeEach(() => {
  spy.renders = 0;
});

describe("MessageInput memo", () => {
  it("skips a parent re-render with the same chat, and follows a chat change", () => {
    function Harness() {
      const [n, setN] = useState(0);
      return (
        <>
          <button onClick={() => setN(n + 1)}>bump</button>
          <MessageInput chatGUID={n > 1 ? "iMessage;-;b" : "iMessage;-;a"} />
        </>
      );
    }
    const view = render(<Harness />);
    const before = spy.renders;

    fireEvent.click(view.getByText("bump"));
    expect(spy.renders).toBe(before);

    fireEvent.click(view.getByText("bump"));
    expect(spy.renders).toBe(before + 1);
  });
});

describe("MessageInput failed sends", () => {
  function typeAndSend(box: HTMLTextAreaElement, text: string) {
    fireEvent.change(box, { target: { value: text } });
    fireEvent.keyDown(box, { key: "Enter" });
  }

  beforeEach(() => {
    useAppStore.setState({ connectionNotice: null, replyTarget: {} });
  });

  it("puts the text back when a Telegram send fails", async () => {
    vi.mocked(tg.sendMessage).mockRejectedValueOnce(new Error("FLOOD_WAIT"));
    const view = render(<MessageInput chatGUID={TG} />);
    const box = view.getByPlaceholderText("Reply…") as HTMLTextAreaElement;

    typeAndSend(box, "hej");
    expect(box.value).toBe("");

    await vi.waitFor(() => expect(box.value).toBe("hej"));
    expect(useAppStore.getState().connectionNotice).toBe("Unable to send message: FLOOD_WAIT");
  });

  it("keeps what was typed since, instead of the failed text", async () => {
    let fail!: (e: Error) => void;
    vi.mocked(tg.sendMessage).mockReturnValueOnce(
      new Promise((_, reject) => {
        fail = reject;
      })
    );
    const view = render(<MessageInput chatGUID={TG} />);
    const box = view.getByPlaceholderText("Reply…") as HTMLTextAreaElement;

    typeAndSend(box, "first");
    fireEvent.change(box, { target: { value: "second" } });
    fail(new Error("nope"));

    await vi.waitFor(() =>
      expect(useAppStore.getState().connectionNotice).toBe("Unable to send message: nope")
    );
    expect(box.value).toBe("second");
  });
});
