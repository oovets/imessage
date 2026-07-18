// Thin wrappers over the sl_* Tauri commands, mirroring src/telegram/api.ts.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { SlChat, SlMessage, SlStatus, SlEventEnvelope } from "./types";

export const sl = {
  status: () => invoke<SlStatus>("sl_status"),
  saveWorkspace: (name: string, token: string, appToken: string) =>
    invoke<{ id: string; name: string; connected: boolean }>("sl_save_workspace", {
      name,
      token,
      appToken,
    }),
  removeWorkspace: (workspaceId: string) =>
    invoke<void>("sl_remove_workspace", { workspaceId }),
  connect: (workspaceId: string) => invoke<void>("sl_connect", { workspaceId }),
  conversations: (workspaceId: string) =>
    invoke<SlChat[]>("sl_conversations", { workspaceId }),
  history: (workspaceId: string, channelId: string, limit = 50) =>
    invoke<SlMessage[]>("sl_history", { workspaceId, channelId, limit }),
  selfUserId: (workspaceId: string) =>
    invoke<string | null>("sl_self_user_id", { workspaceId }),
  /** A user's public avatar URL, or null if they have none. */
  userAvatar: (workspaceId: string, userId: string) =>
    invoke<string | null>("sl_user_avatar", { workspaceId, userId }),
  /** Known user id -> display name, for resolving `<@U123>` mentions. */
  userNames: (workspaceId: string) =>
    invoke<Record<string, string>>("sl_user_names", { workspaceId }),
  /** Fetch an attachment with the workspace token; returns a local file path. */
  downloadFile: (workspaceId: string, url: string, name: string) =>
    invoke<string>("sl_download_file", { workspaceId, url, name }),
  send: (workspaceId: string, channelId: string, text: string, threadTs?: string) =>
    invoke<void>("sl_send", { workspaceId, channelId, text, threadTs: threadTs ?? null }),
};

export function onSlackEvent(
  handler: (event: SlEventEnvelope) => void
): Promise<UnlistenFn> {
  return listen<SlEventEnvelope>("sl:core-event", (e) => handler(e.payload));
}
