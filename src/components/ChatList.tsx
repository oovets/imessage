import { useEffect, useMemo, useRef, useState } from "react";
import { PanelLeftClose, PanelLeftOpen, RefreshCw, MessageCircle, Search, X } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { SettingsDialog } from "@/components/SettingsDialog";
import { ThemeToggle } from "@/components/ThemeToggle";
import { ChatItem } from "@/components/ChatItem";
import { ChatListSkeleton } from "@/components/ChatListSkeleton";
import { useAppStore } from "@/store/useAppStore";
import { getClient } from "@/api/clientFactory";
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
  // The list is shown if either messaging source is available.
  const hasAnySource = isConfigured || telegramAvailable;
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
        if (filteredChats.length === 0) return;
        e.preventDefault();
        const idx = filteredChats.findIndex((c) => c.guid === selectedChatGUID);
        const next =
          e.key === "ArrowDown"
            ? Math.min(filteredChats.length - 1, idx + 1)
            : Math.max(0, idx - 1);
        selectChat(filteredChats[next < 0 ? 0 : next].guid);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [filteredChats, selectedChatGUID, selectChat]);

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
        ) : (
          filteredChats.map((chat) => (
            <ChatItem
              key={chat.guid}
              chat={chat}
              isSelected={chat.guid === selectedChatGUID}
              onSelect={selectChat}
              compact={sidebarHidden}
            />
          ))
        )}
      </ScrollArea>
    </div>
  );
}
