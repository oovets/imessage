// Thin wrappers over the irc_* Tauri commands, mirroring src/slack/api.ts.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  IrcBuffer,
  IrcEventEnvelope,
  IrcImportProgress,
  IrcImportReport,
  IrcMessage,
  IrcNetwork,
  IrcStatus,
} from "./types";

export interface IrcNetworkSettings {
  name: string;
  host: string;
  port: number;
  tls: boolean;
  nick: string;
  username?: string;
  realname?: string;
  /** Empty or absent keeps the stored password when updating a network. */
  password?: string;
}

export const irc = {
  status: () => invoke<IrcStatus>("irc_status"),
  saveNetwork: (s: IrcNetworkSettings) =>
    invoke<IrcNetwork>("irc_save_network", {
      name: s.name,
      host: s.host,
      port: s.port,
      tls: s.tls,
      nick: s.nick,
      username: s.username || null,
      realname: s.realname || null,
      password: s.password || null,
    }),
  removeNetwork: (networkId: string) => invoke<void>("irc_remove_network", { networkId }),
  /** Start the network's client; it connects (and reconnects) in the background. */
  connect: (networkId: string) => invoke<void>("irc_connect", { networkId }),
  buffers: (networkId: string) => invoke<IrcBuffer[]>("irc_buffers", { networkId }),
  /** Oldest first. `before` (epoch ms) pages back from the oldest message shown. */
  history: (networkId: string, buffer: string, limit = 100, before?: number) =>
    invoke<IrcMessage[]>("irc_history", {
      networkId,
      buffer,
      limit,
      ...(before !== undefined ? { before } : {}),
    }),
  /** Composer input: plain lines are messages, `/me`, `/join`, `/msg`… are commands. */
  send: (networkId: string, buffer: string, text: string) =>
    invoke<void>("irc_send", { networkId, buffer, text }),
  openQuery: (networkId: string, nick: string) =>
    invoke<IrcBuffer>("irc_open_query", { networkId, nick }),
  closeBuffer: (networkId: string, buffer: string) =>
    invoke<void>("irc_close_buffer", { networkId, buffer }),
  /** One-time import of IRCCloud's stored history, logging in with ~/.irc. */
  importIrcCloud: (networkId: string) =>
    invoke<IrcImportReport>("irc_import_irccloud", { networkId }),
};

export function onIrcImportProgress(
  handler: (progress: IrcImportProgress) => void
): Promise<UnlistenFn> {
  return listen<IrcImportProgress>("irc:import-progress", (e) => handler(e.payload));
}

export function onIrcEvent(handler: (event: IrcEventEnvelope) => void): Promise<UnlistenFn> {
  return listen<IrcEventEnvelope>("irc:core-event", (e) => handler(e.payload));
}
