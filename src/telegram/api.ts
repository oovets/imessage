// Typed wrappers over the tg_* Tauri commands and the tg:core-event stream.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { TgAccount, TgChat, TgMessage } from "./types";

type TgMessageId = number;

export const tg = {
  /** Whether the Telegram backend is configured and running. */
  status: () => invoke<boolean>("tg_status"),
  listAccounts: () => invoke<TgAccount[]>("tg_list_accounts"),
  chatList: (accountId: number) => invoke<TgChat[]>("tg_chat_list", { accountId }),
  messages: (
    accountId: number,
    chatId: number,
    before?: { date: string; id: number },
    limit = 50,
  ) =>
    invoke<TgMessage[]>("tg_messages", {
      accountId,
      chatId,
      beforeDate: before?.date ?? null,
      beforeId: before?.id ?? null,
      limit,
    }),
  avatarDataUrl: (accountId: number, chatId: number) =>
    invoke<string | null>("tg_avatar_data_url", { accountId, chatId }),
  userAvatarDataUrl: (accountId: number, userId: number) =>
    invoke<string | null>("tg_user_avatar_data_url", { accountId, userId }),
  mediaDataUrl: (
    accountId: number,
    chatId: number,
    messageId: number,
    cacheKey: string,
    mimeType?: string,
  ) =>
    invoke<string>("tg_media_data_url", {
      accountId,
      chatId,
      messageId,
      cacheKey,
      mimeType: mimeType ?? null,
    }),

  // Writes (Fas 2)
  sendMessage: (
    accountId: number,
    chatId: number,
    text: string,
    replyTo?: TgMessageId,
  ) =>
    invoke<TgMessage>("tg_send_message", {
      accountId,
      chatId,
      text,
      replyTo: replyTo ?? null,
    }),
  editMessage: (
    accountId: number,
    chatId: number,
    messageId: TgMessageId,
    text: string,
  ) => invoke<void>("tg_edit_message", { accountId, chatId, messageId, text }),
  deleteMessages: (accountId: number, chatId: number, messageIds: TgMessageId[]) =>
    invoke<void>("tg_delete_messages", { accountId, chatId, messageIds }),
  react: (
    accountId: number,
    chatId: number,
    messageId: TgMessageId,
    emoji: string | null,
  ) => invoke<void>("tg_react", { accountId, chatId, messageId, emoji }),
  markRead: (accountId: number, chatId: number) =>
    invoke<void>("tg_mark_read", { accountId, chatId }),
  setTyping: (accountId: number, chatId: number) =>
    invoke<void>("tg_set_typing", { accountId, chatId }),

  // Login / accounts (Fas 4)
  beginCodeLogin: (phone: string) => invoke<void>("tg_begin_code_login", { phone }),
  submitCode: (code: string) => invoke<void>("tg_submit_code", { code }),
  submitPassword: (password: string) =>
    invoke<void>("tg_submit_password", { password }),
  beginQrLogin: () => invoke<void>("tg_begin_qr_login"),
  signOut: (accountId: number) => invoke<void>("tg_sign_out", { accountId }),
};

/** Subscribe to the Telegram core event stream. Returns the unlisten fn. */
export function onTelegramEvent(
  handler: (event: unknown) => void,
): Promise<UnlistenFn> {
  return listen("tg:core-event", (e) => handler(e.payload));
}
