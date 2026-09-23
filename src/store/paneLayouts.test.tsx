// @vitest-environment jsdom
import { act, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PaneTreeRoot } from "@/components/PaneTree";
import { useAppStore, type PaneNode } from "./useAppStore";

const renders = new Map<string, number>();

vi.mock("@/components/ChatPane", () => ({
  ChatPane: ({ paneId }: { paneId: string }) => {
    renders.set(paneId, (renders.get(paneId) ?? 0) + 1);
    return <div data-pane={paneId} />;
  },
}));

// The real panels need layout measurement jsdom doesn't have; the subscription
// under test lives in PaneTree itself.
vi.mock("@/components/ui/resizable", () => ({
  ResizablePanelGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ResizablePanel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ResizableHandle: () => null,
}));

// root: [ A | inner: [ B / C ] ]
const tree: PaneNode = {
  type: "split",
  id: "split_root",
  direction: "horizontal",
  children: [
    { type: "leaf", id: "pane_a", chatGUID: null },
    {
      type: "split",
      id: "split_inner",
      direction: "vertical",
      children: [
        { type: "leaf", id: "pane_b", chatGUID: null },
        { type: "leaf", id: "pane_c", chatGUID: null },
      ],
    },
  ],
};

beforeEach(() => {
  renders.clear();
  useAppStore.setState({
    paneTree: tree,
    activePaneId: "pane_a",
    focusedPaneId: null,
    paneLayouts: { split_root: [50, 50], split_inner: [50, 50] },
  });
});

describe("pane layout writes", () => {
  it("re-render only the group whose layout changed", () => {
    render(<PaneTreeRoot />);
    const before = new Map(renders);

    act(() => useAppStore.getState().setPaneLayout("split_inner", [30, 70]));

    // Pane A sits outside the inner group and must not re-render.
    expect(renders.get("pane_a")).toBe(before.get("pane_a"));
    expect(useAppStore.getState().paneLayouts.split_inner).toEqual([30, 70]);
  });

  it("re-render nothing when a group reports the layout it already has", () => {
    render(<PaneTreeRoot />);
    const before = new Map(renders);

    act(() => {
      useAppStore.getState().setPaneLayout("split_root", [50, 50]);
      useAppStore.getState().setPaneLayout("split_inner", [50, 50]);
    });

    expect(renders).toEqual(before);
  });
});
