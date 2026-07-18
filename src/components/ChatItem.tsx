import { memo } from "react";
import { Star } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";

import { cn } from "@/lib/utils";
import { useTelegramAvatar } from "@/telegram/useTelegramAvatar";
import { useContactAvatar } from "@/lib/contactAvatars";
import { isSource } from "@/lib/source";
import { stripSlackMarks } from "@/slack/mrkdwn";
import {
  decodeEscapedUnicode,
  getChatDisplayName,
  getChatInitials,
  formatMessageTime,
  type Chat,
} from "@/types";
import { useAppStore } from "@/store/useAppStore";

interface ChatItemProps {
  chat: Chat;
  isSelected: boolean;
  onSelect: (guid: string) => void;
  compact?: boolean;
  starred?: boolean;
  onToggleStar?: (guid: string) => void;
}

function ChatItemComponent({
  chat,
  isSelected,
  onSelect,
  compact = false,
  starred = false,
  onToggleStar,
}: ChatItemProps) {
  const onClick = () => onSelect(chat.guid);
  const superlightMode = useAppStore((s) => s.superlightMode);
  const showAvatars = useAppStore((s) => s.showAvatars);
  const isTyping = useAppStore(
    (s) => (s.typingChats[chat.guid] ?? 0) > Date.now()
  );
  const name = getChatDisplayName(chat);
  const initials = getChatInitials(chat);
  const tgAvatarUrl = useTelegramAvatar(chat.guid);
  const contactAvatarUrl = useContactAvatar(chat);
  // Slack DMs carry a ready public URL on the chat itself — no hook needed.
  const avatarUrl =
    (showAvatars ? chat.avatarUrl : null) ?? tgAvatarUrl ?? contactAvatarUrl;
  const lastTime = chat.lastMessage?.dateCreated
    ? formatMessageTime(chat.lastMessage.dateCreated)
    : "";
  const rawPreview = decodeEscapedUnicode(chat.lastMessageText ?? chat.lastMessage?.text ?? "");
  // Slack previews would otherwise show literal *bold* and `code` markers.
  const preview = isSource(chat.guid, "slack") ? stripSlackMarks(rawPreview) : rawPreview;

  if (compact) {
    return (
      <button
        onClick={onClick}
        aria-pressed={isSelected}
        title={name}
        className={cn(
          "w-full flex items-center justify-center px-2 py-2 relative active:bg-accent/80",
          superlightMode ? "hover:bg-muted/30" : "transition-[background-color,transform] duration-150 ease-out hover:bg-accent/60 active:scale-[0.99]",
          isSelected && (superlightMode ? "bg-muted/40" : "bg-accent")
        )}
      >
        {isSelected && (
          <span className="absolute left-0 top-2 bottom-2 w-0.5 rounded-r-full bg-primary" />
        )}
        <Avatar className="h-10 w-10 shrink-0">
          {avatarUrl && <AvatarImage src={avatarUrl} alt={name} />}
          <AvatarFallback className="bg-primary/10 text-primary text-xs font-semibold">
            {initials}
          </AvatarFallback>
        </Avatar>
        {chat.unreadCount > 0 && (
          <span className="absolute top-1 right-1 h-4 min-w-4 px-1 text-[10px] rounded-full bg-red-500 text-white font-semibold flex items-center justify-center">
            {chat.unreadCount > 99 ? "99+" : chat.unreadCount}
          </span>
        )}
      </button>
    );
  }

  return (
    <button
      onClick={onClick}
      aria-pressed={isSelected}
      className={cn(
        "group w-full flex items-center gap-3 pl-5 pr-4 py-2.5 text-left relative active:bg-accent/80",
        superlightMode
          ? "hover:bg-muted/30"
          : cn(
              "transition-[background-color,transform] duration-150 ease-out hover:bg-accent/60 active:scale-[0.99] after:absolute after:right-4 after:bottom-0 after:h-px after:bg-border/70",
              showAvatars ? "after:left-[4.5rem]" : "after:left-5"
            ),
        isSelected && (superlightMode ? "bg-muted/40" : "bg-accent")
      )}
    >
      {isSelected && (
        <span className="absolute left-0 top-2 bottom-2 w-0.5 rounded-r-full bg-primary" />
      )}
      {chat.unreadCount > 0 && (
        <span
          className="absolute left-1.5 top-1/2 -translate-y-1/2 h-2 w-2 rounded-full bg-[#5e84c9]"
          aria-label={`${chat.unreadCount} unread`}
        />
      )}
      {/* Avatars off = text only: no circle, no reserved space. (The compact
          icon-only sidebar keeps its circle — it's the whole row there.) */}
      {!superlightMode && showAvatars && (
        <Avatar className="h-10 w-10 shrink-0">
          {avatarUrl && <AvatarImage src={avatarUrl} alt={name} />}
          <AvatarFallback className="bg-primary/10 text-primary text-xs font-semibold">
            {initials}
          </AvatarFallback>
        </Avatar>
      )}

      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <span
            className={cn(
              "text-sm truncate",
              superlightMode || chat.unreadCount > 0 ? "font-semibold" : "font-medium"
            )}
          >
            {name}
          </span>
          <span className="flex items-center gap-1 shrink-0">
            {/* Star: pinned shows always; otherwise it fades in on hover. A
                span, not a button — the whole row already is one. */}
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
                  // Always visible: the hover-reveal version proved invisible
                  // in practice. Unpinned is a faint outline that sharpens
                  // under the pointer; pinned is filled amber.
                  "rounded p-0.5 hover:bg-muted hover:text-foreground",
                  starred ? "text-amber-500" : "text-muted-foreground/40"
                )}
              >
                <Star className={cn("h-3.5 w-3.5", starred && "fill-current")} />
              </span>
            )}
            {lastTime && (
              <span className="text-xs text-muted-foreground">{lastTime}</span>
            )}
          </span>
        </div>
        <div className="flex items-center justify-between gap-2">
          {isTyping ? (
            <p className="text-xs truncate text-primary italic">typing…</p>
          ) : (
            <p className={cn("text-xs min-w-0 line-clamp-2 text-muted-foreground", chat.unreadCount > 0 && "text-foreground")}>
              {preview || " "}
            </p>
          )}
          {chat.unreadCount > 0 && (
            <span className="h-5 min-w-5 px-1.5 text-[10px] shrink-0 rounded-full bg-red-500 text-white font-semibold flex items-center justify-center">
              {chat.unreadCount > 99 ? "99+" : chat.unreadCount}
            </span>
          )}
        </div>
      </div>
    </button>
  );
}

// Memoized so a whole-list re-render (e.g. the progressive setChats bursts from
// enrichChatActivity) only re-renders items whose props actually changed.
export const ChatItem = memo(ChatItemComponent);
