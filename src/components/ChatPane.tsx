import { useEffect, useRef, useState, type DragEvent } from "react";
import { ArrowLeft, Bot, Maximize2, Minimize2, X } from "lucide-react";
import { MessageList } from "@/components/MessageList";
import { MessageInput } from "@/components/MessageInput";
import { useAppStore, aiModeFor } from "@/store/useAppStore";
import { isSource } from "@/lib/source";
import { sl } from "@/slack/api";
import { parseSlChatGuid, slMessageToMessage } from "@/slack/adapters";
import { getClient } from "@/api/clientFactory";
import { getChatDisplayName, formatMessageTime } from "@/types";
import { accountOfGuid, fallbackAccountLabel } from "@/lib/accounts";
import { CHAT_DRAG_MIME } from "@/lib/triage";
import { tg } from "@/telegram/api";
import { parseTgChatGuid, tgMessageToMessage } from "@/telegram/adapters";
import { cn } from "@/lib/utils";

interface ChatPaneProps {
  paneId: string;
  chatGUID: string | null;
  isActive: boolean;
  canClose: boolean;
  showMobileBack?: boolean;
  /** ⌘N key of this pane (leaf order); omitted on the single mobile pane. */
  paneNumber?: number;
  totalPanes?: number;
}

/** 26×26 ghost icon button in the pane header. */
const paneIconButton =
  "inline-flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-md text-muted-foreground transition-[background-color] duration-120 hover:bg-muted hover:text-foreground";

export function ChatPane({
  paneId,
  chatGUID,
  isActive,
  canClose,
  showMobileBack,
  paneNumber,
  totalPanes = 1,
}: ChatPaneProps) {
  const selectedChat = useAppStore((s) =>
    chatGUID ? s.chats.find((c) => c.guid === chatGUID) : undefined
  );
  const presence = useAppStore((s) =>
    chatGUID ? s.telegramPresence[chatGUID] : undefined
  );
  // Bumped when Telegram becomes ready / an account changes; re-runs the
  // message load so a pane opened before the core was ready recovers.
  const telegramReloadNonce = useAppStore((s) => s.telegramReloadNonce);
  const slackReloadNonce = useAppStore((s) => s.slackReloadNonce);
  // Slack marks a message as ours by user id, which the history payload
  // doesn't carry — resolved from the workspace once connected.
  const slackSelfUserIds = useAppStore((s) => s.slackSelfUserIds);
  const serverUrl = useAppStore((s) => s.serverUrl);
  const password = useAppStore((s) => s.password);
  const setMessages = useAppStore((s) => s.setMessages);
  const mergeMessages = useAppStore((s) => s.mergeMessages);
  const setLoadingMessages = useAppStore((s) => s.setLoadingMessages);
  const setActivePane = useAppStore((s) => s.setActivePane);
  const focused = useAppStore((s) => s.focusedPaneId === paneId);
  const setFocusedPane = useAppStore((s) => s.setFocusedPane);
  const closePane = useAppStore((s) => s.closePane);
  const setPaneChat = useAppStore((s) => s.setPaneChat);
  const aiConfigured = useAppStore(
    (s) => s.aiReply.endpoint.trim().length > 0 && s.aiReply.model.trim().length > 0
  );
  const aiMode = useAppStore((s) => (chatGUID ? aiModeFor(s.aiReplyChats, chatGUID) : "off"));
  const cycleAiReplyChat = useAppStore((s) => s.cycleAiReplyChat);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const paneRef = useRef<HTMLDivElement>(null);

  // Focus counts as reading. A message landing in the chat this pane shows
  // used to leave a red marker that only cleared by re-selecting the chat in
  // the sidebar; now it clears as soon as this pane is active in a focused
  // window — whether the message arrived just now or while the app was in
  // the background (the once-listener catches the window refocus).
  const unreadCount = selectedChat?.unreadCount ?? 0;
  const markChatViewed = useAppStore((s) => s.markChatViewed);
  useEffect(() => {
    if (!isActive || !chatGUID || unreadCount === 0) return;
    const view = () => {
      markChatViewed(chatGUID);
      // Telegram has a wired read receipt; mirror what opening the chat does.
      if (isSource(chatGUID, "telegram")) {
        const { accountId, chatId } = parseTgChatGuid(chatGUID);
        void tg.markRead(accountId, chatId).catch(() => {});
      }
    };
    if (document.hasFocus()) {
      view();
      return;
    }
    window.addEventListener("focus", view, { once: true });
    return () => window.removeEventListener("focus", view);
  }, [isActive, chatGUID, unreadCount, markChatViewed]);

  useEffect(() => {
    if (!chatGUID) return;
    let cancelled = false;
    setFetchError(null);

    const snapshot = useAppStore.getState();
    const cached = snapshot.messages[chatGUID] ?? [];
    const hasCached = cached.length > 0;
    const lastFetchedAt = snapshot.messageFetchedAt[chatGUID] ?? 0;

    if (!hasCached) setLoadingMessages(true);

    // Slack history comes from the sl_* commands.
    if (isSource(chatGUID, "slack")) {
      const { workspaceId, channelId } = parseSlChatGuid(chatGUID);
      const selfUserId = slackSelfUserIds[workspaceId] ?? null;
      sl.history(workspaceId, channelId, 50)
        .then((slMsgs) => {
          if (cancelled) return;
          // conversations.history returns newest-first; MessageList renders in
          // array order with the newest at the bottom.
          const ordered = slMsgs
            .map((m) =>
              slMessageToMessage(
                workspaceId,
                channelId,
                m,
                selfUserId,
                useAppStore.getState().slackUserNames[workspaceId] ?? {}
              )
            )
            .sort((a, b) => a.dateCreated - b.dateCreated);
          setMessages(chatGUID, ordered);
        })
        .catch((e: unknown) => {
          if (!cancelled) setFetchError(String(e));
        })
        .finally(() => {
          if (!cancelled) setLoadingMessages(false);
        });
      return () => {
        cancelled = true;
      };
    }

    // Telegram chats load through the tg_* commands, not BlueBubbles.
    if (isSource(chatGUID, "telegram")) {
      const { accountId, chatId } = parseTgChatGuid(chatGUID);
      tg.messages(accountId, chatId, undefined, 50)
        .then((tgMsgs) => {
          if (cancelled) return;
          // tg_messages returns newest-first; MessageList renders array order
          // with the newest at the bottom, so sort ascending by time.
          const ordered = tgMsgs
            .map(tgMessageToMessage)
            .sort((a, b) => a.dateCreated - b.dateCreated);
          setMessages(chatGUID, ordered);
          // Opening a chat marks it read (server + local via tg:core-event).
          void tg.markRead(accountId, chatId).catch(() => {});
        })
        .catch((e: unknown) => {
          if (!cancelled) setFetchError(String(e));
        })
        .finally(() => {
          if (!cancelled) setLoadingMessages(false);
        });
      return () => {
        cancelled = true;
      };
    }

    const client = getClient(serverUrl, password);
    const after = hasCached ? lastFetchedAt : undefined;

    client
      .getMessages(chatGUID, 50, after)
      .then(async (msgs) => {
        if (cancelled) return;
        // An empty delta means nothing arrived since lastFetchedAt — the normal
        // answer when reopening a quiet chat. It used to trigger a second,
        // full-window fetch (doubling every reopen) as a workaround for the
        // cursor being poisoned by optimistic sends; that cause is fixed in
        // upsertMessage, so trust the empty response. Real failures land in
        // .catch below.
        if (hasCached && msgs.length === 0) return;
        if (hasCached) mergeMessages(chatGUID, msgs);
        else setMessages(chatGUID, msgs);
      })
      .catch((e: unknown) => {
        if (!cancelled) setFetchError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoadingMessages(false);
      });

    return () => {
      cancelled = true;
    };
    // Each nonce is a single-source signal. Keeping them unconditional re-ran
    // this whole effect — including the BlueBubbles fetch — for every open
    // iMessage pane each time Telegram or Slack reloaded.
  }, [
    chatGUID,
    serverUrl,
    password,
    isSource(chatGUID ?? "", "telegram") ? telegramReloadNonce : 0,
    isSource(chatGUID ?? "", "slack") ? slackReloadNonce : 0,
    isSource(chatGUID ?? "", "slack") ? slackSelfUserIds : null,
  ]);

  const empty = !chatGUID || !selectedChat;

  useEffect(() => {
    if (!isActive || empty) return;
    const id = requestAnimationFrame(() => {
      const t = paneRef.current?.querySelector("textarea");
      t?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(id);
  }, [isActive, empty, chatGUID]);

  const workspaceLabel = useAppStore((s) => {
    if (!chatGUID || !isSource(chatGUID, "slack")) return null;
    const ref = accountOfGuid(chatGUID);
    return s.accountLabels[ref.key] ?? fallbackAccountLabel(ref);
  });
  const sourceMeta = !chatGUID
    ? null
    : isSource(chatGUID, "slack")
      ? `slack · ${workspaceLabel}`
      : isSource(chatGUID, "telegram")
        ? "tg"
        : "imessage";

  const [dropOver, setDropOver] = useState(false);
  const isChatDrag = (e: DragEvent) => e.dataTransfer.types.includes(CHAT_DRAG_MIME);

  const ring = dropOver
    ? "shadow-[0_0_0_1.5px_hsl(var(--signal))]"
    : isActive
      ? "shadow-[0_0_0_1.5px_hsl(var(--primary))]"
      : "shadow-[0_0_0_1px_hsl(var(--border))]";

  return (
    <div
      ref={paneRef}
      onMouseDown={() => {
        if (!isActive) setActivePane(paneId);
        const textarea = paneRef.current?.querySelector("textarea");
        if (textarea && document.activeElement !== textarea) {
          textarea.focus({ preventScroll: true });
        }
      }}
      // Drop a sidebar row/card here to open that chat in this pane.
      onDragEnter={(e) => {
        if (isChatDrag(e)) setDropOver(true);
      }}
      onDragOver={(e) => {
        if (!isChatDrag(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropOver(false);
      }}
      onDrop={(e) => {
        const guid = e.dataTransfer.getData(CHAT_DRAG_MIME);
        setDropOver(false);
        if (!guid) return;
        e.preventDefault();
        setPaneChat(paneId, guid);
      }}
      className={cn(
        "relative flex h-full min-h-0 w-full flex-col overflow-hidden rounded-[10px] bg-panel",
        ring
      )}
    >
      <div className="flex shrink-0 items-center gap-2.5 border-b px-3 py-2.5">
        {showMobileBack && (
          <button
            type="button"
            className={cn(paneIconButton, "md:hidden")}
            onClick={() => setPaneChat(paneId, null)}
            aria-label="Back to chats"
          >
            <ArrowLeft className="h-[15px] w-[15px]" />
          </button>
        )}

        {paneNumber != null && (
          <span
            className={cn(
              "shrink-0 whitespace-nowrap rounded px-1.5 py-px font-mono text-cc-meta",
              isActive ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
            )}
          >
            ⌘{paneNumber}
          </span>
        )}

        {empty ? (
          <span className="min-w-0 truncate text-cc-title font-semibold text-muted-foreground">
            Empty pane
          </span>
        ) : (
          <>
            <span className="min-w-0 truncate text-cc-title font-semibold">
              {getChatDisplayName(selectedChat)}
            </span>
            <span className="shrink-0 whitespace-nowrap font-mono text-cc-chip text-muted-foreground">
              {sourceMeta}
              {presence && (presence.online || presence.lastSeen) && (
                <>
                  {" · "}
                  <span className={cn(presence.online && "text-[#16a34a] dark:text-[#4ade80]")}>
                    {presence.online
                      ? "online"
                      : `last seen ${formatMessageTime(presence.lastSeen as number)}`}
                  </span>
                </>
              )}
            </span>
          </>
        )}

        <span className="flex-1" />

        <div className="flex shrink-0 items-center gap-0.5">
          {!empty && aiConfigured && (
            <button
              type="button"
              className={cn(
                paneIconButton,
                aiMode === "draft" && "text-foreground",
                aiMode === "auto" && "text-signal hover:text-signal"
              )}
              onClick={() => chatGUID && cycleAiReplyChat(chatGUID)}
              aria-label="Cycle AI reply mode"
              title={
                aiMode === "off"
                  ? "AI replies off — click for draft mode (suggestions in the composer)"
                  : aiMode === "draft"
                    ? "AI draft mode: suggestions land in the composer — click for auto-send"
                    : "AI auto-send is ON for this chat — click to turn off"
              }
            >
              <Bot className="h-[15px] w-[15px]" />
            </button>
          )}
          {(totalPanes > 1 || focused) && (
            <button
              type="button"
              className={cn(paneIconButton, "hidden md:inline-flex", focused && "text-foreground")}
              onClick={() => setFocusedPane(focused ? null : paneId)}
              aria-label={focused ? "Exit focus mode" : "Focus this pane"}
              aria-pressed={focused}
              title={focused ? "Show all panes (Esc)" : "Focus this pane"}
            >
              {focused ? (
                <Minimize2 className="h-3.5 w-3.5" />
              ) : (
                <Maximize2 className="h-3.5 w-3.5" />
              )}
            </button>
          )}
          {canClose && (
            <button
              type="button"
              className={paneIconButton}
              onClick={() => closePane(paneId)}
              aria-label="Close pane"
              title="Close pane"
            >
              <X className="h-[15px] w-[15px]" />
            </button>
          )}
        </div>
      </div>

      {empty ? (
        <div className="flex flex-1 items-center justify-center p-4 text-center text-cc-body text-muted-foreground">
          Pick a chat, or press ⌘K
        </div>
      ) : fetchError ? (
        <div className="flex flex-1 items-center justify-center p-4 text-center text-cc-body text-signal">
          {fetchError}
        </div>
      ) : (
        <>
          {/* Remount per chat so first-load scroll + ready state start clean.
              Reusing one instance across chats could leave a cached chat's
              history stuck at opacity-0 until the next interaction. */}
          <MessageList key={chatGUID} chatGUID={chatGUID!} />
          <MessageInput chatGUID={chatGUID!} />
        </>
      )}
    </div>
  );
}
