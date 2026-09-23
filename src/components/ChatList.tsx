import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Star } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ChatItem, type ChatSelectOptions } from "@/components/ChatItem";
import { ChatListSkeleton } from "@/components/ChatListSkeleton";
import { useAppStore } from "@/store/useAppStore";
import { usePaneNumbers } from "@/hooks/usePaneNumbers";
import { loadIMessageChats } from "@/lib/loadChats";
import { filterChats, triage } from "@/lib/triage";
import { isSource } from "@/lib/source";
import { tg } from "@/telegram/api";
import { parseTgChatGuid } from "@/telegram/adapters";
import { cn } from "@/lib/utils";

/** Card fold-out duration for "E done" — matches the ChatItem transition. */
const DONE_ANIMATION_MS = 160;

function SectionHeader({
  title,
  meta,
  metaClassName,
  first = false,
}: {
  title: string;
  meta?: ReactNode;
  metaClassName?: string;
  first?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex items-baseline justify-between px-4",
        first ? "pb-2 pt-4" : "pb-1.5 pt-[18px]"
      )}
    >
      <h2 className="whitespace-nowrap text-cc-title font-semibold">{title}</h2>
      {meta != null && (
        <span className={cn("whitespace-nowrap font-mono text-cc-meta text-muted-foreground", metaClassName)}>
          {meta}
        </span>
      )}
    </div>
  );
}

/**
 * The sidebar as a triage queue: "Waiting on you" (unread, as cards), then
 * Starred, then Recent (everything else, all sources mixed by recency). The
 * search input lives in the toolbar's command bar; its query filters here.
 */
export function ChatList() {
  // Narrow selectors: ChatList must not re-render on every WebSocket message,
  // typing event, or link-preview write. It only depends on the fields it
  // actually renders. Store actions are stable references across renders.
  const chats = useAppStore((s) => s.chats);
  const selectedChatGUID = useAppStore((s) => s.selectedChatGUID);
  const selectChat = useAppStore((s) => s.selectChat);
  const splitPane = useAppStore((s) => s.splitPane);
  const markChatViewed = useAppStore((s) => s.markChatViewed);
  const loadingChats = useAppStore((s) => s.loadingChats);
  const serverUrl = useAppStore((s) => s.serverUrl);
  const password = useAppStore((s) => s.password);
  const isConfigured = useAppStore((s) => s.isConfigured);
  const telegramAvailable = useAppStore((s) => s.telegramAvailable);
  const slackAvailable = useAppStore((s) => s.slackAvailable);
  // The list is shown if ANY messaging source is available — a Slack-only or
  // Telegram-only setup is as valid as an iMessage one.
  const hasAnySource = isConfigured || telegramAvailable || slackAvailable;
  const starredChats = useAppStore((s) => s.starredChats);
  const toggleStarred = useAppStore((s) => s.toggleStarred);
  const networkOnline = useAppStore((s) => s.networkOnline);
  const connectionNotice = useAppStore((s) => s.connectionNotice);
  const sidebarHidden = useAppStore((s) => s.sidebarHidden);
  // The command bar's input stays bound to the live chatQuery; the list
  // follows a deferred copy, so a keystroke (or clearing the bar, which
  // remounts every row) paints the input first and rebuilds the list in an
  // interruptible background render. Everything derived from the query below
  // uses the deferred value, so the sidebar stays consistent with itself.
  const liveQuery = useAppStore((s) => s.chatQuery);
  const query = useDeferredValue(liveQuery);
  const activePaneId = useAppStore((s) => s.activePaneId);
  const { byChat, byPane } = usePaneNumbers();
  const activePaneNumber = byPane.get(activePaneId);

  // Keyboard cursor, separate from the selection: ↑/↓ move it, ↵ opens.
  const [cursorGUID, setCursorGUID] = useState<string | null>(null);
  // Queue cards animating out after "E done".
  const [leaving, setLeaving] = useState<ReadonlySet<string>>(new Set());
  const leaveTimers = useRef(new Map<string, number>());

  useEffect(() => {
    void loadIMessageChats();
  }, [isConfigured, serverUrl, password]);

  useEffect(() => {
    const timers = leaveTimers.current;
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, []);

  const filteredChats = useMemo(() => filterChats(chats, query), [chats, query]);
  const { waiting, starred, recent } = useMemo(
    () => triage(filteredChats, starredChats),
    [filteredChats, starredChats]
  );

  // Keyboard navigation follows what is on screen: queue → starred → recent,
  // or just the queue and starred tiles on the compact rail.
  const visibleChats = useMemo(
    () => (sidebarHidden ? [...waiting, ...starred] : [...waiting, ...starred, ...recent]),
    [sidebarHidden, waiting, starred, recent]
  );

  const open = useCallback(
    (guid: string, opts?: ChatSelectOptions) => {
      setCursorGUID(guid);
      if (opts?.newPane) {
        splitPane(useAppStore.getState().activePaneId, "horizontal", guid);
      } else {
        selectChat(guid);
      }
    },
    [selectChat, splitPane]
  );

  const done = useCallback(
    (guid: string) => {
      if (leaveTimers.current.has(guid)) return;
      setLeaving((prev) => new Set(prev).add(guid));
      const t = window.setTimeout(() => {
        leaveTimers.current.delete(guid);
        markChatViewed(guid);
        // Telegram has a wired read receipt; mirror what opening the chat does.
        if (isSource(guid, "telegram")) {
          const { accountId, chatId } = parseTgChatGuid(guid);
          void tg.markRead(accountId, chatId).catch(() => {});
        }
        setLeaving((prev) => {
          const next = new Set(prev);
          next.delete(guid);
          return next;
        });
      }, DONE_ANIMATION_MS);
      leaveTimers.current.set(guid, t);
    },
    [markChatViewed]
  );

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable) return;
      if (tag === "BUTTON" || target?.closest?.("[role=dialog]")) return;
      if (e.metaKey || e.ctrlKey) return;

      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        if (visibleChats.length === 0) return;
        e.preventDefault();
        const from = cursorGUID ?? selectedChatGUID;
        const idx = visibleChats.findIndex((c) => c.guid === from);
        const next =
          idx < 0
            ? 0
            : e.key === "ArrowDown"
              ? Math.min(visibleChats.length - 1, idx + 1)
              : Math.max(0, idx - 1);
        setCursorGUID(visibleChats[next].guid);
        return;
      }

      const cursorChat = cursorGUID ? visibleChats.find((c) => c.guid === cursorGUID) : undefined;
      if (!cursorChat) return;
      if (e.key === "Enter") {
        e.preventDefault();
        open(cursorChat.guid, { newPane: e.altKey });
      } else if ((e.key === "e" || e.key === "E") && !e.altKey && !e.shiftKey) {
        if (!waiting.some((c) => c.guid === cursorChat.guid)) return;
        e.preventDefault();
        done(cursorChat.guid);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visibleChats, cursorGUID, selectedChatGUID, open, done, waiting]);

  function paneKeyProps(guid: string) {
    const n = byChat.get(guid);
    return { paneKey: n, paneKeyActive: n != null && n === activePaneNumber };
  }

  const notices = !sidebarHidden && (
    <>
      {!networkOnline && (
        <div className="border-b px-4 py-2 text-cc-meta text-signal">
          You are offline. Trying to reconnect automatically…
        </div>
      )}
      {connectionNotice && (
        <div className="border-b px-4 py-2 text-cc-meta text-muted-foreground">{connectionNotice}</div>
      )}
    </>
  );

  let body: ReactNode;
  if (!hasAnySource) {
    body = !sidebarHidden && (
      <div className="p-6 text-center text-cc-body text-muted-foreground">
        <p>Connect a source to get started.</p>
        <p className="mt-1">Open settings in the toolbar.</p>
      </div>
    );
  } else if (loadingChats && chats.length === 0) {
    body = !sidebarHidden && <ChatListSkeleton />;
  } else if (filteredChats.length === 0) {
    body = !sidebarHidden && (
      <div className="p-6 text-center text-cc-body text-muted-foreground">
        {query ? `No chats match "${query}".` : "No chats found."}
      </div>
    );
  } else if (sidebarHidden) {
    // Compact rail: tiles only. The queue collapses to tiles with a signal dot.
    body = (
      <div className="flex flex-col items-center gap-1 py-2.5">
        {[...waiting, ...starred].map((chat) => (
          <ChatItem
            key={chat.guid}
            chat={chat}
            variant="compact"
            isSelected={chat.guid === selectedChatGUID}
            isCursor={chat.guid === cursorGUID}
            onSelect={open}
          />
        ))}
      </div>
    );
  } else {
    body = (
      <div className="pb-2.5">
        <SectionHeader
          first
          title="Waiting on you"
          meta={waiting.length > 0 ? `${waiting.length} new` : "all clear"}
          metaClassName={waiting.length > 0 ? "text-signal" : undefined}
        />
        {waiting.length > 0 && (
          <div className="flex flex-col gap-1.5 px-2.5">
            {waiting.map((chat) => (
              <ChatItem
                key={chat.guid}
                chat={chat}
                variant="card"
                isSelected={chat.guid === selectedChatGUID}
                isCursor={chat.guid === cursorGUID}
                onSelect={open}
                onDone={done}
                leaving={leaving.has(chat.guid)}
              />
            ))}
          </div>
        )}

        {/* Shown with a teaching hint until the first pin exists; hidden
            while a search filters the starred chats away. */}
        {(starred.length > 0 || (starredChats.length === 0 && !query)) && (
          <>
            <SectionHeader title="Starred" />
            {starred.length > 0 ? (
              starred.map((chat) => (
                <ChatItem
                  key={chat.guid}
                  chat={chat}
                  variant="starred"
                  isSelected={chat.guid === selectedChatGUID}
                  isCursor={chat.guid === cursorGUID}
                  onSelect={open}
                  starred
                  onToggleStar={toggleStarred}
                  {...paneKeyProps(chat.guid)}
                />
              ))
            ) : (
              <p className="flex items-center gap-1.5 px-4 text-cc-meta text-muted-foreground">
                Hover a chat and click
                <Star className="inline h-3 w-3 shrink-0" />
                to pin it here.
              </p>
            )}
          </>
        )}

        {recent.length > 0 && (
          <>
            <SectionHeader title="Recent" meta="all sources" />
            {recent.map((chat) => (
              <ChatItem
                key={chat.guid}
                chat={chat}
                variant="row"
                isSelected={chat.guid === selectedChatGUID}
                isCursor={chat.guid === cursorGUID}
                onSelect={open}
                starred={false}
                onToggleStar={toggleStarred}
                {...paneKeyProps(chat.guid)}
              />
            ))}
          </>
        )}
      </div>
    );
  }

  return (
    <div className="app-sidebar flex h-full min-h-0 flex-col">
      {notices}
      <ScrollArea className="flex-1">{body}</ScrollArea>
    </div>
  );
}
