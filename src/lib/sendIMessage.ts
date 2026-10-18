import { getClient } from "@/api/clientFactory";
import { preferredSendGuid } from "@/lib/chatThreadMerge";
import { useAppStore } from "@/store/useAppStore";
import type { Message } from "@/types";

/**
 * Sends an optimistic iMessage bubble through BlueBubbles and settles it:
 * delivered, or marked failed with the reason, which the bubble offers to
 * retry. Used by the composer and by that retry.
 */
export async function deliverIMessage(chatGUID: string, optimistic: Message): Promise<void> {
  const { serverUrl, password } = useAppStore.getState();
  const replyGuid = optimistic.associatedMessageGuid ?? "";
  try {
    // Merged iMessage/SMS conversation: send on the thread the contact
    // last used, so the reply goes out over the right service.
    await getClient(serverUrl, password).sendMessage(
      preferredSendGuid(chatGUID),
      optimistic.text,
      replyGuid,
      optimistic.tempGuid
    );
    useAppStore.getState().replaceMessage(chatGUID, optimistic.guid, { ...optimistic, pending: false });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    // Replies/reactions go through the BlueBubbles Private API. If that
    // isn't set up on the server, only these fail while plain (AppleScript)
    // messages keep working — so give a targeted hint.
    const isReply = replyGuid.length > 0;
    const looksLikePrivateApi =
      isReply && /private|method|not enabled|helper/i.test(detail);
    const reason = looksLikePrivateApi
      ? `Replies need the BlueBubbles Private API, which the server rejected. Enable “Private API Features” in the BlueBubbles server settings (and install the Private API helper bundle). Server said: ${detail}`
      : detail;
    const s = useAppStore.getState();
    s.setConnectionNotice(`Unable to send message: ${reason}`);
    s.replaceMessage(chatGUID, optimistic.guid, {
      ...optimistic,
      pending: false,
      failed: true,
      failedReason: reason,
    });
  }
}
