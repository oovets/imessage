// Loads Slack conversations into the unified chat list, and keeps them fresh.
//
// Mirrors useTelegramInbox: connect every saved workspace, pull its
// conversations, and merge them into the store's Slack slice. Workspaces load
// concurrently — one slow or unreachable workspace shouldn't hold up the rest.

import { useEffect } from "react";
import { useAppStore } from "@/store/useAppStore";
import { sl } from "@/slack/api";
import { slChatToChat } from "@/slack/adapters";
import { accountKey } from "@/lib/accounts";
import type { SlChatSection } from "@/slack/types";
import type { Chat } from "@/types";

/** Bots and Slack's own noise channels add clutter without conversation. */
const SHOWN_SECTIONS: ReadonlySet<SlChatSection> = new Set<SlChatSection>([
  "Public",
  "Private",
  "Shared",
  "Group",
  "DirectMessage",
]);

export function useSlackInbox() {
  const setSlackChats = useAppStore((s) => s.setSlackChats);
  const setSlackAvailable = useAppStore((s) => s.setSlackAvailable);
  const setAccountLabel = useAppStore((s) => s.setAccountLabel);
  const reloadNonce = useAppStore((s) => s.slackReloadNonce);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const status = await sl.status();
        if (cancelled) return;
        setSlackAvailable(status.configured && status.workspaces.length > 0);
        if (!status.configured) return;

        const perWorkspace = await Promise.all(
          status.workspaces.map(async (ws) => {
            try {
              setAccountLabel(accountKey("slack", ws.id), ws.name);
              if (!ws.connected) await sl.connect(ws.id);
              // Needed to mark our own messages in loaded history.
              const selfId = await sl.selfUserId(ws.id).catch(() => null);
              if (selfId) useAppStore.getState().setSlackSelfUserId(ws.id, selfId);
              const chats = await sl.conversations(ws.id);
              return chats
                .filter((c) => SHOWN_SECTIONS.has(c.section))
                .map((c) => slChatToChat(ws.id, c));
            } catch (e) {
              console.error(`slack: workspace ${ws.name} failed:`, e);
              return [] as Chat[];
            }
          })
        );
        if (!cancelled) setSlackChats(perWorkspace.flat());
      } catch (e) {
        console.error("slack inbox load failed:", e);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [setSlackChats, setSlackAvailable, setAccountLabel, reloadNonce]);
}
