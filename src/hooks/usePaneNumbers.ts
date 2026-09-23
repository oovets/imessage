import { useMemo } from "react";
import { paneLeafOrder, useAppStore } from "@/store/useAppStore";

/**
 * ⌘N numbering of the open panes, derived from the pane tree's leaf order.
 * `byChat` maps a chat GUID to the number of the pane showing it, so sidebar
 * rows can show the same key chip as the pane header.
 */
export function usePaneNumbers() {
  const paneTree = useAppStore((s) => s.paneTree);
  return useMemo(() => {
    const order = paneLeafOrder(paneTree);
    const byPane = new Map<string, number>();
    const byChat = new Map<string, number>();
    order.forEach((leaf, i) => {
      byPane.set(leaf.id, i + 1);
      if (leaf.chatGUID && !byChat.has(leaf.chatGUID)) byChat.set(leaf.chatGUID, i + 1);
    });
    return { order, byPane, byChat };
  }, [paneTree]);
}
