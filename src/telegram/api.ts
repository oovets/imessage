// Typed wrappers over the tg_* Tauri commands and the tg:core-event stream.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { TgAccount, TgChat, TgMessage } from "./types";

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
};

/** Subscribe to the Telegram core event stream. Returns the unlisten fn. */
export function onTelegramEvent(
  handler: (event: unknown) => void,
): Promise<UnlistenFn> {
  return listen("tg:core-event", (e) => handler(e.payload));
}
