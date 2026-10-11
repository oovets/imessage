// Bridges `irc:core-event` into the store: messages land in their chat and
// bump it in the list, channels and queries come and go, and errors (a bad
// bouncer password, a refused join) surface as a notice.
//
// Messages are applied in batches. On connect the bouncer replays everything
// this client missed — easily hundreds of lines at once — and applying each
// on its own meant several store commits (and chat-list renders) per line.
// A batch is one merge per chat and one chat-list commit, flushed on the next
// tick or before any other event, so ordering is kept.

import { useEffect } from "react";
import { useAppStore } from "@/store/useAppStore";
import { onIrcEvent } from "@/irc/api";
import { ircBufferToChat, ircChatGuid, ircMessageToMessage } from "@/irc/adapters";
import type { IrcBuffer, IrcMessage } from "@/irc/types";
import { notifyIncomingMessage } from "@/lib/desktopNotifications";
import { getChatDisplayName, type Chat, type Message } from "@/types";

const FLUSH_MS = 16;

interface Pending {
  network: string;
  buffer: IrcBuffer;
  messages: Message[];
  newest: IrcMessage;
  /** Messages from others: each one is unread. */
  unread: number;
  /** The latest message addressed to us, if any — one notification per batch. */
  highlight: { raw: IrcMessage; message: Message } | null;
}

export function useIrcEvents() {
  useEffect(() => {
    const pending = new Map<string, Pending>();
    let timer: ReturnType<typeof setTimeout> | null = null;

    function flush() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (pending.size === 0) return;
      const batch = [...pending.entries()];
      pending.clear();

      const store = useAppStore.getState();
      const known = new Map(store.chats.map((c) => [c.guid, c]));
      const chats: Chat[] = [];
      for (const [chatGUID, p] of batch) {
        store.mergeMessages(chatGUID, p.messages);
        const chat = known.get(chatGUID) ?? ircBufferToChat(p.network, p.buffer);
        const last = p.messages[p.messages.length - 1];
        chats.push({
          ...chat,
          lastMessageText: last.text,
          // Replayed backlog can be older than what the chat already shows.
          activityAt: Math.max(chat.activityAt ?? 0, p.newest.ts),
          unreadCount: (Number.isFinite(chat.unreadCount) ? chat.unreadCount : 0) + p.unread,
        });
      }
      store.upsertChats(chats);

      for (const [chatGUID, p] of batch) {
        if (!p.highlight) continue;
        const chat = useAppStore.getState().chats.find((c) => c.guid === chatGUID);
        const name = chat ? getChatDisplayName(chat) : p.buffer.name;
        void notifyIncomingMessage(
          p.buffer.kind === "Channel" ? `${p.highlight.raw.from} in ${name}` : name,
          p.highlight.message
        );
      }
    }

    function queue(network: string, buffer: IrcBuffer, m: IrcMessage) {
      const chatGUID = ircChatGuid(network, buffer.id);
      const message = ircMessageToMessage(network, buffer.id, m);
      let p = pending.get(chatGUID);
      if (!p) {
        p = { network, buffer, messages: [], newest: m, unread: 0, highlight: null };
        pending.set(chatGUID, p);
      }
      p.buffer = buffer;
      p.messages.push(message);
      if (m.ts >= p.newest.ts) p.newest = m;
      if (!m.is_self) {
        p.unread += 1;
        // Channels are noisy; only what is addressed to us notifies.
        if (m.highlight) p.highlight = { raw: m, message };
      }
      if (timer === null) timer = setTimeout(flush, FLUSH_MS);
    }

    const unlisten = onIrcEvent((ev) => {
      const net = ev.network_id;
      const update = ev.update;
      if (update?.type === "Message") {
        queue(net, update.buffer, update.message);
        return;
      }
      // Anything else applies after the messages that came before it.
      flush();
      const store = useAppStore.getState();

      // Missed updates: re-list rather than show a chat list with holes.
      if (ev.kind === "lagged") {
        store.reloadIrc();
        return;
      }
      if (!update) return;

      switch (update.type) {
        case "BufferOpened": {
          const guid = ircChatGuid(net, update.buffer.id);
          if (!store.chats.some((c) => c.guid === guid)) {
            store.upsertChat(ircBufferToChat(net, update.buffer));
          }
          return;
        }
        case "BufferClosed":
          store.reloadIrc();
          return;
        case "Error":
          store.setConnectionNotice(`IRC: ${update.text}`);
          return;
        case "Disconnected":
          // The client reconnects on its own; a bouncer blip isn't worth a
          // notice. A refused password arrives as an Error first.
          console.warn(`irc: ${net} disconnected: ${update.reason}`);
          return;
        case "Connected":
        case "Topic":
          return;
      }
    });

    return () => {
      flush();
      unlisten.then((f) => f()).catch(() => {});
    };
  }, []);
}
