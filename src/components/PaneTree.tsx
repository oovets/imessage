import { useEffect, useState, type DragEvent } from "react";
import { Plus } from "lucide-react";
import { ChatPane } from "@/components/ChatPane";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { useAppStore, paneLeafOrder, type PaneNode } from "@/store/useAppStore";
import { usePaneNumbers } from "@/hooks/usePaneNumbers";
import { CHAT_DRAG_MIME } from "@/lib/triage";
import { cn } from "@/lib/utils";

/** The empty drop slot only invites another column while the board is roomy. */
const MAX_PANES_WITH_SLOT = 3;

interface PaneTreeProps {
  node: PaneNode;
  activePaneId: string;
  totalLeaves: number;
}

function countLeaves(node: PaneNode): number {
  if (node.type === "leaf") return 1;
  return countLeaves(node.children[0]) + countLeaves(node.children[1]);
}

function findLeafNode(node: PaneNode, id: string): PaneNode | null {
  if (node.type === "leaf") return node.id === id ? node : null;
  return findLeafNode(node.children[0], id) ?? findLeafNode(node.children[1], id);
}

export function PaneTree({ node, activePaneId, totalLeaves }: PaneTreeProps) {
  const setPaneLayout = useAppStore((s) => s.setPaneLayout);
  const paneLayouts = useAppStore((s) => s.paneLayouts);
  const { byPane } = usePaneNumbers();

  if (node.type === "leaf") {
    return (
      <ChatPane
        paneId={node.id}
        chatGUID={node.chatGUID}
        isActive={node.id === activePaneId}
        canClose={totalLeaves > 1}
        paneNumber={byPane.get(node.id)}
        totalPanes={totalLeaves}
      />
    );
  }

  const [a, b] = node.children;
  const aId = `panel_${a.id}`;
  const bId = `panel_${b.id}`;
  const stored = paneLayouts[node.id];
  const a0 = Number(stored?.[0]);
  const b0 = Number(stored?.[1]);
  const valid =
    Number.isFinite(a0) && Number.isFinite(b0) && a0 > 0 && b0 > 0;
  const aSize = valid ? a0 : 50;
  const bSize = valid ? b0 : 50;

  return (
    <ResizablePanelGroup
      id={node.id}
      orientation={node.direction}
      defaultLayout={{ [aId]: aSize, [bId]: bSize }}
      onLayoutChanged={(layout: Record<string, number>) => {
        setPaneLayout(node.id, [layout[aId] ?? 50, layout[bId] ?? 50]);
      }}
    >
      <ResizablePanel id={aId} minSize={15}>
        <PaneTree node={a} activePaneId={activePaneId} totalLeaves={totalLeaves} />
      </ResizablePanel>
      <ResizableHandle orientation={node.direction} />
      <ResizablePanel id={bId} minSize={15}>
        <PaneTree node={b} activePaneId={activePaneId} totalLeaves={totalLeaves} />
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

/**
 * The empty column at the right of the board: click for a new empty pane, or
 * drop a sidebar chat on it to open that chat in a new pane.
 */
function DropSlot({ nextNumber }: { nextNumber: number }) {
  const appendPane = useAppStore((s) => s.appendPane);
  const [over, setOver] = useState(false);

  function isChatDrag(e: DragEvent) {
    return e.dataTransfer.types.includes(CHAT_DRAG_MIME);
  }

  return (
    <button
      type="button"
      onClick={() => appendPane(null)}
      onDragEnter={(e) => {
        if (isChatDrag(e)) setOver(true);
      }}
      onDragOver={(e) => {
        if (!isChatDrag(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        const guid = e.dataTransfer.getData(CHAT_DRAG_MIME);
        setOver(false);
        if (!guid) return;
        e.preventDefault();
        appendPane(guid);
      }}
      aria-label="New pane"
      title={`New pane (⌘${nextNumber})`}
      className={cn(
        "cc-stripes flex w-11 shrink-0 flex-col items-center justify-center gap-3 rounded-[10px] text-muted-foreground transition-[box-shadow] duration-120 hover:text-foreground",
        over
          ? "shadow-[inset_0_0_0_1.5px_hsl(var(--signal))]"
          : "shadow-[inset_0_0_0_1px_hsl(var(--border))]"
      )}
    >
      <Plus className="h-4 w-4" />
      <span className="whitespace-nowrap font-mono text-cc-meta tracking-[0.04em] [writing-mode:vertical-rl]">
        drop a chat here · ⌘{nextNumber}
      </span>
    </button>
  );
}

/**
 * Board-level shortcuts: ⌘1–⌘9 focus pane N (leaf order), ⌘D / ⇧⌘D split
 * the active pane right / down, Esc leaves focus mode.
 */
function useBoardShortcuts() {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const s = useAppStore.getState();
      const mod = e.metaKey || e.ctrlKey;
      if (mod && !e.altKey && !e.shiftKey && /^[1-9]$/.test(e.key)) {
        const leaf = paneLeafOrder(s.paneTree)[Number(e.key) - 1];
        if (!leaf) {
          // ⌘(N+1) is the drop slot's key: open a new empty pane.
          if (Number(e.key) === countLeaves(s.paneTree) + 1) {
            e.preventDefault();
            s.appendPane(null);
          }
          return;
        }
        e.preventDefault();
        if (s.focusedPaneId && s.focusedPaneId !== leaf.id) s.setFocusedPane(leaf.id);
        s.setActivePane(leaf.id);
        return;
      }
      if (mod && !e.altKey && (e.key === "d" || e.key === "D")) {
        e.preventDefault();
        s.splitPane(s.activePaneId, e.shiftKey ? "vertical" : "horizontal");
        return;
      }
      if (e.key === "Escape" && s.focusedPaneId) {
        // Dialogs and fields handle their own Escape first.
        const target = e.target as HTMLElement | null;
        if (target?.closest?.("[role=dialog]")) return;
        s.setFocusedPane(null);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

export function PaneTreeRoot() {
  const paneTree = useAppStore((s) => s.paneTree);
  const activePaneId = useAppStore((s) => s.activePaneId);
  const focusedPaneId = useAppStore((s) => s.focusedPaneId);
  const { byPane } = usePaneNumbers();
  useBoardShortcuts();

  const total = countLeaves(paneTree);
  const focused = focusedPaneId ? findLeafNode(paneTree, focusedPaneId) : null;

  return (
    <div className="app-board flex min-h-0 min-w-0 flex-1 gap-2.5 p-2.5">
      <div className="flex min-h-0 min-w-0 flex-1">
        {focused && focused.type === "leaf" ? (
          <ChatPane
            paneId={focused.id}
            chatGUID={focused.chatGUID}
            isActive={focused.id === activePaneId}
            canClose={total > 1}
            paneNumber={byPane.get(focused.id)}
            totalPanes={total}
          />
        ) : (
          <PaneTree node={paneTree} activePaneId={activePaneId} totalLeaves={total} />
        )}
      </div>
      {!focused && total <= MAX_PANES_WITH_SLOT && <DropSlot nextNumber={total + 1} />}
    </div>
  );
}
