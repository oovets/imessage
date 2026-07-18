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
  send: (workspaceId: string, channelId: string, text: string, threadTs?: string) =>
    invoke<void>("sl_send", { workspaceId, channelId, text, threadTs: threadTs ?? null }),
};

export function onSlackEvent(
  handler: (event: SlEventEnvelope) => void
): Promise<UnlistenFn> {
  return listen<SlEventEnvelope>("sl:core-event", (e) => handler(e.payload));
}
