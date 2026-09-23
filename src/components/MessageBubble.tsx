import { memo, useEffect, useState } from "react";
import { Copy, Reply, Smile, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { type Message, decodeEscapedUnicode, formatDate } from "@/types";
import { useAppStore } from "@/store/useAppStore";
import { isSource } from "@/lib/source";
import { parseSlackMarks } from "@/slack/mrkdwn";
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
  /** Time shown beside the bubble (the last in a group); omit for none. The
   *  list formats it, so an aged label refreshes whenever the list renders. */
  timeLabel?: string;
  reactions?: string[];
  isFirstInGroup?: boolean;
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
          isMe && !superlightMode
            ? "text-primary-foreground hover:opacity-80"
            : "text-foreground hover:opacity-80"
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
              isMe && !superlightMode ? "bg-primary-foreground/20" : "bg-muted"
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
              isMe && !superlightMode ? "bg-primary-foreground/15" : "bg-muted"
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

/** 28×28 button in the hover action pill. */
const hoverAction =
  "flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-[background-color] duration-120 hover:bg-muted hover:text-foreground";
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
        className="rounded-md max-h-80 max-w-full"
      />
    </button>
  );
}

// Memoized: MessageList passes the store's message objects (whose identity
// survives merges), stable callbacks and content-stable reaction arrays, so a
// list render only re-renders the bubbles whose props actually changed.
export const MessageBubble = memo(function MessageBubble({
  message,
  showSender,
  timeLabel,
  reactions,
  isFirstInGroup = true,
  onReply,
  onReact,
}: MessageBubbleProps) {
  const isMe = message.isFromMe;
  const rawType = message.associatedMessageType as unknown;
  const isReaction = isTapback(rawType);

  const decodedText = decodeEscapedUnicode(message.text);
  const previewUrl = decodedText ? extractFirstUrl(decodedText) : null;

  const serverUrl = useAppStore((s) => s.serverUrl);
  const password = useAppStore((s) => s.password);
  const superlightMode = useAppStore((s) => s.superlightMode);
  const linkPreviewsEnabled = useAppStore((s) => s.linkPreviewsEnabled);
  // Only this bubble's own entry. Selecting the whole cache re-rendered every
  // bubble in every pane each time any preview landed.
  const preview = useAppStore((s) =>
    previewUrl ? s.linkPreviewCache[previewUrl] : undefined
  );
  const setLinkPreview = useAppStore((s) => s.setLinkPreview);

  const chatGuid = message.chatGUID ?? "";

  const [copied, setCopied] = useState(false);
  const [showReactions, setShowReactions] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [fullImage, setFullImage] = useState<{ src: string; alt: string } | null>(null);

  useEffect(() => {
    if (!linkPreviewsEnabled || superlightMode || !previewUrl || preview) return;
    let cancelled = false;
    setPreviewLoading(true);
    fetchLinkPreview(previewUrl)
      .then((result) => {
        if (cancelled) return;
        // Bubbles sharing a URL share one in-flight fetch; the first to
        // resolve stores it, and writing the same entry again changes nothing.
        if (useAppStore.getState().linkPreviewCache[previewUrl] === result) return;
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
          "flex flex-col px-3.5",
          !superlightMode && "animate-in fade-in slide-in-from-bottom-1 duration-200",
          isMe ? "items-end" : "items-start",
          isFirstInGroup ? "mt-2.5" : "mt-[3px]"
        )}
      >
        {showSender && senderName && (
          <span className="mb-[3px] max-w-full truncate text-cc-sender font-semibold text-muted-foreground">
            {senderName}
          </span>
        )}

        {/* Bubble + timestamp. The time sits on the outer side of the last
            bubble in a group, aligned to its bottom. */}
        <div
          className={cn(
            "flex items-end gap-2",
            superlightMode ? "w-full max-w-[95%]" : "max-w-[86%]",
            isMe && "flex-row-reverse"
          )}
        >
          <div className="group relative min-w-0">
          <div
            title={formatDate(message.dateCreated, "full")}
            className={cn(
              "select-text text-cc-body [text-wrap:pretty]",
              superlightMode
                ? cn("bg-transparent p-0", isMe ? "text-right text-muted-foreground" : "text-foreground")
                : cn(
                    // Right padding is 6px wider than the left and the text
                    // pulls back into it, so lines wrap a word early and the
                    // rag stays even — the design's bubble measure.
                    "rounded-md py-2 pl-[11px] pr-[17px]",
                    isMe
                      ? "bg-primary text-primary-foreground"
                      : "bg-panel text-foreground shadow-[inset_0_0_0_1px_hsl(var(--border))]",
                    message.pending && "opacity-70",
                    message.failed && "shadow-[inset_0_0_0_1px_hsl(var(--signal))]"
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
                    className="mb-1 block break-all text-cc-meta underline"
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
                    className="-mx-1 mb-1 max-h-80 max-w-full rounded-md"
                  />
                );
              }
              return (
                <a
                  key={att.guid}
                  href={src}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mb-1 block text-cc-meta underline opacity-80 hover:opacity-100"
                >
                  {att.transferName || "Attachment"}
                </a>
              );
            })}

            {decodedText && (
              <p
                className={cn(
                  "whitespace-pre-wrap break-words [overflow-wrap:anywhere]",
                  !superlightMode && "-mr-1.5"
                )}
              >
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
              "absolute top-1/2 z-20 -translate-y-1/2",
              "opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover:opacity-100",
              isMe ? "right-full mr-2" : "left-full ml-2"
            )}
          >
            <div className="flex items-center gap-0.5 rounded-md bg-panel p-0.5 shadow-[inset_0_0_0_1px_hsl(var(--border))]">
              <button
                type="button"
                onClick={() => setShowReactions((v) => !v)}
                className={hoverAction}
                aria-label="React"
                title="React"
              >
                <Smile className="h-3.5 w-3.5" />
              </button>
              {onReply && (
                <button
                  type="button"
                  onClick={() => onReply(message)}
                  className={hoverAction}
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
                  className={hoverAction}
                  aria-label="Copy"
                  title="Copy text"
                >
                  {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                </button>
              )}
            </div>
            {showReactions && (
              <div
                className={cn(
                  "absolute top-full mt-1 flex items-center gap-0.5 rounded-md bg-panel p-0.5 shadow-[inset_0_0_0_1px_hsl(var(--border))]",
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
                    className="flex h-7 w-7 items-center justify-center rounded text-base transition-[background-color] duration-120 hover:bg-muted"
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
          </div>

          {timeLabel !== undefined && (
            <span
              className={cn(
                "shrink-0 whitespace-nowrap font-mono text-cc-time text-muted-foreground",
                superlightMode ? "pb-0" : "pb-0.5"
              )}
            >
              <time dateTime={new Date(message.dateCreated).toISOString()}>{timeLabel}</time>
            </span>
          )}
        </div>

        {reactions && reactions.length > 0 && (
          <span className="mt-[3px] whitespace-nowrap font-mono text-cc-meta text-muted-foreground">
            {reactions.join("  ")}
          </span>
        )}
        {message.failed && (
          <span
            className="mt-[3px] cursor-help text-cc-meta text-signal"
            title={message.failedReason ?? "Failed to send"}
          >
            Failed to send{message.failedReason ? " · hover for details" : ""}
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
});
