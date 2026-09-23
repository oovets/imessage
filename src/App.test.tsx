// @vitest-environment jsdom
import { useEffect } from "react";
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "@/store/useAppStore";
import App from "./App";

// Mount/unmount bookkeeping for the two layouts App can render.
const mounts = { board: 0, boardUnmounts: 0, mobile: 0, mobileUnmounts: 0 };
const mobileChats: Array<string | null> = [];
const lastMobileChat = () => mobileChats[mobileChats.length - 1];

vi.mock("@/components/PaneTree", () => ({
  PaneTreeRoot: () => {
    useEffect(() => {
      mounts.board++;
      return () => {
        mounts.boardUnmounts++;
      };
    }, []);
    return <div data-testid="board" />;
  },
}));
vi.mock("@/components/ChatPane", () => ({
  ChatPane: (props: { chatGUID: string | null; paneId: string }) => {
    useEffect(() => {
      mounts.mobile++;
      return () => {
        mounts.mobileUnmounts++;
      };
    }, []);
    mobileChats.push(props.chatGUID);
    return <div data-testid="mobile-pane" data-pane={props.paneId} />;
  },
}));
vi.mock("@/components/ChatList", () => ({ ChatList: () => null }));
const toolbarRenders = { count: 0 };
vi.mock("@/components/Toolbar", () => ({
  Toolbar: () => {
    toolbarRenders.count++;
    return null;
  },
}));
vi.mock("@/components/ImageContextMenu", () => ({ ImageContextMenu: () => null }));
vi.mock("@/components/OnboardingWizard", () => ({ OnboardingWizard: () => null }));
vi.mock("@/components/ThemeProvider", () => ({ useTheme: () => ({ resolved: "light" }) }));
vi.mock("@/lib/aiTracing", () => ({ configureTracing: () => {} }));
vi.mock("@/hooks/useWebSocket", () => ({ useWebSocket: () => {} }));
vi.mock("@/hooks/usePollingFallback", () => ({ usePollingFallback: () => {} }));
vi.mock("@/hooks/useDesktopFeatures", () => ({ useDesktopFeatures: () => {} }));
vi.mock("@/hooks/useTelegramInbox", () => ({ useTelegramInbox: () => {} }));
vi.mock("@/hooks/useTelegramEvents", () => ({ useTelegramEvents: () => {} }));
vi.mock("@/hooks/useSlackInbox", () => ({ useSlackInbox: () => {} }));
vi.mock("@/hooks/useSlackEvents", () => ({ useSlackEvents: () => {} }));
vi.mock("@/hooks/useAiAutoReply", () => ({ useAiAutoReply: () => {} }));

type Listener = () => void;

/** A controllable matchMedia for the md breakpoint. */
function installMatchMedia(initial: boolean) {
  let matches = initial;
  const listeners = new Set<Listener>();
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (q: string) => ({
      get matches() {
        return q === "(min-width: 768px)" ? matches : false;
      },
      media: q,
      addEventListener: (_type: string, cb: Listener) => listeners.add(cb),
      removeEventListener: (_type: string, cb: Listener) => listeners.delete(cb),
    }),
  });
  return {
    resize(wide: boolean) {
      matches = wide;
      listeners.forEach((cb) => cb());
    },
  };
}

const CHAT = "iMessage;-;+4670";

beforeEach(() => {
  mounts.board = mounts.boardUnmounts = mounts.mobile = mounts.mobileUnmounts = 0;
  mobileChats.length = 0;
  useAppStore.setState({
    configLoaded: true,
    paneTree: {
      type: "split",
      id: "s1",
      direction: "horizontal",
      children: [
        { type: "leaf", id: "p1", chatGUID: CHAT },
        { type: "leaf", id: "p2", chatGUID: null },
      ],
    },
    activePaneId: "p1",
    selectedChatGUID: CHAT,
  });
});

afterEach(() => {
  delete (window as { matchMedia?: unknown }).matchMedia;
});

describe("App layout by breakpoint", () => {
  it("never mounts the hidden mobile pane at desktop widths", () => {
    installMatchMedia(true);
    const { queryByTestId } = render(<App />);
    expect(queryByTestId("board")).toBeTruthy();
    expect(queryByTestId("mobile-pane")).toBeNull();
    // Not even for one commit: the first render already knew the width.
    expect(mounts.mobile).toBe(0);

    // Pane activity on the board doesn't bring it back.
    act(() => useAppStore.setState({ activePaneId: "p2", selectedChatGUID: null }));
    expect(mounts.mobile).toBe(0);
  });

  it("treats a runtime without matchMedia as desktop", () => {
    const { queryByTestId } = render(<App />);
    expect(queryByTestId("board")).toBeTruthy();
    expect(mounts.mobile).toBe(0);
  });

  it("mounts the single mobile pane for the active chat below md", () => {
    installMatchMedia(false);
    const { getByTestId } = render(<App />);
    expect(getByTestId("mobile-pane").dataset.pane).toBe("p1");
    expect(lastMobileChat()).toBe(CHAT);
    // The board stays mounted too (hidden by CSS): it owns the shortcuts.
    expect(mounts.board).toBe(1);

    act(() => useAppStore.setState({ activePaneId: "p2", selectedChatGUID: null }));
    expect(getByTestId("mobile-pane").dataset.pane).toBe("p2");
    expect(lastMobileChat()).toBeNull();
  });

  it("mounts the mobile pane on the first narrow crossing and keeps it, like before", () => {
    const mm = installMatchMedia(true);
    const { queryByTestId, getByTestId } = render(<App />);
    expect(queryByTestId("mobile-pane")).toBeNull();

    act(() => mm.resize(false));
    expect(queryByTestId("mobile-pane")).toBeTruthy();
    expect(lastMobileChat()).toBe(CHAT);

    // Wide again: the same instance stays (hidden by md:hidden), so its
    // unsent draft survives a resize round trip, and it still follows the
    // active pane.
    act(() => mm.resize(true));
    expect(queryByTestId("mobile-pane")).toBeTruthy();
    act(() => useAppStore.setState({ activePaneId: "p2", selectedChatGUID: null }));
    expect(getByTestId("mobile-pane").dataset.pane).toBe("p2");
    act(() => mm.resize(false));
    expect(mounts.mobile).toBe(1);
    expect(mounts.mobileUnmounts).toBe(0);

    expect(mounts.board).toBe(1);
    expect(mounts.boardUnmounts).toBe(0);
  });

  it("doesn't re-render the shell on desktop for a pane change that keeps the selection", () => {
    installMatchMedia(true);
    render(<App />);
    const before = toolbarRenders.count;
    // Filling the other, inactive pane: selectedChatGUID is unchanged.
    act(() =>
      useAppStore.setState({
        paneTree: {
          type: "split",
          id: "s1",
          direction: "horizontal",
          children: [
            { type: "leaf", id: "p1", chatGUID: CHAT },
            { type: "leaf", id: "p2", chatGUID: "tg:1:55" },
          ],
        },
      })
    );
    expect(toolbarRenders.count).toBe(before);
    expect(mounts.mobile).toBe(0);
  });
});
