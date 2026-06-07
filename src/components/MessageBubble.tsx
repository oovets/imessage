import { useEffect, useState } from "react";
import { Copy, Reply, Smile, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { type Message, decodeEscapedUnicode, formatMessageTime } from "@/types";
import { useAppStore } from "@/store/useAppStore";
import { getClient } from "@/api/clientFactory";
import { extractFirstUrl, fetchLinkPreview } from "@/lib/linkPreview";
import { LinkPreviewCard } from "@/components/LinkPreviewCard";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";

interface MessageBubbleProps {
  message: Message;
  showSender: boolean;
  showTime: boolean;
  reactions?: string[];
  isFirstInGroup?: boolean;
  isLastInGroup?: boolean;
  onReply?: (message: Message) => void;
  onReact?: (message: Message, reactionKey: string) => void;
}

const REACTION_EMOJI: Record<string | number, string> = {
  2000: "❤️", 2001: "👍", 2002: "👎", 2003: "😂", 2004: "‼️", 2005: "❓",
  3000: "❤️", 3001: "👍", 3002: "👎", 3003: "😂", 3004: "‼️", 3005: "❓",
  love: "❤️", like: "👍", dislike: "👎", laugh: "😂", emphasize: "‼️", question: "❓",
};

const QUICK_REACTIONS: Array<{ key: string; emoji: string; label: string }> = [
  { key: "love", emoji: "❤️", label: "Love" },
  { key: "like", emoji: "👍", label: "Like" },
  { key: "dislike", emoji: "👎", label: "Dislike" },
  { key: "laugh", emoji: "😂", label: "Laugh" },
  { key: "emphasize", emoji: "‼️", label: "Emphasize" },
  { key: "question", emoji: "❓", label: "Question" },
];

function isTapback(raw: unknown): boolean {
  if (raw === null || raw === undefined || raw === "" || raw === 0 || raw === "0") return false;
  if (typeof raw === "number") return raw !== 0;
  if (typeof raw === "string") return raw !== "" && raw !== "0";
  return false;
}

const URL_REGEX = /(\bhttps?:\/\/[^\s<>]+[^\s<>.,;:!?)\]'"])/gi;

function renderTextWithLinks(text: string, isMe: boolean, superlightMode: boolean) {
  const parts: Array<string | { url: string; key: number }> = [];
  let lastIndex = 0;
  let key = 0;
  let match: RegExpExecArray | null;
  URL_REGEX.lastIndex = 0;
  while ((match = URL_REGEX.exec(text)) !== null) {
    if (match.index > lastIndex) parts.push(text.slice(lastIndex, match.index));
    parts.push({ url: match[0], key: key++ });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));

  return parts.map((p, i) =>
    typeof p === "string" ? (
      <span key={i}>{p}</span>
    ) : (
      <a
        key={`l-${p.key}`}
        href={p.url}
        target="_blank"
        rel="noopener noreferrer"
        className={cn(
          "underline underline-offset-2 break-all",
          superlightMode
            ? "text-primary hover:text-primary/80"
            : isMe
            ? "text-white/90 hover:text-white"
            : "text-primary hover:text-primary/80"
        )}
        onClick={(e) => e.stopPropagation()}
      >
        {p.url}
      </a>
    )
  );
}

const IMAGE_MIME = /^image\//;
const VIDEO_MIME = /^video\//;

// Stable per-sender colour for names in group chats (derived from the address
// so the same person is always the same hue). Tuned to stay legible on both
// the light and dark muted backgrounds.
function senderNameColor(address: string): string {
  let hash = 0;
  for (let i = 0; i < address.length; i++) {
    hash = (hash * 31 + address.charCodeAt(i)) | 0;
  }
  return `hsl(${Math.abs(hash) % 360} 70% 60%)`;
}

export function MessageBubble({
  message,
  showSender,
  showTime,
  reactions,
  isFirstInGroup = true,
  isLastInGroup = true,
  onReply,
  onReact,
}: MessageBubbleProps) {
  const isMe = message.isFromMe;
  const rawType = message.associatedMessageType as unknown;
  const isReaction = isTapback(rawType);

  const serverUrl = useAppStore((s) => s.serverUrl);
  const password = useAppStore((s) => s.password);
  const superlightMode = useAppStore((s) => s.superlightMode);
  const linkPreviewsEnabled = useAppStore((s) => s.linkPreviewsEnabled);
  const linkPreviewCache = useAppStore((s) => s.linkPreviewCache);
  const setLinkPreview = useAppStore((s) => s.setLinkPreview);

  const [copied, setCopied] = useState(false);
  const [showReactions, setShowReactions] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [fullImage, setFullImage] = useState<{ src: string; alt: string } | null>(null);
  const decodedText = decodeEscapedUnicode(message.text);
  const previewUrl = decodedText ? extractFirstUrl(decodedText) : null;
  const preview = previewUrl ? linkPreviewCache[previewUrl] : undefined;

  useEffect(() => {
    if (!linkPreviewsEnabled || superlightMode || !previewUrl || preview) return;
    let cancelled = false;
    setPreviewLoading(true);
    fetchLinkPreview(previewUrl)
      .then((result) => {
        if (cancelled) return;
        setLinkPreview(previewUrl, result);
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [linkPreviewsEnabled, preview, previewUrl, setLinkPreview, superlightMode]);

  if (isReaction) {
    const emoji = REACTION_EMOJI[rawType as string | number] ?? "";
    if (!emoji) return null;
    return null;
  }

  const senderName =
    !isMe && message.handle ? message.handle.firstName || message.handle.address : null;

  const hasContent = !!(decodedText || message.attachments?.length);
  if (!hasContent) return null;

  const cornerClass = isMe
    ? cn(
        "rounded-2xl",
        !isLastInGroup && "rounded-br-md",
        !isFirstInGroup && "rounded-tr-md"
      )
    : cn(
        "rounded-2xl",
        !isLastInGroup && "rounded-bl-md",
        !isFirstInGroup && "rounded-tl-md"
      );

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(decodedText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {}
  }

  return (
    <>
      <div
        className={cn(
          "flex flex-col px-3 md:px-4",
          !superlightMode && "animate-in fade-in slide-in-from-bottom-1 duration-200",
          isMe ? "items-end" : "items-start",
          isFirstInGroup ? "mt-1.5" : "mt-0.5",
          isLastInGroup && "mb-0.5"
        )}
      >
        {showSender && senderName && (
          <span
            className={cn(
              "mb-1 px-3",
              superlightMode
                ? "text-xs font-semibold text-foreground"
                : "text-[11px] font-medium"
            )}
            style={
              superlightMode || !message.handle?.address
                ? undefined
                : { color: senderNameColor(message.handle.address) }
            }
          >
            {senderName}
          </span>
        )}

        <div className={cn("relative group", superlightMode ? "max-w-[95%] w-full" : "max-w-[78%]")}>
          <div
            title={new Date(message.dateCreated).toLocaleString()}
            className={cn(
              "px-3.5 py-2 text-sm select-text",
              superlightMode
                ? cn("px-0 py-0 bg-transparent", isMe ? "text-right text-muted-foreground" : "text-foreground")
                : cn(
                    "shadow-sm transition-all duration-200",
                    cornerClass,
                    isMe ? "bg-[#0b93f6] text-white" : "bg-muted text-foreground",
                    // Tail only on the last bubble of a run (keeps the rounded
                    // bottom corner that the nib attaches to).
                    isLastInGroup && (isMe ? "msg-tail-me" : "msg-tail-them"),
                    message.pending && "opacity-70",
                    message.failed && "opacity-90 ring-1 ring-destructive/60"
                  )
            )}
            onDoubleClick={() => onReact?.(message, "love")}
          >
            {message.attachments?.map((att) => {
              const mime = att.mimeType ?? "";
              const src = att.url || getClient(serverUrl, password).getAttachmentUrl(att.guid);
              if (superlightMode) {
                return (
                  <a
                    key={att.guid}
                    href={src}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs underline mb-1 block break-all"
                  >
                    {att.transferName || "Attachment"}
                  </a>
                );
              }
              if (IMAGE_MIME.test(mime)) {
                const alt = att.transferName || "Image attachment";
                return (
                  <button
                    key={att.guid}
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      setFullImage({ src, alt });
                    }}
                    onDoubleClick={(event) => event.stopPropagation()}
                    className="-mx-1 mb-1 block cursor-zoom-in border-0 bg-transparent p-0"
                    aria-label="Open full image"
                  >
                    <img
                      src={src}
                      alt={alt}
                      loading="lazy"
                      className="rounded-lg max-h-80 object-cover"
                    />
                  </button>
                );
              }
              if (VIDEO_MIME.test(mime)) {
                return (
                  <video
                    key={att.guid}
                    src={src}
                    controls
                    className="rounded-lg max-h-80 -mx-1 mb-1"
                  />
                );
              }
              return (
                <a
                  key={att.guid}
                  href={src}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs opacity-80 hover:opacity-100 underline mb-1 block"
                >
                  {att.transferName || "Attachment"}
                </a>
              );
            })}

            {decodedText && (
              <p className="whitespace-pre-wrap break-words">
                {renderTextWithLinks(decodedText, isMe, superlightMode)}
              </p>
            )}
            {!superlightMode && linkPreviewsEnabled && previewUrl && (
              <LinkPreviewCard
                url={previewUrl}
                preview={preview}
                loading={previewLoading && !preview}
                isOwnMessage={isMe}
              />
            )}
          </div>
        {!superlightMode && (
          <div
            className={cn(
              "absolute top-1/2 -translate-y-1/2 z-20",
              "opacity-0 group-hover:opacity-100 focus-within:opacity-100",
              "transition-opacity duration-150",
              isMe ? "right-full mr-2" : "left-full ml-2"
            )}
          >
            <div className="flex items-center gap-0.5 rounded-full border bg-popover/95 backdrop-blur-md shadow-md px-1 py-1">
              <button
                type="button"
                onClick={() => setShowReactions((v) => !v)}
                className="h-7 w-7 rounded-full hover:bg-accent flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
                aria-label="React"
                title="React"
              >
                <Smile className="h-3.5 w-3.5" />
              </button>
              {onReply && (
                <button
                  type="button"
                  onClick={() => onReply(message)}
                  className="h-7 w-7 rounded-full hover:bg-accent flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
                  aria-label="Reply"
                  title="Reply"
                >
                  <Reply className="h-3.5 w-3.5" />
                </button>
              )}
              {decodedText && (
                <button
                  type="button"
                  onClick={handleCopy}
                  className="h-7 w-7 rounded-full hover:bg-accent flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
                  aria-label="Copy"
                  title="Copy text"
                >
                  {copied ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
                </button>
              )}
            </div>
            {showReactions && (
              <div
                className={cn(
                  "absolute top-full mt-1 flex items-center gap-0.5 rounded-full border bg-popover/95 backdrop-blur-md shadow-lg px-1.5 py-1",
                  "animate-in fade-in zoom-in-95 duration-150",
                  isMe ? "right-0" : "left-0"
                )}
              >
                {QUICK_REACTIONS.map((r) => (
                  <button
                    key={r.key}
                    type="button"
                    onClick={() => {
                      onReact?.(message, r.key);
                      setShowReactions(false);
                    }}
                    className="h-8 w-8 rounded-full hover:bg-accent flex items-center justify-center text-base hover:scale-125 transition-transform"
                    aria-label={r.label}
                    title={r.label}
                  >
                    {r.emoji}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {!superlightMode && reactions && reactions.length > 0 && (
          <div
            className={cn(
              "absolute -top-3 z-10 flex -space-x-1",
              isMe ? "-left-2" : "-right-2"
            )}
          >
            {reactions.map((emoji, i) => (
              <span
                key={i}
                className="inline-flex items-center justify-center h-6 w-6 rounded-full bg-background border border-border text-xs shadow-sm animate-in zoom-in duration-200"
              >
                {emoji}
              </span>
            ))}
          </div>
        )}
      </div>

        {showTime && (
          <span className={cn("text-[10px] text-muted-foreground mt-1", isMe ? "pr-1" : "pl-1")}>
            <time dateTime={new Date(message.dateCreated).toISOString()}>
              {formatMessageTime(message.dateCreated)}
            </time>
            {message.pending && <span className="ml-1 opacity-70">· Sending…</span>}
            {message.failed && (
              <span
                className="ml-1 text-destructive cursor-help"
                title={message.failedReason ?? "Failed to send"}
              >
                · Failed to send{message.failedReason ? " (hover for details)" : ""}
              </span>
            )}
          </span>
        )}
      </div>

      <Dialog open={!!fullImage} onOpenChange={(open) => !open && setFullImage(null)}>
        <DialogContent className="max-h-[96vh] w-auto max-w-[96vw] border-0 bg-black/95 p-2 shadow-2xl [&>button]:right-3 [&>button]:top-3 [&>button]:text-white [&>button]:opacity-90">
          <DialogTitle className="sr-only">{fullImage?.alt ?? "Image attachment"}</DialogTitle>
          <DialogDescription className="sr-only">Full-size image preview</DialogDescription>
          {fullImage && (
            <img
              src={fullImage.src}
              alt={fullImage.alt}
              className="max-h-[92vh] max-w-[92vw] rounded-md object-contain"
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
