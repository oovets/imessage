import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { MessageBubble } from "@/components/MessageBubble";
import { MessageListSkeleton } from "@/components/MessageListSkeleton";
import { TypingIndicator } from "@/components/TypingIndicator";
import { useAppStore } from "@/store/useAppStore";
import { isSource } from "@/lib/source";
import { getClient } from "@/api/clientFactory";
import { tg } from "@/telegram/api";
import { parseTgChatGuid } from "@/telegram/adapters";
import { cn } from "@/lib/utils";
import {
  type Message,
  formatDate,
  formatMessageTime,
  nextLocalMidnight,
  nextMessageTimeChange,
  whenDue,
} from "@/types";

// iMessage tapbacks have no exact Telegram equivalents; map to the nearest
// standard Telegram reaction (note: Telegram's "laugh" is 😁, not 😂).
const TAPBACK_TO_EMOJI: Record<string, string> = {
  love: "❤️",
  like: "👍",
  dislike: "👎",
  laugh: "😁",
  emphasize: "🔥",
  question: "🤔",
};

interface MessageListProps {
  chatGUID: string;
}

const GROUP_GAP_MS = 60 * 1000;
const TIME_HEADER_MS = 15 * 60 * 1000;

const TAPBACK_EMOJI: Record<number, string> = {
  2000: "❤️", 2001: "👍", 2002: "👎", 2003: "😂", 2004: "‼️", 2005: "❓",
};

const REACTION_KEY_TO_TYPE: Record<string, number> = {
  love: 2000, like: 2001, dislike: 2002, laugh: 2003, emphasize: 2004, question: 2005,
  "-love": 3000, "-like": 3001, "-dislike": 3002, "-laugh": 3003, "-emphasize": 3004, "-question": 3005,
};

function reactionTypeNum(raw: unknown): number {
  if (typeof raw === "number") return raw;
  const s = String(raw ?? "").trim();
  if (!s) return 0;
  if (s in REACTION_KEY_TO_TYPE) return REACTION_KEY_TO_TYPE[s];
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : 0;
}

function buildReactionMap(messages: Message[]): Map<string, string[]> {
  const keys = new Map<string, Map<string, string>>();

  for (const msg of messages) {
    const typeNum = reactionTypeNum(msg.associatedMessageType);

    const targetGuid = (msg.associatedMessageGuid ?? "").replace(/^p:\d+\//, "");
    if (!targetGuid) continue;

    const sender = msg.isFromMe ? "me" : (msg.handle?.address ?? "unknown");

    if (typeNum >= 2000 && typeNum <= 2005) {
      const emoji = TAPBACK_EMOJI[typeNum];
      if (!emoji) continue;
      const byTarget = keys.get(targetGuid) ?? new Map<string, string>();
      byTarget.set(`${sender}-${typeNum}`, emoji);
      keys.set(targetGuid, byTarget);
    } else if (typeNum >= 3000 && typeNum <= 3005) {
      const addedType = typeNum - 1000;
      const byTarget = keys.get(targetGuid);
      if (byTarget) byTarget.delete(`${sender}-${addedType}`);
    }
  }

  const result = new Map<string, string[]>();
  for (const [guid, byKey] of keys) {
    const emojis = [...new Set(byKey.values())];
    if (emojis.length > 0) result.set(guid, emojis);
  }
  return result;
}

/**
 * `next`, with each target's emoji array swapped for the one in `prev` when
 * the contents match. The map is rebuilt whenever the history changes; keeping
 * unchanged arrays' identity lets memoized bubbles skip re-rendering.
 */
function reuseUnchangedReactions(
  next: Map<string, string[]>,
  prev: Map<string, string[]>
): Map<string, string[]> {
  for (const [guid, emojis] of next) {
    const old = prev.get(guid);
    if (old && old.length === emojis.length && old.every((e, i) => e === emojis[i])) {
      next.set(guid, old);
    }
  }
  return next;
}

function formatDateChip(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const diffDays = Math.floor(
    (new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() -
      new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) /
      (1000 * 60 * 60 * 24)
  );
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return formatDate(d, "weekdayLong");
  return formatDate(d, d.getFullYear() === now.getFullYear() ? "monthDay" : "monthDayYear");
}

function formatTimeOnly(ts: number): string {
  return formatDate(ts, "time");
}

function isSameDay(a: number, b: number): boolean {
  const da = new Date(a), db = new Date(b);
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}

function senderKey(m: Message): string {
  return m.isFromMe ? "me" : (m.handle?.address ?? "unknown");
}

/** `b`, right after `a`, joins its bubble group: same sender, under a minute on. */
function sameGroup(a: Message, b: Message): boolean {
  return senderKey(a) === senderKey(b) && b.dateCreated - a.dateCreated < GROUP_GAP_MS;
}

// Stable stand-in for a chat with no history yet, so the memos below keyed on
// the message array don't recompute on every render.
const NO_MESSAGES: Message[] = [];

// Memoized: its only prop is the chat GUID. Without this, every ChatPane
// render (pane activation, the chat object changing on each incoming message,
// presence) re-rendered the whole list.
export const MessageList = memo(function MessageList({ chatGUID }: MessageListProps) {
  const rawMessages = useAppStore((s) => s.messages[chatGUID]);
  const messages: Message[] = rawMessages ?? NO_MESSAGES;
  // The loading flag is global and only matters while this chat is empty, so
  // subscribe to exactly that: another pane's fetch no longer re-renders a
  // list that already has content.
  const showLoading = useAppStore(
    (s) => s.loadingMessages && !s.messages[chatGUID]?.length
  );
  const superlightMode = useAppStore((s) => s.superlightMode);
  const showTimestamps = useAppStore((s) => s.showTimestamps);
  const setReplyTarget = useAppStore((s) => s.setReplyTarget);
  const upsertMessage = useAppStore((s) => s.upsertMessage);
  const removeMessage = useAppStore((s) => s.removeMessage);
  const serverUrl = useAppStore((s) => s.serverUrl);
  const password = useAppStore((s) => s.password);
  const visible = useMemo(
    () => messages.filter((m) => reactionTypeNum(m.associatedMessageType) < 2000),
    [messages]
  );
  // Sender names only matter in groups. Participants cover iMessage; for
  // sources whose chats carry none (Slack channels), more than one distinct
  // incoming sender in the loaded history is the tell.
  const participantCount = useAppStore(
    (s) => s.chats.find((c) => c.guid === chatGUID)?.participants.length ?? 0
  );
  const isGroup = useMemo(
    () =>
      participantCount > 1 ||
      new Set(visible.filter((m) => !m.isFromMe).map(senderKey)).size > 1,
    [participantCount, visible]
  );
  const latestVisible = visible[visible.length - 1];
  const latestVisibleKey = latestVisible ? `${latestVisible.guid}:${latestVisible.dateCreated}` : "";

  // Relative labels read the clock: a bubble's "14:35" becomes "Tue" after
  // 24 h, and day chips roll over at midnight. Unmemoized, the list picked
  // that up from whatever re-rendered its pane; memoized, it re-renders
  // itself when the next shown label is due.
  const renderedAt = Date.now();
  const [clockTick, setClockTick] = useState(0);
  useEffect(() => {
    let due = nextLocalMidnight(renderedAt);
    if (showTimestamps) {
      visible.forEach((m, i) => {
        const next = visible[i + 1];
        if (!next || !sameGroup(m, next)) {
          due = Math.min(due, nextMessageTimeChange(m.dateCreated, renderedAt));
        }
      });
    }
    return whenDue(due, () => setClockTick((n) => n + 1));
    // renderedAt is the time of the render that scheduled this; renders after
    // it and before `due` show the same labels.
  }, [visible, showTimestamps, clockTick]);

  // The previous map, whose arrays are reused where unchanged. Writing the ref
  // during render is safe: an array is only ever swapped for one with the same
  // contents, so even a discarded render can't leave a wrong one behind.
  const prevReactionMapRef = useRef<Map<string, string[]>>(new Map());
  const reactionMap = useMemo(() => {
    const next = reuseUnchangedReactions(buildReactionMap(messages), prevReactionMapRef.current);
    prevReactionMapRef.current = next;
    return next;
  }, [messages]);

  // Stable across renders so memoized bubbles skip re-rendering.
  const handleReply = useCallback(
    (m: Message) => {
      setReplyTarget(chatGUID, m);
    },
    [chatGUID, setReplyTarget]
  );

  const handleReact = useCallback(async (m: Message, reactionKey: string) => {
    // Telegram: map the iMessage tapback to the nearest Telegram emoji and
    // send it through the Telegram core (no optimistic tapback child-message;
    // the authoritative aggregate arrives via tg:core-event).
    if (isSource(chatGUID, "telegram")) {
      const emoji = TAPBACK_TO_EMOJI[reactionKey];
      if (!emoji) return;
      const { accountId, chatId } = parseTgChatGuid(chatGUID);
      const messageId = Number(m.guid.split(":").pop());
      if (!Number.isFinite(messageId) || messageId <= 0) return;
      const already = (m.tgReactions ?? []).some((r) => r.startsWith(emoji));
      void tg.react(accountId, chatId, messageId, already ? null : emoji).catch(() => {});
      return;
    }

    const typeNum = REACTION_KEY_TO_TYPE[reactionKey];
    if (!typeNum) return;
    const tempGuid = (typeof crypto !== "undefined" && "randomUUID" in crypto)
      ? crypto.randomUUID()
      : `r-${Date.now()}`;
    const optimistic: Message = {
      guid: `local-${tempGuid}`,
      tempGuid,
      text: "",
      isFromMe: true,
      dateCreated: Date.now(),
      handle: null,
      attachments: [],
      associatedMessageGuid: m.guid,
      associatedMessageType: String(typeNum),
      chatGUID,
      pending: true,
    };
    upsertMessage(optimistic);
    try {
      await getClient(serverUrl, password).sendReaction(chatGUID, m.guid, reactionKey);
    } catch {
      removeMessage(chatGUID, optimistic.guid);
    }
  }, [chatGUID, serverUrl, password, upsertMessage, removeMessage]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const wasAtBottomRef = useRef(true);
  const lastChatRef = useRef<string>(chatGUID);
  const lastCountRef = useRef(0);
  const lastLatestVisibleKeyRef = useRef("");
  const readyRef = useRef(false);
  const lastScrollHeightRef = useRef(0);

  const [showJump, setShowJump] = useState(false);
  const [unseenCount, setUnseenCount] = useState(0);
  const [ready, setReady] = useState(false);

  function scrollToBottom(behavior: ScrollBehavior = "auto") {
    const el = scrollRef.current;
    if (!el) return;
    if (behavior === "smooth") {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    } else {
      el.scrollTop = el.scrollHeight;
    }
  }

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    function onScroll() {
      if (!readyRef.current) return;
      const sh = el!.scrollHeight;
      const grew = sh > lastScrollHeightRef.current;
      lastScrollHeightRef.current = sh;
      const distanceFromBottom = sh - el!.scrollTop - el!.clientHeight;
      // If content grew below us and we were pinned, re-pin instead of
      // treating the new gap as the user scrolling up.
      if (wasAtBottomRef.current && grew && distanceFromBottom > 0) {
        el!.scrollTop = sh;
        return;
      }
      const atBottom = distanceFromBottom < 80;
      wasAtBottomRef.current = atBottom;
      if (atBottom) {
        setShowJump(false);
        setUnseenCount(0);
      } else {
        setShowJump(true);
      }
    }
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [chatGUID]);

  // Must run before the firstLoad layout effect below, so readyRef is reset
  // in the same render when chatGUID changes — otherwise switching to a chat
  // with cached messages leaves the content stuck at opacity-0.
  useLayoutEffect(() => {
    readyRef.current = false;
    setReady(false);
    wasAtBottomRef.current = true;
    setShowJump(false);
    setUnseenCount(0);
    lastChatRef.current = chatGUID;
    lastCountRef.current = 0;
    lastLatestVisibleKeyRef.current = "";
    lastScrollHeightRef.current = 0;
  }, [chatGUID]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content) return;
    const ro = new ResizeObserver(() => {
      if (!readyRef.current || wasAtBottomRef.current) {
        el.scrollTop = el.scrollHeight;
      }
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, [chatGUID]);

  useLayoutEffect(() => {
    const visibleCount = visible.length;
    const latestChanged =
      latestVisibleKey !== "" && latestVisibleKey !== lastLatestVisibleKeyRef.current;
    // Per-pane first paint: trigger as soon as we have content. Don't gate on
    // the global loadingMessages flag — it can be true because *another* pane
    // is fetching, which would wedge this pane's initial scroll-to-bottom.
    const firstLoad = !readyRef.current && visibleCount > 0;

    if (firstLoad) {
      lastCountRef.current = visibleCount;
      lastLatestVisibleKeyRef.current = latestVisibleKey;
      requestAnimationFrame(() => {
        scrollToBottom("auto");
        requestAnimationFrame(() => {
          scrollToBottom("auto");
          readyRef.current = true;
          setReady(true);
        });
      });
      return;
    }

    if (readyRef.current && latestChanged) {
      const added = Math.max(1, visibleCount - lastCountRef.current);
      lastCountRef.current = visibleCount;
      lastLatestVisibleKeyRef.current = latestVisibleKey;
      if (latestVisible?.isFromMe || wasAtBottomRef.current) {
        requestAnimationFrame(() => scrollToBottom("smooth"));
      } else {
        setUnseenCount((c) => c + added);
        setShowJump(true);
      }
    }
  }, [visible.length, latestVisibleKey, latestVisible?.isFromMe]);

  function jumpToBottom() {
    scrollToBottom("smooth");
    setUnseenCount(0);
    setShowJump(false);
  }

  if (showLoading) {
    return superlightMode ? (
      <div className="flex flex-1 items-center justify-center text-cc-body text-muted-foreground">
        Loading messages…
      </div>
    ) : (
      <MessageListSkeleton />
    );
  }

  if (messages.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center text-cc-body text-muted-foreground">
        No messages yet
      </div>
    );
  }

  return (
    <div className="flex-1 relative min-h-0">
      <div
        ref={scrollRef}
        className="scrollbar-autohide absolute inset-0 overflow-y-auto overflow-x-hidden py-2.5 [overflow-anchor:none]"
      >
        <div
          ref={contentRef}
          className={cn(
            // A short history sits at the bottom, next to the composer.
            "flex min-h-full flex-col justify-end transition-opacity duration-150",
            ready ? "opacity-100" : "opacity-0"
          )}
        >
          {visible.map((msg, i) => {
            const prev = visible[i - 1];
            const next = visible[i + 1];

            const showDateChip = !prev || !isSameDay(prev.dateCreated, msg.dateCreated);
            const showTimeHeader =
              showTimestamps && !showDateChip && (!prev || msg.dateCreated - prev.dateCreated > TIME_HEADER_MS);

            const sameSenderAsPrev = !!prev && sameGroup(prev, msg);
            const sameSenderAsNext = !!next && sameGroup(msg, next);

            const isFirstInGroup = !sameSenderAsPrev;
            const isLastInGroup = !sameSenderAsNext;

            const showSender = isGroup && isFirstInGroup && !msg.isFromMe;
            const showTime = showTimestamps && isLastInGroup;
            // Formatted here rather than in the memoized bubble, so a label
            // that has aged ("14:35" → "Tue") still refreshes whenever the
            // list renders, as it did before bubbles were memoized.
            const timeLabel = showTime ? formatMessageTime(msg.dateCreated) : undefined;

            // Telegram messages carry their own aggregated emoji reactions;
            // iMessage messages derive theirs from tapback child-messages.
            const reactions = msg.tgReactions ?? reactionMap.get(msg.guid);

            return (
              <div key={msg.guid}>
                {(showDateChip || showTimeHeader) && (
                  // One divider style for both day changes and time gaps:
                  // mono label, then a hairline filling the row.
                  <div className="mx-3.5 mb-2 mt-3 flex items-center gap-2.5 font-mono text-cc-chip text-muted-foreground">
                    <span className="whitespace-nowrap">
                      {/* A history that is all today opens on the time, not
                          "TODAY"; later day changes name the day. */}
                      {showDateChip && !(i === 0 && isSameDay(msg.dateCreated, Date.now()))
                        ? formatDateChip(msg.dateCreated).toUpperCase()
                        : formatTimeOnly(msg.dateCreated)}
                    </span>
                    <span className="h-px flex-1 bg-border" />
                  </div>
                )}
                <MessageBubble
                  message={msg}
                  showSender={showSender}
                  timeLabel={timeLabel}
                  reactions={reactions}
                  isFirstInGroup={isFirstInGroup}
                  onReply={handleReply}
                  onReact={handleReact}
                />
              </div>
            );
          })}
          <TypingIndicator chatGUID={chatGUID} />
        </div>
      </div>

      {/* Jump-to-bottom pill */}
      <button
        onClick={jumpToBottom}
        className={cn(
          "absolute bottom-3 left-1/2 -translate-x-1/2 z-10",
          "flex items-center gap-1.5 rounded-md bg-panel px-3 py-1 font-mono text-cc-meta text-muted-foreground shadow-[inset_0_0_0_1px_hsl(var(--border))] hover:text-foreground",
          !superlightMode && "transition-[opacity,transform] duration-200",
          showJump ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4 pointer-events-none"
        )}
        aria-label="Jump to latest"
      >
        <ChevronDown className="h-3.5 w-3.5" />
        {unseenCount > 0 ? `${unseenCount} new message${unseenCount > 1 ? "s" : ""}` : "Jump to latest"}
      </button>
    </div>
  );
});
