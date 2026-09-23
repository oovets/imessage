import { memo, useEffect, useState, type DragEvent, type MouseEvent } from "react";
import { Star } from "lucide-react";

import { cn } from "@/lib/utils";
import { useTelegramAvatar } from "@/telegram/useTelegramAvatar";
import { useContactAvatar } from "@/lib/contactAvatars";
import { isSource } from "@/lib/source";
import { CHAT_DRAG_MIME, sourceTag } from "@/lib/triage";
import { stripSlackMarks } from "@/slack/mrkdwn";
import {
  decodeEscapedUnicode,
  getChatDisplayName,
  getChatInitials,
  formatMessageTime,
  type Chat,
} from "@/types";
import { useAppStore } from "@/store/useAppStore";

export type ChatItemVariant = "card" | "starred" | "row" | "compact";

export interface ChatSelectOptions {
  /** ⌥-click / ⌥↵: open beside the active pane instead of in it. */
  newPane?: boolean;
}

interface ChatItemProps {
  chat: Chat;
  /** card = "Waiting on you" queue, starred / row = list rows, compact = rail tile. */
  variant?: ChatItemVariant;
  /** Shown in the active pane. */
  isSelected: boolean;
  /** Keyboard cursor (↑/↓) is on this item. */
  isCursor?: boolean;
  onSelect: (guid: string, opts?: ChatSelectOptions) => void;
  /** Queue cards: "E done" — mark read and drop into Recent. */
  onDone?: (guid: string) => void;
  /** Card is animating out after "done". */
  leaving?: boolean;
  /** ⌘N of the pane showing this chat, if any. */
  paneKey?: number;
  /** That pane is the active one (chip is inverted). */
  paneKeyActive?: boolean;
  starred?: boolean;
  onToggleStar?: (guid: string) => void;
  /** @deprecated use variant="compact" */
  compact?: boolean;
}

/** 24×24 rounded-square initials tile; a photo fills it when avatars are on. */
function Tile({ chat, name }: { chat: Chat; name: string }) {
  const showAvatars = useAppStore((s) => s.showAvatars);
  const superlightMode = useAppStore((s) => s.superlightMode);
  const tgAvatarUrl = useTelegramAvatar(chat.guid);
  const contactAvatarUrl = useContactAvatar(chat);
  // Slack DMs carry a ready public URL on the chat itself — no hook needed.
  const avatarUrl = showAvatars
    ? (chat.avatarUrl ?? tgAvatarUrl ?? contactAvatarUrl)
    : null;
  return (
    <span className="relative flex h-6 w-6 shrink-0 select-none items-center justify-center overflow-hidden rounded-md bg-muted text-cc-chip font-semibold">
      {avatarUrl && !superlightMode ? (
        <img src={avatarUrl} alt={name} className="h-full w-full object-cover" draggable={false} />
      ) : (
        getChatInitials(chat)
      )}
    </span>
  );
}

function KeyChip({ n, active }: { n: number; active: boolean }) {
  return (
    <span
      className={cn(
        "shrink-0 whitespace-nowrap rounded px-[5px] font-mono text-cc-chip",
        active ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
      )}
    >
      ⌘{n}
    </span>
  );
}

function HintChip({ children, onClick, label }: { children: string; onClick?: () => void; label: string }) {
  return (
    <span
      role="button"
      tabIndex={-1}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        onClick?.();
      }}
      className="whitespace-nowrap rounded bg-muted px-1.5 py-px transition-[background-color] duration-120 hover:bg-border hover:text-foreground"
    >
      {children}
    </span>
  );
}

function ChatItemComponent({
  chat,
  variant: variantProp,
  isSelected,
  isCursor = false,
  onSelect,
  onDone,
  leaving = false,
  paneKey,
  paneKeyActive = false,
  starred = false,
  onToggleStar,
  compact = false,
}: ChatItemProps) {
  const variant: ChatItemVariant = variantProp ?? (compact ? "compact" : "row");
  // Own expiry timer: nothing clears typing for a chat that isn't open, and
  // the store no longer re-notifies on no-op writes that used to re-check it.
  const typingUntil = useAppStore((s) => s.typingChats[chat.guid]);
  const [, bumpTyping] = useState(0);
  useEffect(() => {
    if (typingUntil === undefined) return;
    const ms = typingUntil - Date.now();
    if (ms <= 0) return;
    const t = window.setTimeout(() => bumpTyping((n) => n + 1), ms + 1);
    return () => window.clearTimeout(t);
  }, [typingUntil]);
  const isTyping = typingUntil !== undefined && typingUntil > Date.now();
  const name = getChatDisplayName(chat);
  const unread = (chat.unreadCount ?? 0) > 0;

  function onClick(e: MouseEvent) {
    onSelect(chat.guid, { newPane: e.altKey });
  }
  function onDragStart(e: DragEvent) {
    e.dataTransfer.setData(CHAT_DRAG_MIME, chat.guid);
    e.dataTransfer.setData("text/plain", name);
    e.dataTransfer.effectAllowed = "copy";
  }

  if (variant === "compact") {
    return (
      <div
        role="button"
        tabIndex={-1}
        draggable
        onDragStart={onDragStart}
        onClick={onClick}
        aria-pressed={isSelected}
        title={name}
        className={cn(
          "relative mx-auto flex h-9 w-9 items-center justify-center rounded-md transition-[background-color] duration-120 hover:bg-panel",
          (isSelected || isCursor) && "bg-panel",
          isCursor && "shadow-[0_0_0_1.5px_hsl(var(--primary))]"
        )}
      >
        <Tile chat={chat} name={name} />
        {unread && (
          <span
            className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-signal"
            aria-label={`${chat.unreadCount} unread`}
          />
        )}
      </div>
    );
  }

  if (variant === "card") {
    const lastTime = chat.lastMessage?.dateCreated ? formatMessageTime(chat.lastMessage.dateCreated) : "";
    const rawPreview = decodeEscapedUnicode(chat.lastMessageText ?? chat.lastMessage?.text ?? "");
    // Slack previews would otherwise show literal *bold* and `code` markers.
    const preview = isSource(chat.guid, "slack") ? stripSlackMarks(rawPreview) : rawPreview;
    return (
      // Collapse wrapper: "E done" fades the card out and folds its height
      // (160ms ease-out) before the chat drops into Recent.
      <div
        className={cn(
          "grid transition-[grid-template-rows,opacity] duration-160 ease-out",
          leaving ? "grid-rows-[0fr] opacity-0" : "grid-rows-[1fr] opacity-100"
        )}
      >
        <div className="-m-[1.5px] min-h-0 overflow-hidden p-[1.5px]">
          <div
            role="button"
            tabIndex={-1}
            draggable
            onDragStart={onDragStart}
            onClick={onClick}
            aria-pressed={isSelected}
            className={cn(
              "cursor-default rounded-lg bg-panel px-3 py-2.5 text-left",
              isCursor || isSelected
                ? "shadow-[0_0_0_1.5px_hsl(var(--primary))]"
                : "shadow-[inset_0_0_0_1px_hsl(var(--border))]"
            )}
          >
            <div className="flex items-center gap-2">
              <span
                className="h-1.5 w-1.5 shrink-0 rounded-full bg-signal"
                aria-label={`${chat.unreadCount} unread`}
              />
              <span className="min-w-0 flex-1 truncate text-cc-body font-semibold">{name}</span>
              <span className="shrink-0 whitespace-nowrap font-mono text-cc-chip text-muted-foreground">
                {sourceTag(chat.guid)}
                {lastTime && ` · ${lastTime}`}
              </span>
            </div>
            {isTyping ? (
              <p className="ml-3.5 mt-1 text-cc-body text-signal">typing…</p>
            ) : (
              preview && (
                <p className="ml-3.5 mt-1 line-clamp-2 break-words text-cc-body [overflow-wrap:anywhere]">
                  {preview}
                </p>
              )
            )}
            <div className="ml-3.5 mt-2 flex gap-1.5 font-mono text-cc-chip text-muted-foreground">
              <HintChip label="Open" onClick={() => onSelect(chat.guid)}>↵ open</HintChip>
              <HintChip label="Open in new pane" onClick={() => onSelect(chat.guid, { newPane: true })}>
                ⌥↵ new pane
              </HintChip>
              {onDone && (
                <HintChip label="Mark done" onClick={() => onDone(chat.guid)}>E done</HintChip>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // starred / row
  return (
    <div
      role="button"
      tabIndex={-1}
      draggable
      onDragStart={onDragStart}
      onClick={onClick}
      aria-pressed={isSelected}
      className={cn(
        "group mx-2.5 flex cursor-default items-center gap-2.5 rounded-md px-2 text-left transition-[background-color] duration-120 hover:bg-panel",
        variant === "starred" ? "py-[7px]" : "py-1.5",
        (isSelected || isCursor) && "bg-panel",
        isCursor && !isSelected && "shadow-[inset_0_0_0_1px_hsl(var(--border))]"
      )}
    >
      <Tile chat={chat} name={name} />
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-cc-body",
          variant === "starred" && "font-medium"
        )}
      >
        {name}
      </span>
      {/* Star: revealed on row hover (pinned rows show a filled star to
          unpin). A span, not a button — the whole row already is one. */}
      {onToggleStar && (
        <span
          role="button"
          tabIndex={-1}
          aria-label={starred ? "Unstar chat" : "Star chat"}
          title={starred ? "Unstar" : "Star"}
          onClick={(e) => {
            e.stopPropagation();
            onToggleStar(chat.guid);
          }}
          className={cn(
            "hidden h-[19px] w-[19px] shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground group-hover:inline-flex",
            starred && "text-foreground"
          )}
        >
          <Star className={cn("h-3 w-3", starred && "fill-current")} />
        </span>
      )}
      {paneKey != null && <KeyChip n={paneKey} active={paneKeyActive} />}
      {variant === "row" && (
        <span className="shrink-0 whitespace-nowrap font-mono text-cc-chip text-muted-foreground">
          {sourceTag(chat.guid)}
        </span>
      )}
    </div>
  );
}

// Memoized so a whole-list re-render (e.g. the progressive setChats bursts from
// enrichChatActivity) only re-renders items whose props actually changed.
export const ChatItem = memo(ChatItemComponent);
