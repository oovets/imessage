import { memo, useEffect, useState, type DragEvent, type KeyboardEvent, type MouseEvent } from "react";
import { Check, Star } from "lucide-react";

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
  nextMessageTimeChange,
  whenDue,
  type Chat,
} from "@/types";
import { useAppStore } from "@/store/useAppStore";
import { altLabel, modLabel } from "@/lib/shortcuts";

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
  /** The list's one Tab stop (roving tabindex); the rest are reached with ↑/↓. */
  tabStop?: boolean;
  onSelect: (guid: string, opts?: ChatSelectOptions) => void;
  /** Queue cards: "E done" — mark read and drop into Recent. */
  onDone?: (guid: string) => void;
  /** Card is animating out after "done". */
  leaving?: boolean;
  /** Compact tiles: in the "Waiting on you" queue, which the signal dot
   *  marks. Defaults to having unread messages; a muted unread chat is not
   *  queued. */
  queued?: boolean;
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
      {modLabel(n)}
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

/** When the chat last saw activity, for its time label. */
function chatTime(chat: Chat): number | undefined {
  return chat.lastMessage?.dateCreated || chat.activityAt || undefined;
}

/** The chat's last message as plain text. */
function chatPreview(chat: Chat): string {
  const raw = decodeEscapedUnicode(chat.lastMessageText ?? chat.lastMessage?.text ?? "");
  // Slack previews would otherwise show literal *bold* and `code` markers.
  return isSource(chat.guid, "slack") ? stripSlackMarks(raw) : raw;
}

/**
 * formatMessageTime(ts), re-rendered when the label is due to change
 * ("14:35" → "Tue" → "Oct 3"). The store keeps an idle chat's object as it
 * is, so nothing else would refresh a row's time.
 */
function useMessageTime(ts: number | undefined): string {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!ts) return;
    return whenDue(nextMessageTimeChange(ts, Date.now()), () => setTick((n) => n + 1));
  }, [ts, tick]);
  return ts ? formatMessageTime(ts) : "";
}

function ChatItemComponent({
  chat,
  variant: variantProp,
  isSelected,
  isCursor = false,
  tabStop = false,
  onSelect,
  onDone,
  leaving = false,
  queued,
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
  const lastTime = useMessageTime(variant === "compact" ? undefined : chatTime(chat));

  function onClick(e: MouseEvent) {
    onSelect(chat.guid, { newPane: e.altKey });
  }
  // Rows are focusable (one Tab stop for the list, ↑/↓ within it):
  // ↵ or Space opens, ⌥↵ in a new pane. The list's own keys skip handled ones.
  function onKeyDown(e: KeyboardEvent) {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSelect(chat.guid, { newPane: e.altKey });
    }
  }
  function onDragStart(e: DragEvent) {
    e.dataTransfer.setData(CHAT_DRAG_MIME, chat.guid);
    e.dataTransfer.setData("text/plain", name);
    e.dataTransfer.effectAllowed = "copy";
  }
  const itemProps = {
    role: "button",
    tabIndex: tabStop ? 0 : -1,
    "data-chat-guid": chat.guid,
    draggable: true,
    onDragStart,
    onClick,
    onKeyDown,
    "aria-pressed": isSelected,
  } as const;

  if (variant === "compact") {
    return (
      <div
        {...itemProps}
        title={name}
        className={cn(
          "relative mx-auto flex h-9 w-9 items-center justify-center rounded-md outline-none transition-[background-color] duration-120 hover:bg-panel",
          (isSelected || isCursor) && "bg-panel",
          isCursor && "shadow-[0_0_0_1.5px_hsl(var(--primary))]",
          "focus-visible:shadow-[0_0_0_1.5px_hsl(var(--primary))]"
        )}
      >
        <Tile chat={chat} name={name} />
        {(queued ?? unread) && (
          <span
            className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-signal"
            aria-label={`${chat.unreadCount} unread`}
          />
        )}
      </div>
    );
  }

  const preview = chatPreview(chat);

  if (variant === "card") {
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
            {...itemProps}
            className={cn(
              "group relative cursor-default rounded-lg bg-panel px-3 py-2.5 text-left outline-none",
              isCursor || isSelected
                ? "shadow-[0_0_0_1.5px_hsl(var(--primary))]"
                : "shadow-[inset_0_0_0_1px_hsl(var(--border))]",
              "focus-visible:shadow-[0_0_0_1.5px_hsl(var(--primary))]"
            )}
          >
            <div className="flex items-center gap-2">
              <span
                className="h-1.5 w-1.5 shrink-0 rounded-full bg-signal"
                aria-label={`${chat.unreadCount} unread`}
              />
              <span className="min-w-0 flex-1 truncate text-cc-body font-semibold">{name}</span>
              <span
                className={cn(
                  "shrink-0 whitespace-nowrap font-mono text-cc-chip text-muted-foreground",
                  onDone && !isCursor && "group-hover:invisible"
                )}
              >
                {sourceTag(chat.guid)}
                {lastTime && ` · ${lastTime}`}
              </span>
              {/* The mouse's "done", in place of the meta on hover; the
                  keyboard cursor's card spells its keys out below instead. */}
              {onDone && !isCursor && (
                <span
                  role="button"
                  tabIndex={-1}
                  aria-label="Mark done"
                  title="Mark done (E)"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDone(chat.guid);
                  }}
                  className="absolute right-2 top-2 hidden h-[19px] items-center gap-1 rounded bg-muted px-1.5 font-mono text-cc-chip text-muted-foreground hover:bg-border hover:text-foreground group-hover:inline-flex"
                >
                  <Check className="h-3 w-3" />
                  done
                </span>
              )}
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
            {/* Key hints only on the card the keyboard cursor is on, so the
                queue reads as messages rather than as rows of buttons. */}
            {isCursor && (
              <div className="ml-3.5 mt-2 flex gap-1.5 font-mono text-cc-chip text-muted-foreground">
                <HintChip label="Open" onClick={() => onSelect(chat.guid)}>↵ open</HintChip>
                <HintChip label="Open in new pane" onClick={() => onSelect(chat.guid, { newPane: true })}>
                  {`${altLabel("↵")} new pane`}
                </HintChip>
                {onDone && (
                  <HintChip label="Mark done" onClick={() => onDone(chat.guid)}>E done</HintChip>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // starred / row: name and meta, then the last message on a second line.
  return (
    <div
      {...itemProps}
      className={cn(
        "group mx-2.5 flex cursor-default items-center gap-2.5 rounded-md px-2 py-1.5 text-left outline-none transition-[background-color] duration-120 hover:bg-panel",
        (isSelected || isCursor) && "bg-panel",
        isCursor && !isSelected && "shadow-[inset_0_0_0_1px_hsl(var(--border))]",
        "focus-visible:shadow-[inset_0_0_0_1.5px_hsl(var(--primary))]"
      )}
    >
      <Tile chat={chat} name={name} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-cc-body",
              variant === "starred" && "font-medium"
            )}
          >
            {name}
          </span>
          {/* Star: shown on hover, on the keyboard cursor's row (S toggles
              it) and always where there is no hover. A span, not a button —
              the whole row already is one. */}
          {onToggleStar && (
            <span
              role="button"
              tabIndex={-1}
              aria-label={starred ? "Unstar chat" : "Star chat"}
              title={starred ? "Unstar (S)" : "Star (S)"}
              onClick={(e) => {
                e.stopPropagation();
                onToggleStar(chat.guid);
              }}
              className={cn(
                "hidden h-[19px] w-[19px] shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground group-hover:inline-flex group-focus-visible:inline-flex [@media(hover:none)]:inline-flex",
                isCursor && "inline-flex",
                starred && "text-foreground"
              )}
            >
              <Star className={cn("h-3 w-3", starred && "fill-current")} />
            </span>
          )}
          {paneKey != null && <KeyChip n={paneKey} active={paneKeyActive} />}
          {(variant === "row" || lastTime) && (
            <span className="shrink-0 whitespace-nowrap font-mono text-cc-chip text-muted-foreground">
              {variant === "row" && sourceTag(chat.guid)}
              {variant === "row" && lastTime && " · "}
              {lastTime}
            </span>
          )}
        </div>
        {isTyping ? (
          <p className="truncate text-cc-meta text-signal">typing…</p>
        ) : (
          preview && <p className="truncate text-cc-meta text-muted-foreground">{preview}</p>
        )}
      </div>
    </div>
  );
}

// Memoized so a whole-list re-render (e.g. the progressive setChats bursts from
// enrichChatActivity) only re-renders items whose props actually changed.
export const ChatItem = memo(ChatItemComponent);
