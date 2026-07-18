import { useEffect, useState } from "react";
import { Copy, Reply, Smile, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { type Message, decodeEscapedUnicode, formatMessageTime } from "@/types";
import { useAppStore } from "@/store/useAppStore";
import { isSource, supports } from "@/lib/source";
import { useTelegramSenderAvatar } from "@/telegram/useTelegramAvatar";
import { useSlackSenderAvatar } from "@/slack/useSlackAvatar";
import { parseSlackMarks } from "@/slack/mrkdwn";
import { useContactAvatarForAddress } from "@/lib/contactAvatars";
import { getClient } from "@/api/clientFactory";
import { extractFirstUrl, fetchLinkPreview } from "@/lib/linkPreview";
import { LinkPreviewCard } from "@/components/LinkPreviewCard";
import { OrientedImage } from "@/components/OrientedImage";
import { StreamedVideo } from "@/components/StreamedVideo";
import { TelegramMedia } from "@/telegram/TelegramMedia";
import { SlackMedia } from "@/slack/SlackMedia";
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

/**
 * Slack text carries mrkdwn marks (*bold*, `code`, ```pre```). Render them as
 * real styling; URLs inside styled runs still linkify.
 */
function renderSlackText(text: string, isMe: boolean, superlightMode: boolean) {
  return parseSlackMarks(text).map((span, i) => {
    const inner = renderTextWithLinks(span.text, isMe, superlightMode);
    switch (span.kind) {
      case "bold":
        return <strong key={i} className="font-semibold">{inner}</strong>;
      case "italic":
        return <em key={i}>{inner}</em>;
      case "strike":
        return <s key={i}>{inner}</s>;
      case "code":
        return (
          <code
            key={i}
            className={cn(
              "rounded px-1 py-px font-mono text-[0.85em]",
              isMe && !superlightMode ? "bg-white/20" : "bg-muted-foreground/15"
            )}
          >
            {span.text}
          </code>
        );
      case "pre":
        return (
          <pre
            key={i}
            className={cn(
              "my-1 overflow-x-auto rounded-md px-2 py-1.5 font-mono text-[0.85em] whitespace-pre-wrap",
              isMe && !superlightMode ? "bg-white/15" : "bg-muted-foreground/10"
            )}
          >
            {span.text}
          </pre>
        );
      default:
        return <span key={i}>{inner}</span>;
    }
  });
}

const IMAGE_MIME = /^image\//;
const VIDEO_MIME = /^video\//;

// Inline thumbnail width. Covers retina at the ~320px display cap without
// forcing the WebView to decode a full-resolution photo for every bubble.
const THUMB_WIDTH = 1024;

// Renders an inline image thumbnail, falling back to the full-resolution URL if
// the downscaled request fails (e.g. an older server that rejects the params).
function AttachmentImage({
  thumbSrc,
  fullSrc,
  alt,
  onOpen,
}: {
  thumbSrc: string;
  fullSrc: string;
  alt: string;
  onOpen: (src: string, alt: string) => void;
}) {
  // Render the full image through OrientedImage: it applies EXIF orientation
  // (server thumbnails drop it and render rotated) and keeps only a downscaled
  // bitmap in memory. `thumbSrc` is unused now but kept in the signature.
  void thumbSrc;
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onOpen(fullSrc, alt);
      }}
      onDoubleClick={(event) => event.stopPropagation()}
      className="-mx-1 mb-1 block cursor-zoom-in border-0 bg-transparent p-0"
      aria-label="Open full image"
    >
      <OrientedImage
        src={fullSrc}
        alt={alt}
        className="rounded-lg max-h-80 max-w-full"
      />
    </button>
  );
}

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
  const showAvatars = useAppStore((s) => s.showAvatars);
  const linkPreviewsEnabled = useAppStore((s) => s.linkPreviewsEnabled);
  const linkPreviewCache = useAppStore((s) => s.linkPreviewCache);
  const setLinkPreview = useAppStore((s) => s.setLinkPreview);

  // Mini sender avatar (incoming messages): Telegram sender photo or the
  // iMessage contact photo, falling back to the initials circle below. The
  // hooks gate on the global "show avatars" setting internally.
  const senderAddress = !isMe ? (message.handle?.address ?? null) : null;
  const chatGuid = message.chatGUID ?? "";
  const tgSenderAvatar = useTelegramSenderAvatar(chatGuid, senderAddress);
  const slSenderAvatar = useSlackSenderAvatar(chatGuid, senderAddress);
  const contactSenderAvatar = useContactAvatarForAddress(
    chatGuid && supports(chatGuid, "contactAvatars") ? senderAddress : null
  );
  const senderAvatar = tgSenderAvatar ?? slSenderAvatar ?? contactSenderAvatar;

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
  const senderInitials = (senderName ?? "")
    .trim()
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  const hasContent = !!(decodedText || message.attachments?.length);
  if (!hasContent) return null;

  const cornerClass = isMe
    ? cn(
        "rounded-2xl",
        !isFirstInGroup && "rounded-tr-md",
        isLastInGroup && "rounded-br-[6px]"
      )
    : cn(
        "rounded-2xl",
        !isFirstInGroup && "rounded-tl-md",
        isLastInGroup && "rounded-bl-[6px]"
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

        <div className={cn(superlightMode ? "w-full" : "flex items-end gap-2 w-full", isMe && "justify-end")}>
          {/* Avatars off = text only: neither the circle nor its reserved
              column renders, so bubbles sit flush left. */}
          {!isMe && !superlightMode && showAvatars && (
            isLastInGroup ? (
              senderAvatar ? (
                <img
                  src={senderAvatar}
                  alt=""
                  className="h-7 w-7 shrink-0 rounded-full object-cover select-none"
                  draggable={false}
                />
              ) : (
                <div className="h-7 w-7 shrink-0 rounded-full bg-[#5e84c9] text-white text-[10px] font-semibold flex items-center justify-center select-none">
                  {senderInitials}
                </div>
              )
            ) : (
              <div className="w-7 shrink-0" aria-hidden="true" />
            )
          )}
          <div className={cn("relative group min-w-0", superlightMode ? "max-w-[95%] w-full" : "max-w-[78%]")}>
          <div
            title={new Date(message.dateCreated).toLocaleString()}
            className={cn(
              "px-3.5 py-2 text-sm select-text",
              superlightMode
                ? cn("px-0 py-0 bg-transparent", isMe ? "text-right text-muted-foreground" : "text-foreground")
                : cn(
                    "transition-colors duration-200",
                    cornerClass,
                    isMe ? "bg-[#5e84c9] text-white" : "bg-muted text-foreground",
                    message.pending && "opacity-70",
                    message.failed && "opacity-90 ring-1 ring-destructive/60"
                  )
            )}
            onDoubleClick={() => onReact?.(message, "love")}
          >
            {message.attachments?.map((att) => {
              // Telegram media is fetched lazily via its own component.
              if (att.guid.startsWith("tgmedia:")) {
                return <TelegramMedia key={att.guid} att={att} />;
              }
              // Slack files need the workspace token, so they go through the
              // host rather than being loaded straight from url_private.
              if (att.guid.startsWith("slfile:")) {
                return <SlackMedia key={att.guid} att={att} />;
              }
              const mime = att.mimeType ?? "";
              const client = getClient(serverUrl, password);
              const src = att.url || client.getAttachmentUrl(att.guid);
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
                // Prefer a downscaled thumbnail for the inline bubble; the zoom
                // dialog (onOpen) gets the full-resolution source.
                const thumbSrc = att.url
                  ? att.url
                  : client.getAttachmentUrl(att.guid, { width: THUMB_WIDTH, quality: "good" });
                return (
                  <AttachmentImage
                    key={att.guid}
                    thumbSrc={thumbSrc}
                    fullSrc={src}
                    alt={alt}
                    onOpen={(s, a) => setFullImage({ src: s, alt: a })}
                  />
                );
              }
              if (VIDEO_MIME.test(mime)) {
                return (
                  <StreamedVideo
                    key={att.guid}
                    src={src}
                    mime={mime}
                    className="rounded-lg max-h-80 max-w-full -mx-1 mb-1"
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
              <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
                {isSource(chatGuid, "slack")
                  ? renderSlackText(decodedText, isMe, superlightMode)
                  : renderTextWithLinks(decodedText, isMe, superlightMode)}
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
