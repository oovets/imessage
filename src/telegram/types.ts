// TypeScript mirror of the Telegram domain types (shared::model) as they
// serialize over the tg_* Tauri commands. Only what the unified inbox needs.

export type TgSendState = "pending" | "sent" | "failed";

export interface TgAccount {
  id: number;
  phone: string | null;
  first_name: string;
  last_name: string | null;
  username: string | null;
  authorized: boolean;
}

export type TgChatKind = "private" | "group" | "channel";

export interface TgChat {
  account_id: number;
  id: number;
  kind: TgChatKind;
  title: string;
  username: string | null;
  unread_count: number;
  pinned: boolean;
  last_message_at: string | null;
  last_message_preview: string | null;
  avatar_key: string | null;
}

export type TgMedia =
  | { type: "photo"; cache_key: string; width: number; height: number }
  | {
      type: "document";
      cache_key: string;
      file_name: string;
      mime_type: string;
      size_bytes: number;
    }
  | { type: "sticker"; cache_key: string; emoji: string }
  | { type: "other"; description: string };

export interface TgReaction {
  emoji: string;
  count: number;
  chosen: boolean;
}

export interface TgMessage {
  account_id: number;
  chat_id: number;
  id: number;
  sender_id: number | null;
  sender_name: string | null;
  text: string;
  media: TgMedia | null;
  reactions: TgReaction[];
  reply_to: number | null;
  date: string;
  edited: boolean;
  outgoing: boolean;
  send_state: TgSendState;
}
