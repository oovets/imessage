// Wire types from the irc_* Tauri commands (crates/irc-core).

export interface IrcNetwork {
  id: string;
  name: string;
  host: string;
  port: number;
  tls: boolean;
  nick: string;
  hasPassword: boolean;
  /** Registered with the server right now. */
  connected: boolean;
  /** The nick the server actually gave us, once connected. */
  currentNick: string | null;
}

export interface IrcStatus {
  configured: boolean;
  networks: IrcNetwork[];
}

/** Serde unit-variant names, as with Slack's sections — strings, not numbers. */
export type IrcBufferKind = "Channel" | "Query";
export type IrcMessageKind = "Privmsg" | "Action" | "Notice";

export interface IrcBuffer {
  /** Casefolded name; the key. */
  id: string;
  /** Name as spelled on the wire, for display. */
  name: string;
  kind: IrcBufferKind;
  topic: string | null;
  /** Epoch millis of the newest message, 0 if none. */
  last_ts: number;
  last_text: string;
}

export interface IrcMessage {
  id: string;
  /** Epoch millis. */
  ts: number;
  from: string;
  text: string;
  kind: IrcMessageKind;
  is_self: boolean;
  /** For us: a query message, or our nick mentioned in a channel. */
  highlight: boolean;
}

/**
 * Realtime payloads on the `irc:core-event` webview event. IrcUpdate is an
 * internally tagged Rust enum (`type`), so each variant is one flat object.
 */
export type IrcUpdate =
  | { type: "Connected"; nick: string }
  | { type: "Disconnected"; reason: string }
  | { type: "BufferOpened"; buffer: IrcBuffer }
  | { type: "BufferClosed"; buffer: string }
  | { type: "Topic"; buffer: string; topic: string }
  | { type: "Message"; buffer: IrcBuffer; message: IrcMessage }
  | { type: "Error"; buffer: string | null; text: string };

export interface IrcImportReport {
  /** The IRCCloud network the history came from. */
  irccloudNetwork: string;
  buffers: { name: string; added: number }[];
}

/** `irc:import-progress`: which buffer the import is on, and how far. */
export interface IrcImportProgress {
  network_id: string;
  buffer: string;
  index: number;
  total: number;
  messages: number;
}

export interface IrcEventEnvelope {
  network_id: string;
  kind?: "lagged";
  update?: IrcUpdate;
}
