import TauriWebSocket from "@tauri-apps/plugin-websocket";
import { isTauriRuntime } from "@/lib/tauriEnv";

// Unified realtime transport. In the desktop shell we go through
// tauri-plugin-websocket (Rust-side), which — like the HTTP plugin — is immune
// to WKWebView App Transport Security and therefore can reach a cleartext
// ws:// BlueBubbles server on the LAN. In a plain browser build we fall back to
// the native WebSocket. Both expose the same tiny handle so the socket.io
// framing in useWebSocket is written once.

export interface SocketHandle {
  send: (data: string) => void;
  close: () => void;
}

export interface SocketHandlers {
  /** Transport connected (socket.io handshake still happens over onText). */
  onOpen: () => void;
  /** A text frame arrived; `send` writes a text frame back on this socket. */
  onText: (data: string, send: (data: string) => void) => void;
  /** The socket closed or failed after opening. */
  onClose: () => void;
}

/**
 * Open a realtime socket. Resolves once connected; rejects if the initial
 * connection fails (the caller treats a rejection the same as a later close and
 * schedules a reconnect).
 */
export async function openSocket(url: string, handlers: SocketHandlers): Promise<SocketHandle> {
  if (isTauriRuntime()) {
    const ws = await TauriWebSocket.connect(url);
    let closed = false;
    const send = (data: string) => {
      void ws.send(data);
    };
    const removeListener = ws.addListener((message) => {
      if (message.type === "Text") {
        handlers.onText(message.data, send);
      } else if (message.type === "Close") {
        if (!closed) {
          closed = true;
          handlers.onClose();
        }
      }
    });
    handlers.onOpen();
    return {
      send,
      close: () => {
        closed = true;
        removeListener();
        void ws.disconnect();
      },
    };
  }

  // Browser fallback: native WebSocket.
  const ws = new WebSocket(url);
  const send = (data: string) => ws.send(data);
  ws.onopen = () => handlers.onOpen();
  ws.onmessage = (event) => {
    if (typeof event.data === "string") handlers.onText(event.data, send);
  };
  ws.onclose = () => handlers.onClose();
  ws.onerror = null;
  return {
    send,
    close: () => ws.close(),
  };
}
