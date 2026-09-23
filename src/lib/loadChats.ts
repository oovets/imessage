import { getClient } from "@/api/clientFactory";
import { useAppStore } from "@/store/useAppStore";
import type { Chat } from "@/types";

function formatConnectionError(err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
  return `Unable to reach your BlueBubbles server: ${detail}`;
}

/**
 * (Re)load the iMessage chat list from BlueBubbles, then enrich activity in
 * the background. Lives outside the sidebar so the toolbar's refresh button
 * and the sidebar's mount effect share one implementation.
 */
export async function loadIMessageChats(): Promise<void> {
  const { isConfigured, serverUrl, password, setLoadingChats, setChats, setConnectionNotice } =
    useAppStore.getState();
  if (!isConfigured) return;
  setLoadingChats(true);
  let baseChats: Chat[];
  try {
    const client = getClient(serverUrl, password);
    baseChats = await client.getChats();
    const previousByGuid = new Map(useAppStore.getState().chats.map((c) => [c.guid, c]));
    const merged = baseChats.map((chat) => {
      const prev = previousByGuid.get(chat.guid);
      if (!prev) return chat;
      return {
        ...chat,
        // Same carry-forward as the polling path: never regress activityAt.
        activityAt: chat.activityAt ?? prev.activityAt,
        lastMessageText:
          chat.lastMessageText ??
          chat.lastMessage?.text ??
          prev.lastMessageText ??
          prev.lastMessage?.text ??
          "",
      };
    });
    setChats(merged);
    baseChats = merged;
    setConnectionNotice(null);
  } catch (err) {
    setConnectionNotice(formatConnectionError(err));
    return;
  } finally {
    setLoadingChats(false);
  }

  getClient(serverUrl, password)
    .enrichChatActivity(baseChats, (sorted) => setChats([...sorted]))
    .catch(() => {});
}
