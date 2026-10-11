// Loads IRC channels and queries into the unified chat list.
//
// Mirrors useSlackInbox: start every saved network and list its buffers. The
// buffers come from irc-core's local history, so they are there immediately —
// the connection itself (and the bouncer's replay) arrives later as events.

import { useEffect } from "react";
import { useAppStore } from "@/store/useAppStore";
import { irc } from "@/irc/api";
import { ircBufferToChat } from "@/irc/adapters";
import { accountKey } from "@/lib/accounts";
import type { Chat } from "@/types";

export function useIrcInbox() {
  const setIrcChats = useAppStore((s) => s.setIrcChats);
  const setIrcAvailable = useAppStore((s) => s.setIrcAvailable);
  const setAccountLabel = useAppStore((s) => s.setAccountLabel);
  const reloadNonce = useAppStore((s) => s.ircReloadNonce);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const status = await irc.status();
        if (cancelled) return;
        setIrcAvailable(status.configured && status.networks.length > 0);
        if (!status.configured) {
          setIrcChats([]);
          return;
        }

        const perNetwork = await Promise.all(
          status.networks.map(async (net) => {
            try {
              setAccountLabel(accountKey("irc", net.id), net.name);
              await irc.connect(net.id);
              const buffers = await irc.buffers(net.id);
              return buffers.map((b) => ircBufferToChat(net.id, b));
            } catch (e) {
              console.error(`irc: network ${net.name} failed:`, e);
              return [] as Chat[];
            }
          })
        );
        if (cancelled) return;
        // A reload re-lists from history, which knows nothing about unread
        // counts — keep the ones the event stream has been keeping.
        const current = new Map(useAppStore.getState().chats.map((c) => [c.guid, c]));
        setIrcChats(
          perNetwork.flat().map((chat) => {
            const prev = current.get(chat.guid);
            return prev ? { ...chat, unreadCount: prev.unreadCount } : chat;
          })
        );
      } catch (e) {
        console.error("irc inbox load failed:", e);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [setIrcChats, setIrcAvailable, setAccountLabel, reloadNonce]);
}
