import { useEffect, useMemo, useRef, useState } from "react";
import { PanelLeftClose, PanelLeftOpen, RefreshCw, MessageCircle, Search, X, ChevronRight, Star } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { SettingsDialog } from "@/components/SettingsDialog";
import { AiSimulatorDialog } from "@/components/AiSimulatorDialog";
import { ThemeToggle } from "@/components/ThemeToggle";
import { ChatItem } from "@/components/ChatItem";
import { ChatListSkeleton } from "@/components/ChatListSkeleton";
import { useAppStore } from "@/store/useAppStore";
import { getClient } from "@/api/clientFactory";
import { groupChatsByAccount } from "@/lib/accounts";
import { decodeEscapedUnicode, getChatDisplayName, type Chat } from "@/types";
import { cn } from "@/lib/utils";

function formatConnectionError(err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
  return `Unable to reach your BlueBubbles server: ${detail}`;
}

export function ChatList() {
  // Narrow selectors: ChatList must not re-render on every WebSocket message,
  // typing event, or link-preview write. It only depends on the fields it
  // actually renders. Store actions are stable references across renders.
  const chats = useAppStore((s) => s.chats);
  const selectedChatGUID = useAppStore((s) => s.selectedChatGUID);
  const selectChat = useAppStore((s) => s.selectChat);
  const setChats = useAppStore((s) => s.setChats);
  const setLoadingChats = useAppStore((s) => s.setLoadingChats);
  const loadingChats = useAppStore((s) => s.loadingChats);
  const serverUrl = useAppStore((s) => s.serverUrl);
  const password = useAppStore((s) => s.password);
  const isConfigured = useAppStore((s) => s.isConfigured);
  const telegramAvailable = useAppStore((s) => s.telegramAvailable);
  const slackAvailable = useAppStore((s) => s.slackAvailable);
  // The list is shown if ANY messaging source is available — a Slack-only or
  // Telegram-only setup is as valid as an iMessage one.
  const hasAnySource = isConfigured || telegramAvailable || slackAvailable;
  const accountLabels = useAppStore((s) => s.accountLabels);
  const collapsedAccounts = useAppStore((s) => s.collapsedAccounts);
  const toggleAccountCollapsed = useAppStore((s) => s.toggleAccountCollapsed);
  const starredChats = useAppStore((s) => s.starredChats);
  const toggleStarred = useAppStore((s) => s.toggleStarred);
  const wsConnected = useAppStore((s) => s.wsConnected);
  const pollingFallback = useAppStore((s) => s.pollingFallback);
  const superlightMode = useAppStore((s) => s.superlightMode);
  const networkOnline = useAppStore((s) => s.networkOnline);
  const connectionNotice = useAppStore((s) => s.connectionNotice);
  const setConnectionNotice = useAppStore((s) => s.setConnectionNotice);
  const sidebarHidden = useAppStore((s) => s.sidebarHidden);
  const toggleSidebarHidden = useAppStore((s) => s.toggleSidebarHidden);

  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  async function loadChats() {
    if (!isConfigured) return;
    setLoadingChats(true);
    let baseChats: Chat[];
    try {
      const client = getClient(serverUrl, password);
      baseChats = await client.getChats();
      const previousByGuid = new Map(
        useAppStore.getState().chats.map((c) => [c.guid, c])
      );
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

  useEffect(() => {
    loadChats();
  }, [isConfigured, serverUrl, password]);

  const filteredChats = useMemo(() => {
    if (!query.trim()) return chats;
    const q = query.toLowerCase();
    return chats.filter((c) => {
      const name = getChatDisplayName(c).toLowerCase();
      const preview = decodeEscapedUnicode(c.lastMessageText ?? c.lastMessage?.text ?? "").toLowerCase();
      return name.includes(q) || preview.includes(q);
    });
  }, [chats, query]);

  // Group by account (iMessage, each Telegram login, each Slack workspace).
  // With a single account there is nothing to separate, so the headers are
  // skipped entirely rather than showing one redundant "iMessage" row.
  const groups = useMemo(
    () => groupChatsByAccount(filteredChats, accountLabels),
    [filteredChats, accountLabels]
  );
  const grouped = groups.length > 1;

  // Starred: pinned from any source, in recency order (filteredChats already
  // is). They also stay in their account group — the star is a shortcut, not
  // a move.
  const starredList = useMemo(() => {
    if (starredChats.length === 0) return [];
    const set = new Set(starredChats);
    return filteredChats.filter((c) => set.has(c.guid));
  }, [filteredChats, starredChats]);

  // The collapsed rail answers one question: "what needs me right now?" —
  // starred chats, then anything unread by recency. The full recency-sorted
  // list read as an inscrutable jumble of avatars at this width.
  const compactChats = useMemo(() => {
    const set = new Set(starredChats);
    return [
      ...starredList,
      ...filteredChats.filter((c) => (c.unreadCount ?? 0) > 0 && !set.has(c.guid)),
    ];
  }, [starredList, filteredChats, starredChats]);

  // Keyboard navigation must follow what is actually on screen — skipping
  // chats hidden inside a collapsed group or off the compact rail.
  const visibleChats = useMemo(() => {
    if (sidebarHidden) return compactChats;
    const expanded = grouped
      ? groups.flatMap((g) => (collapsedAccounts.includes(g.ref.key) ? [] : g.chats))
      : filteredChats;
    return [...starredList, ...expanded];
  }, [sidebarHidden, compactChats, grouped, groups, collapsedAccounts, filteredChats, starredList]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
        return;
      }
      const tag = (e.target as HTMLElement)?.tagName;
      const inField = tag === "INPUT" || tag === "TEXTAREA";
      if (inField && e.key !== "Escape") return;

      if (e.key === "Escape") {
        if (document.activeElement === searchRef.current) {
          setQuery("");
          searchRef.current?.blur();
        }
        return;
      }

      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        if (visibleChats.length === 0) return;
        e.preventDefault();
        const idx = visibleChats.findIndex((c) => c.guid === selectedChatGUID);
        const next =
          e.key === "ArrowDown"
            ? Math.min(visibleChats.length - 1, idx + 1)
            : Math.max(0, idx - 1);
        selectChat(visibleChats[next < 0 ? 0 : next].guid);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visibleChats, selectedChatGUID, selectChat]);

  return (
    <div className={cn("app-sidebar flex flex-col h-full", superlightMode ? "bg-background" : "border-r bg-background/95 backdrop-blur-xl")}>
      {/* Header */}
      <div
        data-tauri-drag-region
        className={cn(
          "app-sidebar-header flex items-center px-3 py-3 sticky top-0 z-10",
          superlightMode ? "justify-between bg-background" : "justify-between border-b bg-background/80 backdrop-blur-xl",
          sidebarHidden && "md:justify-center md:px-0"
        )}
      >
        <div data-tauri-drag-region className="flex items-center gap-1.5 min-w-0">
          <Button
            variant="ghost"
            size="icon"
            className="hidden h-8 w-8 shrink-0 text-muted-foreground md:inline-flex"
            onClick={toggleSidebarHidden}
            aria-label={sidebarHidden ? "Show sidebar" : "Hide sidebar"}
            title={sidebarHidden ? "Show sidebar" : "Hide sidebar"}
          >
            {sidebarHidden ? (
              <PanelLeftOpen className="h-4 w-4" />
            ) : (
              <PanelLeftClose className="h-4 w-4" />
            )}
          </Button>
          {!superlightMode && !sidebarHidden && (
            <>
              <MessageCircle className="h-5 w-5 text-primary" />
              <h1 data-tauri-drag-region className="text-xs font-bold tracking-[0.14em] uppercase text-muted-foreground">Messages</h1>
              <span
                className="relative flex h-2 w-2"
                title={
                  wsConnected
                    ? "Realtime connected"
                    : pollingFallback
                    ? "Polling fallback (HTTPS blocks ws://). Use https:// server URL for realtime."
                    : "Disconnected"
                }
              >
                <span
                  className={cn(
                    "relative inline-flex h-2 w-2 rounded-full",
                    wsConnected
                      ? "bg-green-500"
                      : pollingFallback
                      ? "bg-amber-500"
                      : "bg-muted-foreground/30"
                  )}
                />
              </span>
            </>
          )}
        </div>
        <div className={cn("flex items-center gap-1", superlightMode && "ml-auto", sidebarHidden && "md:hidden")}>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-muted-foreground"
            onClick={loadChats}
            disabled={loadingChats}
            aria-label="Refresh chats"
            title="Refresh chats"
          >
            <RefreshCw className={cn("h-4 w-4", loadingChats && "animate-spin")} />
          </Button>
          <AiSimulatorDialog />
          <ThemeToggle compact={superlightMode} />
          <SettingsDialog compact={superlightMode} />
        </div>
      </div>

      {!sidebarHidden && !networkOnline && (
        <div className="px-3 py-2 text-xs border-b bg-amber-500/10 text-amber-700 dark:text-amber-300">
          You are offline. Trying to reconnect automatically…
        </div>
      )}
      {!sidebarHidden && connectionNotice && (
        <div className="px-3 py-2 text-xs border-b bg-muted/40 text-muted-foreground">
          {connectionNotice}
        </div>
      )}

      {!sidebarHidden && hasAnySource && (
        <div className={cn("px-3 pt-2 pb-2", !superlightMode && "border-b")}>
          <div className="relative">
            {!superlightMode && (
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
            )}
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search"
              className={cn(
                "w-full h-8 text-sm placeholder:text-muted-foreground",
                superlightMode
                  ? "pl-1 pr-1 bg-transparent focus:outline-none"
                  : "pl-8 pr-8 rounded-lg bg-muted/60 border-0 focus:outline-none focus:ring-2 focus:ring-ring"
              )}
            />
            {query && !superlightMode ? (
              <button
                onClick={() => setQuery("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 h-4 w-4 rounded-full bg-muted-foreground/30 hover:bg-muted-foreground/50 flex items-center justify-center"
                aria-label="Clear search"
              >
                <X className="h-2.5 w-2.5 text-background" />
              </button>
            ) : !superlightMode ? (
              <kbd className="absolute right-2 top-1/2 -translate-y-1/2 hidden sm:inline-flex h-5 select-none items-center gap-0.5 rounded border bg-background px-1.5 text-[10px] text-muted-foreground">
                ⌘K
              </kbd>
            ) : null}
            {query && superlightMode ? (
              <button
                onClick={() => setQuery("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 h-4 w-4 flex items-center justify-center text-muted-foreground"
                aria-label="Clear search"
              >
                <X className="h-3 w-3" />
              </button>
            ) : null}
          </div>
        </div>
      )}

      <ScrollArea className="flex-1">
        {!hasAnySource ? (
          !sidebarHidden && (
            <div className="p-6 text-center text-sm text-muted-foreground">
              <p>Configure your server to get started.</p>
              <p className="mt-1">Click the settings icon above.</p>
            </div>
          )
        ) : loadingChats && chats.length === 0 ? (
          !sidebarHidden && <ChatListSkeleton />
        ) : filteredChats.length === 0 ? (
          !sidebarHidden && (
            <div className="p-6 text-center text-sm text-muted-foreground">
              {query ? `No chats match "${query}".` : "No chats found."}
            </div>
          )
        ) : sidebarHidden ? (
          compactChats.map((chat) => (
            <ChatItem
              key={chat.guid}
              chat={chat}
              isSelected={chat.guid === selectedChatGUID}
              onSelect={selectChat}
              compact
            />
          ))
        ) : (
          <>
            {/* Shown with a teaching hint until the first pin exists — the
                hover-only star proved invisible without it. Hidden while a
                search filters starred chats away, and gone for good once
                something is pinned. */}
            {(starredList.length > 0 || (starredChats.length === 0 && !query)) && (
              <div>
                <div
                  className={cn(
                    "sticky top-0 z-[5] flex w-full items-center gap-1.5 px-3 py-1.5",
                    "text-[11px] font-semibold uppercase tracking-wider text-muted-foreground",
                    "bg-background/95 backdrop-blur-sm"
                  )}
                >
                  <Star className="h-3 w-3 shrink-0 fill-current text-amber-500" />
                  <span>Starred</span>
                </div>
                {starredList.length > 0 ? (
                  starredList.map((chat) => (
                    <ChatItem
                      key={`star-${chat.guid}`}
                      chat={chat}
                      isSelected={chat.guid === selectedChatGUID}
                      onSelect={selectChat}
                      starred
                      onToggleStar={toggleStarred}
                    />
                  ))
                ) : (
                  <p className="flex items-center gap-1.5 px-4 pb-2 pt-0.5 text-xs text-muted-foreground">
                    Hover a chat and click its
                    <Star className="inline h-3 w-3 shrink-0" />
                    to pin it here.
                  </p>
                )}
              </div>
            )}
            {!grouped
              ? filteredChats.map((chat) => (
                  <ChatItem
                    key={chat.guid}
                    chat={chat}
                    isSelected={chat.guid === selectedChatGUID}
                    onSelect={selectChat}
                    starred={starredChats.includes(chat.guid)}
                    onToggleStar={toggleStarred}
                  />
                ))
              : groups.map((group) => {
                  const collapsed = collapsedAccounts.includes(group.ref.key);
                  return (
                    <div key={group.ref.key}>
                      <button
                        onClick={() => toggleAccountCollapsed(group.ref.key)}
                        aria-expanded={!collapsed}
                        className={cn(
                          "sticky top-0 z-[5] flex w-full items-center gap-1.5 px-3 py-1.5",
                          "text-[11px] font-semibold uppercase tracking-wider text-muted-foreground",
                          "bg-background/95 backdrop-blur-sm hover:text-foreground"
                        )}
                      >
                        <ChevronRight
                          className={cn(
                            "h-3 w-3 shrink-0 transition-transform",
                            !collapsed && "rotate-90"
                          )}
                        />
                        <span className="truncate">{group.label}</span>
                        {/* Two fixed-width right-aligned columns, so the pills
                            and counts line up across rows instead of drifting
                            with each pill's width. */}
                        <span className="ml-auto flex items-center gap-1.5 font-normal tabular-nums">
                          <span className="min-w-8 text-right">
                            {group.unread > 0 && (
                              <span className="inline-block rounded-full bg-red-500 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-white">
                                {group.unread > 999 ? "999+" : group.unread}
                              </span>
                            )}
                          </span>
                          <span className="w-8 text-right text-muted-foreground/60">
                            {group.chats.length}
                          </span>
                        </span>
                      </button>
                      {!collapsed &&
                        group.chats.map((chat) => (
                          <ChatItem
                            key={chat.guid}
                            chat={chat}
                            isSelected={chat.guid === selectedChatGUID}
                            onSelect={selectChat}
                            starred={starredChats.includes(chat.guid)}
                            onToggleStar={toggleStarred}
                          />
                        ))}
                    </div>
                  );
                })}
          </>
        )}
      </ScrollArea>
    </div>
  );
}
