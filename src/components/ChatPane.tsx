import { useEffect, useRef, useState } from "react";
import { ArrowLeft, MessageCircleDashed, SplitSquareHorizontal, SplitSquareVertical, X, MessageSquarePlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MessageList } from "@/components/MessageList";
import { MessageInput } from "@/components/MessageInput";
import { useAppStore, isTelegramChatGuid } from "@/store/useAppStore";
import { getClient } from "@/api/clientFactory";
import { getChatDisplayName, getChatInitials } from "@/types";
import { tg } from "@/telegram/api";
import { parseTgChatGuid, tgMessageToMessage } from "@/telegram/adapters";
import { cn } from "@/lib/utils";

interface ChatPaneProps {
  paneId: string;
  chatGUID: string | null;
  isActive: boolean;
  canClose: boolean;
  showMobileBack?: boolean;
}

export function ChatPane({ paneId, chatGUID, isActive, canClose, showMobileBack }: ChatPaneProps) {
  const selectedChat = useAppStore((s) =>
    chatGUID ? s.chats.find((c) => c.guid === chatGUID) : undefined
  );
  const serverUrl = useAppStore((s) => s.serverUrl);
  const password = useAppStore((s) => s.password);
  const setMessages = useAppStore((s) => s.setMessages);
  const mergeMessages = useAppStore((s) => s.mergeMessages);
  const setLoadingMessages = useAppStore((s) => s.setLoadingMessages);
  const setActivePane = useAppStore((s) => s.setActivePane);
  const splitPane = useAppStore((s) => s.splitPane);
  const closePane = useAppStore((s) => s.closePane);
  const setPaneChat = useAppStore((s) => s.setPaneChat);
  const superlightMode = useAppStore((s) => s.superlightMode);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const paneRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!chatGUID) return;
    let cancelled = false;
    setFetchError(null);

    const snapshot = useAppStore.getState();
    const cached = snapshot.messages[chatGUID] ?? [];
    const hasCached = cached.length > 0;
    const lastFetchedAt = snapshot.messageFetchedAt[chatGUID] ?? 0;

    if (!hasCached) setLoadingMessages(true);

    // Telegram chats load through the tg_* commands, not BlueBubbles.
    if (isTelegramChatGuid(chatGUID)) {
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
        if (hasCached && msgs.length === 0) {
          try {
            msgs = await client.getMessages(chatGUID, 50);
          } catch {}
          if (cancelled) return;
        }
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
  }, [chatGUID, serverUrl, password]);

  const empty = !chatGUID || !selectedChat;

  useEffect(() => {
    if (!isActive || empty) return;
    const id = requestAnimationFrame(() => {
      const t = paneRef.current?.querySelector("textarea");
      t?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(id);
  }, [isActive, empty, chatGUID]);

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
      className={cn(
        "flex flex-col h-full min-h-0 bg-background relative",
        isActive && !superlightMode && "ring-1 ring-inset ring-primary/30"
      )}
    >
      <div data-tauri-drag-region className={cn("flex items-center gap-1 px-2 md:px-3 py-2 shrink-0", superlightMode ? "bg-background" : "border-b bg-background/80 backdrop-blur-xl")}>
        {showMobileBack && (
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 md:hidden text-muted-foreground"
            onClick={() => setPaneChat(paneId, null)}
            aria-label="Back to chats"
          >
            <ArrowLeft className="h-5 w-5" />
          </Button>
        )}

        {empty ? (
          <div data-tauri-drag-region className="flex items-center gap-2 flex-1 min-w-0 text-muted-foreground text-xs px-2">
            <MessageSquarePlus className="h-4 w-4" />
            <span data-tauri-drag-region>Empty pane — pick a chat</span>
          </div>
        ) : (
          <div data-tauri-drag-region className="flex items-center gap-2 flex-1 min-w-0">
            <div className="h-7 w-7 rounded-full bg-primary/10 text-primary flex items-center justify-center text-[10px] font-semibold shrink-0">
              {getChatInitials(selectedChat)}
            </div>
            <span data-tauri-drag-region className="font-semibold text-sm truncate">{getChatDisplayName(selectedChat)}</span>
          </div>
        )}

        <div className="flex items-center gap-0.5 shrink-0">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 hidden md:inline-flex text-muted-foreground"
            onClick={() => splitPane(paneId, "horizontal")}
            aria-label="Split right"
            title="Split right"
          >
            <SplitSquareHorizontal className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 hidden md:inline-flex text-muted-foreground"
            onClick={() => splitPane(paneId, "vertical")}
            aria-label="Split down"
            title="Split down"
          >
            <SplitSquareVertical className="h-3.5 w-3.5" />
          </Button>
          {canClose && (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground hover:text-destructive"
              onClick={() => closePane(paneId)}
              aria-label="Close pane"
              title="Close pane"
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>

      {empty ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-3 text-muted-foreground bg-muted/10">
          <MessageCircleDashed className="h-10 w-10 opacity-30" />
          <p className="text-xs">Select a conversation</p>
        </div>
      ) : fetchError ? (
        <div className="flex-1 flex items-center justify-center p-4 text-sm text-destructive text-center">
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
