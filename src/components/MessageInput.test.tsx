// @vitest-environment jsdom
import { fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
