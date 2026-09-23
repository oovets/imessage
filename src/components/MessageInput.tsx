import { useState, useRef, type KeyboardEvent } from "react";
import { CornerDownLeft, Paperclip, X, Smile } from "lucide-react";
import { useAppStore } from "@/store/useAppStore";
import { isSource } from "@/lib/source";
import { sl } from "@/slack/api";
import { parseSlChatGuid } from "@/slack/adapters";
import { getClient } from "@/api/clientFactory";
import { tg } from "@/telegram/api";
import { parseTgChatGuid } from "@/telegram/adapters";
import { cn } from "@/lib/utils";
import { autoConvertEmoticons } from "@/lib/emoticons";
import { preferredSendGuid } from "@/lib/chatThreadMerge";
import { log as logAi, wordDiff } from "@/lib/aiTelemetry";
import { endReplyTrace } from "@/lib/aiTracing";
import type { Message } from "@/types";
import { decodeEscapedUnicode } from "@/types";
import { EmojiSuggestions } from "@/components/EmojiSuggestions";
import { EmojiPicker } from "@/components/EmojiPicker";
import {
  useEmojiAutocomplete,
  autoReplaceClosedShortcode,
} from "@/hooks/useEmojiAutocomplete";

interface MessageInputProps {
  chatGUID: string;
}

function makeOptimisticMessage(chatGUID: string, text: string, replyGuid: string): Message {
  const tempGuid = (typeof crypto !== "undefined" && "randomUUID" in crypto)
    ? crypto.randomUUID()
    : `temp-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  return {
    guid: `local-${tempGuid}`,
    tempGuid,
    text,
    isFromMe: true,
    dateCreated: Date.now(),
    handle: null,
    attachments: [],
    associatedMessageGuid: replyGuid,
    associatedMessageType: "",
    chatGUID,
    pending: true,
  };
}

export function MessageInput({ chatGUID }: MessageInputProps) {
  const [text, setText] = useState("");
  // Narrow selectors, never the bare store: a selector-less subscription
  // re-renders this whole component on EVERY store change — each websocket
  // message, typing event and preview write, times one per open pane. That
  // was the "typing feels sluggish": keystrokes queued behind re-renders
  // triggered by unrelated traffic.
  const serverUrl = useAppStore((s) => s.serverUrl);
  const password = useAppStore((s) => s.password);
  const superlightMode = useAppStore((s) => s.superlightMode);
  const replyTarget = useAppStore((s) => s.replyTarget[chatGUID] ?? null);
  const setReplyTarget = useAppStore((s) => s.setReplyTarget);
  const setConnectionNotice = useAppStore((s) => s.setConnectionNotice);
  const upsertMessage = useAppStore((s) => s.upsertMessage);
  const replaceMessage = useAppStore((s) => s.replaceMessage);
  const updateChatPreview = useAppStore((s) => s.updateChatPreview);
  const aiDraft = useAppStore((s) => s.aiDrafts[chatGUID]);
  const clearAiDraft = useAppStore((s) => s.clearAiDraft);
  const markAiDraftUsed = useAppStore((s) => s.markAiDraftUsed);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [attaching, setAttaching] = useState(false);
  const emoji = useEmojiAutocomplete(text, setText, textareaRef);
  const [pickerOpen, setPickerOpen] = useState(false);

  async function sendFile(file: File) {
    setAttaching(true);
    try {
      if (isSource(chatGUID, "telegram")) {
        const { accountId, chatId } = parseTgChatGuid(chatGUID);
        const bytes = new Uint8Array(await file.arrayBuffer());
        // The composer text (if any) rides along as the caption.
        await tg.sendFile(accountId, chatId, file.name || "upload", bytes, text.trim() || undefined);
        setText("");
      } else {
        await getClient(serverUrl, password).sendAttachment(
          preferredSendGuid(chatGUID),
          file,
          file.name || "upload",
        );
      }
    } catch (err) {
      setConnectionNotice(
        `Unable to send attachment: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setAttaching(false);
    }
  }

  const hasText = text.trim().length > 0;
  const replyPreview = decodeEscapedUnicode(replyTarget?.text);

  function handleChange(value: string) {
    // Convert a fully-typed `:shortcode:` straight to its emoji, then convert
    // common ASCII emoticons (":)", "<3", ":D", …) to emoji.
    const replaced = autoReplaceClosedShortcode(value);
    setText(autoConvertEmoticons(replaced ?? value));
  }

  function insertEmoji(char: string) {
    const el = textareaRef.current;
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? text.length;
    const next = text.slice(0, start) + char + text.slice(end);
    setText(next);
    const caret = start + char.length;
    requestAnimationFrame(() => {
      if (el) {
        el.focus();
        el.setSelectionRange(caret, caret);
        el.style.height = "auto";
        el.style.height = Math.min(el.scrollHeight, 140) + "px";
      }
    });
  }

  function send() {
    const trimmed = text.trim();
    if (!trimmed) return;

    // §14: what happened to the suggestion is the training signal.
    if (aiDraft) {
      const suggested = aiDraft.text.trim();
      const common = {
        chatGuid: chatGUID,
        model: aiDraft.model,
        profile: aiDraft.profile,
        draftChars: suggested.length,
        sentChars: trimmed.length,
      };
      if (trimmed === suggested) {
        if (aiDraft.traceKey) endReplyTrace(aiDraft.traceKey, "accepted");
        logAi({ kind: "accepted", ...common });
      } else {
        if (aiDraft.traceKey) {
          endReplyTrace(aiDraft.traceKey, "edited", {
            "ai.word_diff": wordDiff(suggested, trimmed),
          });
        }
        logAi({
          kind: "edited",
          ...common,
          charDiff: Math.abs(trimmed.length - suggested.length),
          wordDiff: wordDiff(suggested, trimmed),
          editSeconds: aiDraft.usedAt
            ? Math.round((Date.now() - aiDraft.usedAt) / 1000)
            : undefined,
        });
      }
    }
    clearAiDraft(chatGUID);

    // Slack echoes our own sends back over the socket as `is_self` messages,
    // so — like Telegram — no frontend optimistic bubble, it would duplicate.
    if (isSource(chatGUID, "slack")) {
      const { workspaceId, channelId } = parseSlChatGuid(chatGUID);
      // Replying inside a Slack thread means posting with the parent's ts.
      const threadTs = replyTarget?.guid.split(":").pop();
      setText("");
      setReplyTarget(chatGUID, null);
      if (textareaRef.current) {
        textareaRef.current.style.height = "auto";
        textareaRef.current.focus();
      }
      void sl
        .send(workspaceId, channelId, trimmed, threadTs)
        .catch((err) =>
          setConnectionNotice(
            `Unable to send message: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      return;
    }

    // Telegram: the core does its own optimistic-pending + reconcile and
    // drives the UI via tg:core-event, so we just fire the send and clear
    // the input (no frontend optimistic message — it would duplicate).
    if (isSource(chatGUID, "telegram")) {
      const { accountId, chatId } = parseTgChatGuid(chatGUID);
      const replyId = replyTarget ? Number(replyTarget.guid.split(":").pop()) : NaN;
      const replyTo = Number.isFinite(replyId) && replyId > 0 ? replyId : undefined;
      setText("");
      setReplyTarget(chatGUID, null);
      if (textareaRef.current) {
        textareaRef.current.style.height = "auto";
        textareaRef.current.focus();
      }
      void tg
        .sendMessage(accountId, chatId, trimmed, replyTo)
        .catch((err) =>
          setConnectionNotice(
            `Unable to send message: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      return;
    }

    const optimistic = makeOptimisticMessage(chatGUID, trimmed, replyTarget?.guid ?? "");
    upsertMessage(optimistic);
    updateChatPreview(chatGUID, trimmed);

    setText("");
    setReplyTarget(chatGUID, null);
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.focus();
    }

    const replyGuid = replyTarget?.guid ?? "";
    void (async () => {
      try {
        const client = getClient(serverUrl, password);
        // Merged iMessage/SMS conversation: send on the thread the contact
        // last used, so the reply goes out over the right service.
        await client.sendMessage(preferredSendGuid(chatGUID), trimmed, replyGuid, optimistic.tempGuid);
        replaceMessage(chatGUID, optimistic.guid, { ...optimistic, pending: false });
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        // Replies/reactions go through the BlueBubbles Private API. If that
        // isn't set up on the server, only these fail while plain (AppleScript)
        // messages keep working — so give a targeted hint.
        const isReply = replyGuid.length > 0;
        const looksLikePrivateApi =
          isReply && /private|method|not enabled|helper/i.test(detail);
        const reason = looksLikePrivateApi
          ? `Replies need the BlueBubbles Private API, which the server rejected. Enable “Private API Features” in the BlueBubbles server settings (and install the Private API helper bundle). Server said: ${detail}`
          : detail;
        setConnectionNotice(`Unable to send message: ${reason}`);
        replaceMessage(chatGUID, optimistic.guid, {
          ...optimistic,
          pending: false,
          failed: true,
          failedReason: reason,
        });
      }
    })();
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // Let the emoji picker claim navigation / commit keys first.
    if (emoji.handleKeyDown(e)) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
    if (e.key === "Escape" && replyTarget) {
      e.preventDefault();
      setReplyTarget(chatGUID, null);
    }
  }

  function handleInput() {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 140) + "px";
  }

  const ghost =
    "flex h-[34px] w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-[background-color] duration-120 hover:bg-muted hover:text-foreground disabled:opacity-50";

  return (
    <div className="shrink-0 border-t px-3 py-2.5">
      {aiDraft && !aiDraft.usedAt && (
        <div className="mb-2 flex items-start gap-2 rounded-md bg-muted px-3 py-2">
          <div className="min-w-0 flex-1">
            <p className="font-mono text-cc-meta text-muted-foreground">AI suggestion</p>
            <p className="whitespace-pre-wrap text-cc-body text-foreground">{aiDraft.text}</p>
          </div>
          <button
            type="button"
            onClick={() => {
              handleChange(aiDraft.text);
              // Keep the draft around (marked used) so send() can diff against
              // it; the banner hides once the composer holds the text.
              markAiDraftUsed(chatGUID);
              requestAnimationFrame(() => textareaRef.current?.focus());
            }}
            className="h-7 shrink-0 rounded-md bg-primary px-2.5 text-cc-body font-medium text-primary-foreground"
          >
            Use
          </button>
          <button
            type="button"
            onClick={() => {
              if (aiDraft.traceKey) endReplyTrace(aiDraft.traceKey, "rejected");
              logAi({
                kind: "rejected",
                chatGuid: chatGUID,
                model: aiDraft.model,
                profile: aiDraft.profile,
                draftChars: aiDraft.text.length,
              });
              clearAiDraft(chatGUID);
            }}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-[background-color] duration-120 hover:bg-background hover:text-foreground"
            aria-label="Dismiss AI suggestion"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
      {replyTarget && (
        <div className="mb-2 flex items-start gap-2 rounded-md bg-muted px-3 py-2">
          <div className="min-w-0 flex-1">
            <p className="font-mono text-cc-meta text-muted-foreground">
              Replying to {replyTarget.isFromMe ? "yourself" : replyTarget.handle?.firstName || "message"}
            </p>
            <p className="truncate text-cc-body text-foreground">{replyPreview || "Attachment"}</p>
          </div>
          <button
            type="button"
            onClick={() => setReplyTarget(chatGUID, null)}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-[background-color] duration-120 hover:bg-background hover:text-foreground"
            aria-label="Cancel reply"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
      <div className="flex items-end gap-2">
        {/* Tight cluster: paperclip + emoji sit snug, narrow hit-area. */}
        <div className="-mr-1 flex shrink-0 items-center">
          <button
            type="button"
            className={ghost}
            aria-label="Attach file"
            title="Attach photo or video"
            disabled={attaching}
            onClick={() => fileInputRef.current?.click()}
          >
            <Paperclip className="h-[15px] w-[15px]" />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,video/*"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = ""; // allow re-selecting the same file
              if (file) void sendFile(file);
            }}
          />

          <div className="relative shrink-0">
            <button
              type="button"
              // Keep this pointerdown from reaching the picker's outside-click
              // listener, so the button reliably toggles instead of close+reopen.
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => setPickerOpen((v) => !v)}
              aria-label="Insert emoji"
              aria-expanded={pickerOpen}
              title="Emoji"
              className={cn(ghost, pickerOpen && "bg-muted text-foreground")}
            >
              <Smile className="h-[15px] w-[15px]" />
            </button>
            {pickerOpen && (
              <EmojiPicker
                superlight={superlightMode}
                onSelect={insertEmoji}
                onClose={() => setPickerOpen(false)}
              />
            )}
          </div>
        </div>

        <div className="relative min-w-0 flex-1" onClick={() => textareaRef.current?.focus()}>
          <EmojiSuggestions
            suggestions={emoji.suggestions}
            activeIndex={emoji.activeIndex}
            superlight={superlightMode}
            onSelect={emoji.select}
            onHover={emoji.setActiveIndex}
          />
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => {
              handleChange(e.target.value);
              emoji.syncCaret();
            }}
            onKeyDown={handleKeyDown}
            onKeyUp={emoji.syncCaret}
            onSelect={emoji.syncCaret}
            onInput={handleInput}
            placeholder="Reply…"
            rows={1}
            className={cn(
              "scrollbar-autohide block max-h-[140px] min-h-[34px] w-full resize-none overflow-y-auto rounded-md bg-background px-2.5 py-[7.5px] text-cc-body caret-foreground placeholder:text-muted-foreground focus:outline-none",
              "shadow-[inset_0_0_0_1px_hsl(var(--border))] focus:shadow-[inset_0_0_0_1.5px_hsl(var(--primary))]"
            )}
          />
        </div>

        <button
          type="button"
          onClick={send}
          disabled={!hasText}
          aria-label="Send message"
          className={cn(
            "flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-md transition-[background-color] duration-120",
            hasText ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
          )}
        >
          <CornerDownLeft className="h-[15px] w-[15px]" />
        </button>
      </div>
    </div>
  );
}
