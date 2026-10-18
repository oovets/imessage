import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ChevronRight, Star } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ChatItem, type ChatSelectOptions } from "@/components/ChatItem";
import { ChatListSkeleton } from "@/components/ChatListSkeleton";
import { useAppStore } from "@/store/useAppStore";
import { usePaneNumbers } from "@/hooks/usePaneNumbers";
import { loadIMessageChats } from "@/lib/loadChats";
import {
  SOURCE_NAME,
  SOURCE_TAG,
  activeSourceFilter,
  filterChats,
  nextTriageChange,
  summarizeSources,
  triage,
  type ChatListGrouping,
  type SourceSummary,
} from "@/lib/triage";
import { isSource, type ChatSource } from "@/lib/source";
import { networkGroups, type NetworkGroup } from "@/lib/accounts";
import { tg } from "@/telegram/api";
import { parseTgChatGuid } from "@/telegram/adapters";
import { cn } from "@/lib/utils";
import { openSettings } from "@/lib/openSettings";
import { whenDue, type Chat } from "@/types";

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
 * One chip per network the chats come from, plus All: narrows the whole
 * sidebar to that network. Chips carry the rows' source tags, so they fit
 * one line; keys 0 (all) and 1–n follow them, shown while the row is hovered.
 */
function SourceFilter({
  sources,
  active,
  onPick,
}: {
  sources: SourceSummary[];
  active: ChatSource | null;
  onPick: (source: ChatSource | null) => void;
}) {
  const chip = (key: string, source: ChatSource | null, waiting = 0) => {
    const on = active === source;
    const name = source ? SOURCE_NAME[source] : "All networks";
    return (
      <button
        key={key}
        type="button"
        aria-pressed={on}
        aria-keyshortcuts={key}
        aria-label={waiting > 0 ? `${name}, ${waiting} waiting` : name}
        title={`${source ? `Only ${name}` : name} (${key})`}
        // Clicking the network that is on goes back to all of them.
        onClick={() => onPick(on && source ? null : source)}
        className={cn(
          "relative flex h-[22px] items-center gap-1 whitespace-nowrap rounded-md px-1.5 font-mono text-cc-meta",
          on
            ? "bg-muted text-foreground shadow-[inset_0_0_0_1px_hsl(var(--border))]"
            : "text-muted-foreground hover:bg-muted hover:text-foreground"
        )}
      >
        {source ? SOURCE_TAG[source] : "all"}
        {waiting > 0 && <span className="text-signal">{waiting}</span>}
        <span
          aria-hidden
          className="pointer-events-none absolute -right-0.5 -top-1.5 text-[9px] leading-none text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
        >
          {key}
        </span>
      </button>
    );
  };
  return (
    <div
      role="toolbar"
      aria-label="Show one network"
      className="group flex shrink-0 items-center gap-1 px-2.5 pt-2.5"
    >
      {chip("0", null)}
      {sources.map((s, i) => chip(String(i + 1), s.source, s.waiting))}
    </div>
  );
}

/** "time · network": how Recent is ordered. G toggles it. */
function GroupingToggle({
  grouping,
  onChange,
}: {
  grouping: ChatListGrouping;
  onChange: (grouping: ChatListGrouping) => void;
}) {
  const option = (value: ChatListGrouping) => (
    <button
      type="button"
      aria-pressed={grouping === value}
      onClick={() => onChange(value)}
      className={cn("hover:text-foreground", grouping === value && "text-foreground")}
    >
      {value}
    </button>
  );
  return (
    <span role="group" aria-label="Sort Recent by" title="Sort Recent by time or network (G)" className="flex gap-1">
      {option("time")}
      <span aria-hidden>·</span>
      {option("network")}
    </span>
  );
}

/** "Slack · Acme": the network, then the account where it has a name of its own. */
function groupTitle(group: NetworkGroup): string {
  const network = SOURCE_NAME[group.ref.source];
  return group.label.startsWith(network) ? group.label : `${network} · ${group.label}`;
}

function GroupHeader({ group, onToggle }: { group: NetworkGroup; onToggle: (key: string) => void }) {
  return (
    <button
      type="button"
      aria-expanded={!group.collapsed}
      onClick={() => onToggle(group.ref.key)}
      className="flex w-full items-center gap-1 px-3 pb-1 pt-3 font-mono text-cc-chip uppercase tracking-wide text-muted-foreground hover:text-foreground"
    >
      <ChevronRight
        className={cn("h-3 w-3 shrink-0 transition-transform", !group.collapsed && "rotate-90")}
      />
      <span className="truncate">{groupTitle(group)}</span>
      <span className="ml-auto pl-2">{group.chats.length}</span>
    </button>
  );
}

/**
 * The sidebar as a triage queue: "Waiting on you" (unread and not muted, as
 * cards), then Starred, then Recent (everything else, by recency or grouped
 * by network). The search input lives in the toolbar's command bar; its
 * query filters here, and so does the network filter above the list.
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
  const ircAvailable = useAppStore((s) => s.ircAvailable);
  // The list is shown if ANY messaging source is available — a Slack-only or
  // Telegram-only setup is as valid as an iMessage one.
  const hasAnySource = isConfigured || telegramAvailable || slackAvailable || ircAvailable;
  const starredChats = useAppStore((s) => s.starredChats);
  const toggleStarred = useAppStore((s) => s.toggleStarred);
  const sidebarHidden = useAppStore((s) => s.sidebarHidden);
  // The command bar's input stays bound to the live chatQuery; the list
  // follows a deferred copy, so a keystroke (or clearing the bar, which
  // remounts every row) paints the input first and rebuilds the list in an
  // interruptible background render. Everything derived from the query below
  // uses the deferred value, so the sidebar stays consistent with itself.
  const liveQuery = useAppStore((s) => s.chatQuery);
  const query = useDeferredValue(liveQuery);
  const sourceFilterSetting = useAppStore((s) => s.chatSourceFilter);
  const setSourceFilter = useAppStore((s) => s.setChatSourceFilter);
  const grouping = useAppStore((s) => s.chatListGrouping);
  const setGrouping = useAppStore((s) => s.setChatListGrouping);
  const accountLabels = useAppStore((s) => s.accountLabels);
  const collapsedAccounts = useAppStore((s) => s.collapsedAccounts);
  const toggleAccountCollapsed = useAppStore((s) => s.toggleAccountCollapsed);
  const activePaneId = useAppStore((s) => s.activePaneId);
  const { byChat, byPane } = usePaneNumbers();
  const activePaneNumber = byPane.get(activePaneId);

  // Keyboard cursor, separate from the selection: ↑/↓ move it, ↵ opens.
  const [cursorGUID, setCursorGUID] = useState<string | null>(null);
  // Queue cards animating out after "E done".
  const [leaving, setLeaving] = useState<ReadonlySet<string>>(new Set());
  const leaveTimers = useRef(new Map<string, number>());
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void loadIMessageChats();
  }, [isConfigured, serverUrl, password]);

  useEffect(() => {
    const timers = leaveTimers.current;
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, []);

  // A muted unread chat joins the queue once its mute lapses, and nothing
  // re-renders the sidebar then; so triage is re-run at the earliest lapse
  // (the effect below). The compact rail shows these same sections.
  const [clockTick, setClockTick] = useState(0);

  // The network filter row, and the filter itself, belong to the full
  // sidebar: the compact rail has no row to show or clear it, so it lists
  // every network. One network has nothing to filter.
  // clockTick: a lapsed mute also changes what a network has waiting.
  const sources = useMemo(() => summarizeSources(chats), [chats, clockTick]);
  const showSourceFilter = !sidebarHidden && sources.length > 1;
  const sourceFilter = showSourceFilter ? activeSourceFilter(chats, sourceFilterSetting) : null;
  const filteredChats = useMemo(
    () => filterChats(chats, query, sourceFilter),
    [chats, query, sourceFilter]
  );
  const { waiting, starred, recent, triagedAt } = useMemo(() => {
    const now = Date.now();
    return { ...triage(filteredChats, starredChats, now), triagedAt: now };
    // clockTick: a mute lapsed since the last triage.
  }, [filteredChats, starredChats, clockTick]);
  useEffect(
    () => whenDue(nextTriageChange(filteredChats, triagedAt), () => setClockTick((n) => n + 1)),
    // triagedAt is the clock the shown sections were split at.
    [filteredChats, triagedAt]
  );

  const groups = useMemo(
    () => (grouping === "network" ? networkGroups(recent, accountLabels, collapsedAccounts) : null),
    [grouping, recent, accountLabels, collapsedAccounts]
  );
  // Keyboard navigation follows what is on screen: queue → starred → recent
  // (minus folded groups), or just the queue and starred tiles on the rail.
  const visibleChats = useMemo(() => {
    if (sidebarHidden) return [...waiting, ...starred];
    const shownRecent = groups ? groups.flatMap((g) => (g.collapsed ? [] : g.chats)) : recent;
    return [...waiting, ...starred, ...shownRecent];
  }, [sidebarHidden, waiting, starred, recent, groups]);
  // The list is one Tab stop (roving tabindex): the cursor's item, else the
  // open chat's, else the first; ↑/↓ move between items from there.
  const tabStopGUID =
    visibleChats.find((c) => c.guid === cursorGUID)?.guid ??
    visibleChats.find((c) => c.guid === selectedChatGUID)?.guid ??
    visibleChats[0]?.guid;

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
      // An item already acted on it (↵ / Space on a focused row).
      if (e.defaultPrevented) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable) return;
      if (target?.closest?.("[role=dialog]")) return;
      if (e.metaKey || e.ctrlKey) return;

      // 0 shows every network, 1–n one of them (again: all); G sorts Recent
      // by time or network. Also from a focused button, such as a chip.
      if (!e.altKey && !e.shiftKey && !sidebarHidden) {
        if (showSourceFilter && /^[0-9]$/.test(e.key)) {
          const n = Number(e.key);
          if (n > sources.length) return;
          e.preventDefault();
          const source = n === 0 ? null : sources[n - 1].source;
          setSourceFilter(source === sourceFilter ? null : source);
          return;
        }
        if (e.key === "g" || e.key === "G") {
          e.preventDefault();
          setGrouping(grouping === "time" ? "network" : "time");
          return;
        }
      }
      if (tag === "BUTTON") return;

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
        const guid = visibleChats[next].guid;
        setCursorGUID(guid);
        // Focus follows the cursor, which also scrolls it into view.
        requestAnimationFrame(() => {
          const items = listRef.current?.querySelectorAll<HTMLElement>("[data-chat-guid]") ?? [];
          for (const el of items) {
            if (el.dataset.chatGuid === guid) {
              el.focus({ preventScroll: false });
              break;
            }
          }
        });
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
      } else if ((e.key === "s" || e.key === "S") && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        toggleStarred(cursorChat.guid);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    visibleChats,
    cursorGUID,
    selectedChatGUID,
    open,
    done,
    waiting,
    toggleStarred,
    sidebarHidden,
    showSourceFilter,
    sources,
    sourceFilter,
    setSourceFilter,
    grouping,
    setGrouping,
  ]);

  function paneKeyProps(guid: string) {
    const n = byChat.get(guid);
    return { paneKey: n, paneKeyActive: n != null && n === activePaneNumber };
  }

  function recentRow(chat: Chat) {
    return (
      <ChatItem
        key={chat.guid}
        chat={chat}
        variant="row"
        isSelected={chat.guid === selectedChatGUID}
        isCursor={chat.guid === cursorGUID}
        tabStop={chat.guid === tabStopGUID}
        onSelect={open}
        starred={false}
        onToggleStar={toggleStarred}
        {...paneKeyProps(chat.guid)}
      />
    );
  }

  let body: ReactNode;
  if (!hasAnySource) {
    body = !sidebarHidden && (
      <div className="p-6 text-center text-cc-body text-muted-foreground">
        <p>Connect a source to get started.</p>
        <button
          type="button"
          onClick={openSettings}
          className="mt-3 h-7 rounded-md bg-primary px-2.5 font-medium text-primary-foreground"
        >
          Open settings
        </button>
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
    // Compact rail: tiles only. The queue collapses to tiles with a signal dot
    // (not a starred chat that is unread but muted).
    body = (
      <div className="flex flex-col items-center gap-1 py-2.5">
        {[...waiting, ...starred].map((chat, i) => (
          <ChatItem
            key={chat.guid}
            chat={chat}
            variant="compact"
            isSelected={chat.guid === selectedChatGUID}
            isCursor={chat.guid === cursorGUID}
            tabStop={chat.guid === tabStopGUID}
            onSelect={open}
            queued={i < waiting.length}
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
                tabStop={chat.guid === tabStopGUID}
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
                  tabStop={chat.guid === tabStopGUID}
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
            <SectionHeader
              title="Recent"
              meta={<GroupingToggle grouping={grouping} onChange={setGrouping} />}
            />
            {groups
              ? groups.map((group) => (
                  <div key={group.ref.key}>
                    {/* A lone group would only repeat the filter chip. */}
                    {groups.length > 1 && (
                      <GroupHeader group={group} onToggle={toggleAccountCollapsed} />
                    )}
                    {!group.collapsed && group.chats.map(recentRow)}
                  </div>
                ))
              : recent.map(recentRow)}
          </>
        )}
      </div>
    );
  }

  return (
    <div
      ref={listRef}
      // Tabbing (or clicking) onto an item puts the keyboard cursor there.
      onFocus={(e) => {
        const guid = (e.target as HTMLElement).dataset?.chatGuid;
        if (guid) setCursorGUID(guid);
      }}
      className="app-sidebar flex h-full min-h-0 flex-col"
    >
      {showSourceFilter && hasAnySource && (
        <SourceFilter sources={sources} active={sourceFilter} onPick={setSourceFilter} />
      )}
      <ScrollArea className="flex-1">{body}</ScrollArea>
    </div>
  );
}
