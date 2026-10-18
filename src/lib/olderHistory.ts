import { getClient } from "@/api/clientFactory";
import { chatGuidVariants, chatThreadsKnown } from "@/lib/chatThreadMerge";
import { irc } from "@/irc/api";
import { ircMessageToMessage, parseIrcChatGuid } from "@/irc/adapters";
import { isSource } from "@/lib/source";
import { sl } from "@/slack/api";
import { parseSlChatGuid, slMessageToMessage } from "@/slack/adapters";
import { useAppStore } from "@/store/useAppStore";
import { tg } from "@/telegram/api";
import { parseTgChatGuid, tgMessageToMessage } from "@/telegram/adapters";
import type { Message } from "@/types";

/** Messages per page when scrolling back through a chat. */
export const OLDER_PAGE_SIZE = 50;

const byTime = (a: Message, b: Message) => a.dateCreated - b.dateCreated;

/**
 * Whether an answer of `count` messages, asked for up to `limit`, proves the
 * conversation starts within it, so the start can be remembered for later
 * opens. Only answers that can't hide a failure count: the IRC log, and
 * BlueBubbles for a chat of one thread, which errors when it fails. Not a
 * merged iMessage/SMS pair, whose fetch reads a failed thread as empty, nor
 * any iMessage chat before this session's chat list is merged (every chat
 * looks like one thread until then). Not Slack or Telegram: both can answer
 * short mid-history, and telegram-core answers a failed network backfill
 * with an empty page. Their empty page still ends paging for the open list.
 */
export function provesHistoryStart(chatGUID: string, count: number, limit: number): boolean {
  if (count >= limit) return false;
  if (isSource(chatGUID, "irc")) return true;
  return isSource(chatGUID, "imessage") && chatThreadsKnown() && chatGuidVariants(chatGUID).length === 1;
}

/**
 * The page of history just before `oldest` (the oldest message loaded),
 * oldest first, from whichever source the chat belongs to. It may overlap
 * what is loaded; callers dedupe by guid. An empty page means the start of
 * the conversation.
 */
export async function fetchOlderMessages(chatGUID: string, oldest: Message): Promise<Message[]> {
  if (isSource(chatGUID, "irc")) {
    const { networkId, bufferId } = parseIrcChatGuid(chatGUID);
    const msgs = await irc.history(networkId, bufferId, OLDER_PAGE_SIZE, oldest.dateCreated);
    return msgs.map((m) => ircMessageToMessage(networkId, bufferId, m));
  }

  if (isSource(chatGUID, "slack")) {
    const { workspaceId, channelId } = parseSlChatGuid(chatGUID);
    // A Slack message guid ends in its ts, which is what `latest` takes.
    const latest = oldest.guid.split(":").pop();
    const msgs = await sl.history(workspaceId, channelId, OLDER_PAGE_SIZE, latest);
    const s = useAppStore.getState();
    return msgs
      .map((m) =>
        slMessageToMessage(
          workspaceId,
          channelId,
          m,
          s.slackSelfUserIds[workspaceId] ?? null,
          s.slackUserNames[workspaceId] ?? {}
        )
      )
      .sort(byTime);
  }

  if (isSource(chatGUID, "telegram")) {
    const { accountId, chatId } = parseTgChatGuid(chatGUID);
    const id = Number(oldest.guid.split(":").pop());
    if (!Number.isFinite(id) || id <= 0) return [];
    const msgs = await tg.messages(
      accountId,
      chatId,
      { date: new Date(oldest.dateCreated).toISOString(), id },
      OLDER_PAGE_SIZE
    );
    return msgs.map(tgMessageToMessage).sort(byTime);
  }

  const { serverUrl, password } = useAppStore.getState();
  return getClient(serverUrl, password).getMessages(
    chatGUID,
    OLDER_PAGE_SIZE,
    undefined,
    oldest.dateCreated
  );
}
