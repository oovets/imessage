// Wire types from the sl_* Tauri commands (crates/slack-core).

export interface SlWorkspace {
  id: string;
  name: string;
  connected: boolean;
}

export interface SlStatus {
  configured: boolean;
  workspaces: SlWorkspace[];
  /** Tokens were migrated out of the plaintext TUI config — that file can go. */
  importedFromFile: boolean;
}

/**
 * Slack's own grouping; drives which conversations we show and how.
 *
 * These are strings, not numbers, even though the Rust `ChatSection` carries
 * explicit discriminants (`Public = 0`, …). Serde ignores those for unit
 * variants and serialises the variant *name*, so a numeric enum here silently
 * matches nothing — which is exactly how every Slack conversation once got
 * filtered out of the list.
 */
export type SlChatSection =
  | "Public"
  | "Private"
  | "Shared"
  | "Group"
  | "DirectMessage"
  | "Bot";

export interface SlChat {
  id: string;
  name: string;
  username: string | null;
  unread: number;
  section: SlChatSection;
  /** DM partner's profile photo (public slack-edge URL); null for channels. */
  avatar_url: string | null;
}

/** Every field is optional on the wire — Slack omits them for some file types. */
export interface SlFile {
  id: string | null;
  name: string | null;
  mimetype: string | null;
  url_private: string | null;
  size: number | null;
}

export interface SlBotProfile {
  id: string | null;
  name: string | null;
  app_id: string | null;
  icons: {
    image_36: string | null;
    image_48: string | null;
    image_72: string | null;
  } | null;
}

export interface SlMessage {
  ts: string;
  user: string | null;
  text: string;
  username: string | null;
  bot_id: string | null;
  bot_profile?: SlBotProfile | null;
  thread_ts: string | null;
  files?: SlFile[];
}

/**
 * Realtime payloads on the `sl:core-event` webview event. SlackUpdate is an
 * externally tagged Rust enum, so each variant arrives as a single-key object
 * under `update`; a lagged broadcast reports itself at the top level instead.
 */
export interface SlEventEnvelope {
  workspace_id: string;
  kind?: "lagged";
  update?: {
    NewMessage?: {
      channel_id: string;
      /** Sender's Slack user id (absent for some bots/webhooks). */
      user_id: string | null;
      /** Bot id (B…) when an app sent the message. */
      bot_id: string | null;
      user_name: string;
      text: string;
      ts: string;
      thread_ts: string | null;
      is_bot: boolean;
      is_self: boolean;
      forwarded: string | null;
      mentions_me: boolean;
      files: SlFile[];
    };
    MessageChanged?: { channel_id: string; ts: string; new_text: string };
    MessageDeleted?: { channel_id: string; ts: string };
    UserTyping?: { channel_id: string; user_name: string };
  };
}
