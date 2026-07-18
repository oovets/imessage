import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, MessagesSquare } from "lucide-react";
import { MessageBubble } from "@/components/MessageBubble";
import { MessageListSkeleton } from "@/components/MessageListSkeleton";
import { TypingIndicator } from "@/components/TypingIndicator";
import { useAppStore } from "@/store/useAppStore";
import { isSource } from "@/lib/source";
import { getClient } from "@/api/clientFactory";
import { tg } from "@/telegram/api";
import { parseTgChatGuid } from "@/telegram/adapters";
import { cn } from "@/lib/utils";
import type { Message } from "@/types";

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
  if (diffDays < 7) return d.toLocaleDateString([], { weekday: "long" });
  return d.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    year: d.getFullYear() === now.getFullYear() ? undefined : "numeric",
  });
}

function formatTimeOnly(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
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

export function MessageList({ chatGUID }: MessageListProps) {
  const rawMessages = useAppStore((s) => s.messages[chatGUID]);
  const messages: Message[] = rawMessages ?? [];
  const loadingMessages = useAppStore((s) => s.loadingMessages);
  const superlightMode = useAppStore((s) => s.superlightMode);
  const showTimestamps = useAppStore((s) => s.showTimestamps);
  const setReplyTarget = useAppStore((s) => s.setReplyTarget);
  const upsertMessage = useAppStore((s) => s.upsertMessage);
  const removeMessage = useAppStore((s) => s.removeMessage);
  const serverUrl = useAppStore((s) => s.serverUrl);
  const password = useAppStore((s) => s.password);
  const visible = messages.filter((m) => reactionTypeNum(m.associatedMessageType) < 2000);
  const latestVisible = visible[visible.length - 1];
  const latestVisibleKey = latestVisible ? `${latestVisible.guid}:${latestVisible.dateCreated}` : "";

  function handleReply(m: Message) {
    setReplyTarget(chatGUID, m);
  }

  async function handleReact(m: Message, reactionKey: string) {
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
  }

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

  if (loadingMessages && messages.length === 0) {
    return superlightMode ? (
      <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
        Loading messages…
      </div>
    ) : (
      <MessageListSkeleton />
    );
  }

  if (messages.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-2 text-muted-foreground">
        {!superlightMode && <MessagesSquare className="h-9 w-9 opacity-30" />}
        <p className="text-sm">No messages yet</p>
        <p className="text-xs opacity-70">Say hello 👋</p>
      </div>
    );
  }

  const reactionMap = buildReactionMap(messages);

  return (
    <div className="flex-1 relative min-h-0">
      <div
        ref={scrollRef}
        className="scrollbar-autohide absolute inset-0 overflow-y-auto overflow-x-hidden py-2 [overflow-anchor:none]"
      >
        <div
          ref={contentRef}
          className={cn(
            "transition-opacity duration-150",
            ready ? "opacity-100" : "opacity-0"
          )}
        >
          {visible.map((msg, i) => {
            const prev = visible[i - 1];
            const next = visible[i + 1];

            const showDateChip = !prev || !isSameDay(prev.dateCreated, msg.dateCreated);
            const showTimeHeader =
              showTimestamps && !showDateChip && (!prev || msg.dateCreated - prev.dateCreated > TIME_HEADER_MS);

            const sameSenderAsPrev =
              !!prev && senderKey(prev) === senderKey(msg) && msg.dateCreated - prev.dateCreated < GROUP_GAP_MS;
            const sameSenderAsNext =
              !!next && senderKey(next) === senderKey(msg) && next.dateCreated - msg.dateCreated < GROUP_GAP_MS;

            const isFirstInGroup = !sameSenderAsPrev;
            const isLastInGroup = !sameSenderAsNext;

            const showSender = isFirstInGroup && !msg.isFromMe;
            const showTime = showTimestamps && isLastInGroup;

            // Telegram messages carry their own aggregated emoji reactions;
            // iMessage messages derive theirs from tapback child-messages.
            const reactions = msg.tgReactions ?? reactionMap.get(msg.guid);

            return (
              <div key={msg.guid}>
                {showDateChip && (
                  superlightMode ? (
                    <div className="flex items-center justify-center my-4 px-4">
                      <span className="text-[11px] font-medium text-muted-foreground">
                        {formatDateChip(msg.dateCreated)}
                      </span>
                    </div>
                  ) : (
                    <div className="flex items-center gap-3 my-4 px-4">
                      <div className="flex-1 h-px bg-border" />
                      <span className="text-[10px] font-semibold tracking-[0.16em] uppercase text-muted-foreground">
                        {formatDateChip(msg.dateCreated)}
                      </span>
                      <div className="flex-1 h-px bg-border" />
                    </div>
                  )
                )}
                {showTimeHeader && (
                  <div className="flex items-center justify-center my-3">
                    <span className="text-[10px] font-medium text-muted-foreground">
                      {formatTimeOnly(msg.dateCreated)}
                    </span>
                  </div>
                )}
                <MessageBubble
                  message={msg}
                  showSender={showSender}
                  showTime={showTime}
                  reactions={reactions}
                  isFirstInGroup={isFirstInGroup}
                  isLastInGroup={isLastInGroup}
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
          "flex items-center gap-2 border text-xs font-medium",
          superlightMode ? "bg-background px-3 py-1.5" : "rounded-full bg-background shadow-lg px-4 py-2 transition-all duration-200",
          showJump ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4 pointer-events-none"
        )}
        aria-label="Jump to latest"
      >
        {!superlightMode && <ChevronDown className="h-3.5 w-3.5" />}
        {unseenCount > 0 ? `${unseenCount} new message${unseenCount > 1 ? "s" : ""}` : "Jump to latest"}
      </button>
    </div>
  );
}
