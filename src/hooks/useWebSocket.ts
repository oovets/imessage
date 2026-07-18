import { useEffect, useRef } from "react";
import { useAppStore } from "@/store/useAppStore";
import type { Message } from "@/types";
import { notifyIncomingMessage } from "@/lib/desktopNotifications";
import { getChatDisplayName } from "@/types";
import { openSocket, type SocketHandle } from "@/lib/wsTransport";
import { getClient } from "@/api/clientFactory";
import { canonicalChatGuid, notePreferredSendGuid } from "@/lib/chatThreadMerge";

// U+FFFC is the object-replacement char iMessage uses as the stand-in "body" of
// an attachment message, so strip it before deciding a message is bodyless.
function isEmptyBody(m: Message): boolean {
  return (m.text ?? "").replace(/￼/g, "").trim() === "";
}

// The raw socket payload may still flag that the message has attachments even
// when it omits the attachment objects themselves.
function rawFlagsAttachments(data: unknown): boolean {
  if (!data || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;
  const msg = (d.message ?? d) as Record<string, unknown>;
  return msg.hasAttachments === true;
}

// BlueBubbles socket events often omit attachment data, so an image message —
// with or without a caption — arrives without anything to render. Backfill from
// HTTP when we received no attachments but the message either flags attachments
// (captioned image) or has an empty body (attachment-only image).
function needsAttachmentBackfill(m: Message, data: unknown): boolean {
  if ((m.attachments?.length ?? 0) > 0) return false;
  return rawFlagsAttachments(data) || isEmptyBody(m);
}

function extractMessage(data: unknown): Message | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  const msg = (d.message ?? d) as Record<string, unknown>;
  if (typeof msg.guid !== "string") return null;

  const chats = msg.chats as Array<{ guid: string }> | undefined;
  const chatGUID =
    chats?.[0]?.guid ??
    (typeof msg.chatGuid === "string" ? msg.chatGuid : "") ??
    "";

  return {
    guid: msg.guid,
    text: typeof msg.text === "string" ? msg.text : "",
    isFromMe: msg.isFromMe === true,
    dateCreated: typeof msg.dateCreated === "number" ? msg.dateCreated : Date.now(),
    handle: (msg.handle as Message["handle"]) ?? null,
    attachments: (msg.attachments as Message["attachments"]) ?? [],
    associatedMessageGuid: typeof msg.associatedMessageGuid === "string" ? msg.associatedMessageGuid : "",
    associatedMessageType: typeof msg.associatedMessageType === "string" ? msg.associatedMessageType : "",
    chatGUID,
    tempGuid: typeof msg.tempGuid === "string" ? msg.tempGuid : undefined,
  };
}

export function useWebSocket() {
  const serverUrl = useAppStore((s) => s.serverUrl);
  const password = useAppStore((s) => s.password);
  const isConfigured = useAppStore((s) => s.isConfigured);
  const setWsConnected = useAppStore((s) => s.setWsConnected);
  const setPollingFallback = useAppStore((s) => s.setPollingFallback);
  const upsertMessage = useAppStore((s) => s.upsertMessage);
  const markChatHasNewMessage = useAppStore((s) => s.markChatHasNewMessage);
  const setConnectionNotice = useAppStore((s) => s.setConnectionNotice);
  const setTyping = useAppStore((s) => s.setTyping);
  const mergeMessages = useAppStore((s) => s.mergeMessages);

  // Chats currently being backfilled, to coalesce a burst of stripped
  // attachment messages into a single HTTP refetch per chat.
  const backfillingRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!isConfigured) return;

    let cancelled = false;
    let attempt = 0;
    let handle: SocketHandle | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let handshakeTimer: ReturnType<typeof setTimeout> | null = null;
    // Guards against scheduling two reconnects for the same socket (e.g. the
    // handshake watchdog closing a socket that then also fires onClose).
    let reconnecting = false;

    function clearHandshakeTimer() {
      if (handshakeTimer) {
        clearTimeout(handshakeTimer);
        handshakeTimer = null;
      }
    }

    function scheduleReconnect() {
      if (cancelled || reconnecting) return;
      reconnecting = true;
      clearHandshakeTimer();
      setWsConnected(false);
      // Release the dead socket before dropping the reference: close() is the
      // only path that unregisters the plugin listener and tears down the Rust
      // side. Without it every disconnect (sleep/wake, wifi change, server
      // flap) leaked a listener plus its captured effect scope.
      handle?.close();
      handle = null;
      attempt++;
      const delay = Math.min(attempt * 2000, 30000);
      setConnectionNotice(`Realtime disconnected, retrying in ${Math.ceil(delay / 1000)}s…`);
      timer = setTimeout(connect, delay);
    }

    function handleFrame(msg: string, send: (data: string) => void) {
      if (cancelled) return;

      if (msg.startsWith("0")) {
        send("40");
      } else if (msg.startsWith("40")) {
        clearHandshakeTimer();
        setWsConnected(true);
        setPollingFallback(false);
      } else if (msg === "2") {
        send("3");
      } else if (msg.startsWith("42")) {
        try {
          const arr = JSON.parse(msg.slice(2)) as [string, unknown];
          const [type, data] = arr;
          if (type === "new-message" || type === "updated-message") {
            const m = extractMessage(data);
            if (m) {
              // Split iMessage/SMS threads are merged into one conversation;
              // events arrive tagged with the underlying thread's guid. Remap
              // to the canonical guid (and remember which service the contact
              // used, so replies go out the same way).
              if (m.chatGUID) {
                const canonical = canonicalChatGuid(m.chatGUID);
                if (canonical !== m.chatGUID) {
                  notePreferredSendGuid(m.chatGUID);
                  m.chatGUID = canonical;
                }
              }
              upsertMessage(m);
              // Socket events drop attachment data, so an attachment-only
              // message arrives empty and would render as nothing. Backfill it
              // from HTTP (which includes attachments); mergeMessages replaces
              // by guid. Coalesced per chat to avoid a fetch storm.
              if (m.chatGUID && needsAttachmentBackfill(m, data)) {
                const guid = m.chatGUID;
                const inflight = backfillingRef.current;
                if (!inflight.has(guid)) {
                  inflight.add(guid);
                  void getClient(serverUrl, password)
                    .getMessages(guid, 25)
                    .then((msgs) => {
                      if (!cancelled) mergeMessages(guid, msgs);
                    })
                    .catch(() => {})
                    .finally(() => inflight.delete(guid));
                }
              }
              if (!m.isFromMe && m.chatGUID) {
                markChatHasNewMessage(m.chatGUID);
                const chat = useAppStore.getState().chats.find((c) => c.guid === m.chatGUID);
                const name = chat ? getChatDisplayName(chat) : "New message";
                void notifyIncomingMessage(name, m);
              }
              if (m.chatGUID) setTyping(m.chatGUID, false);
            }
          } else if (type === "typing-indicator") {
            const d = (data ?? {}) as { guid?: string; display?: boolean };
            if (typeof d.guid === "string")
              setTyping(canonicalChatGuid(d.guid), d.display === true);
          }
        } catch {}
      }
    }

    async function connect() {
      if (cancelled) return;
      reconnecting = false;

      const base = serverUrl
        .replace(/\/$/, "")
        .replace(/^https:\/\//, "wss://")
        .replace(/^http:\/\//, "ws://");

      if (typeof window !== "undefined" && window.location.protocol === "https:" && base.startsWith("ws://")) {
        setWsConnected(false);
        setPollingFallback(true);
        setConnectionNotice("Realtime unavailable on insecure ws:// connection, using polling fallback.");
        return;
      }
      setPollingFallback(false);

      const url = `${base}/socket.io/?EIO=4&transport=websocket&guid=${encodeURIComponent(password)}`;

      try {
        const opened = await openSocket(url, {
          onOpen: () => {
            attempt = 0;
            setConnectionNotice(null);
            // The transport is up, but the socket.io handshake ('0' → '40')
            // still has to complete. If the plugin delivered the opening frame
            // before our listener attached, that '40' ack never arrives and the
            // app is stuck "connecting". Recover by reconnecting after a grace
            // period instead of waiting for a manual reload.
            clearHandshakeTimer();
            handshakeTimer = setTimeout(() => {
              if (cancelled) return;
              scheduleReconnect();
            }, 6000);
          },
          onText: handleFrame,
          onClose: scheduleReconnect,
        });
        if (cancelled) {
          opened.close();
          return;
        }
        handle = opened;
      } catch {
        // Initial connection failed — treat like a close and back off.
        scheduleReconnect();
      }
    }

    connect();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      clearHandshakeTimer();
      handle?.close();
      handle = null;
      setWsConnected(false);
      setPollingFallback(false);
      setConnectionNotice(null);
    };
  }, [
    isConfigured,
    serverUrl,
    password,
    setWsConnected,
    setPollingFallback,
    upsertMessage,
    markChatHasNewMessage,
    setConnectionNotice,
    setTyping,
    mergeMessages,
  ]);
}
