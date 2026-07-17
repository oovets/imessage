import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { searchEmojis, findEmojiByName, findEmojisByWord, type Emoji } from "@/lib/emoji";

// Matches a `:shortcode` token that ends at the caret. The token must start at
// the beginning of input or after whitespace, so URLs / times like "10:30" or
// "http://" don't trigger the picker.
const TOKEN_RE = /(?:^|\s):([a-z0-9_+-]+)$/i;

// Matches a plain trailing word (Messages-style trigger). Requires ≥3 letters so
// ordinary short words ("ok", "no", "hi") don't pop the picker.
const WORD_RE = /(?:^|\s)([\p{L}]{3,})$/u;

// A complete `:shortcode:` typed in one go — converted to the emoji directly.
const CLOSED_RE = /(?:^|\s):([a-z0-9_+-]+):$/i;

const MIN_QUERY = 2;
const MAX_SUGGESTIONS = 8;

interface EmojiToken {
  query: string;
  /** Number of chars before the caret this token spans (incl. leading ':'). */
  length: number;
  kind: "colon" | "word";
}

interface UseEmojiAutocomplete {
  /** Suggestions to render; empty when the picker is closed. */
  suggestions: Emoji[];
  /** Index of the highlighted suggestion. */
  activeIndex: number;
  /** Whether the picker is currently open. */
  open: boolean;
  /** Highlight a suggestion (e.g. on hover). */
  setActiveIndex: (i: number) => void;
  /** Commit the suggestion at `index` into the text. */
  select: (index: number) => void;
  /** Keep the detected caret position in sync (onSelect/onClick/onKeyUp). */
  syncCaret: () => void;
  /**
   * Handle a keydown while the picker is open. Returns true if the event was
   * consumed and the caller should stop (i.e. not send / insert a newline).
   */
  handleKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => boolean;
}

export function useEmojiAutocomplete(
  text: string,
  setText: (value: string) => void,
  textareaRef: RefObject<HTMLTextAreaElement>
): UseEmojiAutocomplete {
  const [caret, setCaret] = useState(0);
  const [activeIndex, setActiveIndex] = useState(0);
  // Shortcode the user explicitly dismissed with Escape; cleared when it changes.
  const [dismissed, setDismissed] = useState<string | null>(null);

  const syncCaret = useCallback(() => {
    const el = textareaRef.current;
    if (el) setCaret(el.selectionStart ?? text.length);
  }, [textareaRef, text.length]);

  const token = useMemo<EmojiToken | null>(() => {
    const before = text.slice(0, caret);
    const colon = before.match(TOKEN_RE);
    if (colon) {
      return { query: colon[1].toLowerCase(), length: colon[1].length + 1, kind: "colon" };
    }
    const word = before.match(WORD_RE);
    if (word) {
      return { query: word[1].toLowerCase(), length: word[1].length, kind: "word" };
    }
    return null;
  }, [text, caret]);

  const query = token?.query ?? null;

  const suggestions = useMemo(() => {
    if (!token || token.query === dismissed) return [];
    if (token.kind === "colon") {
      if (token.query.length < MIN_QUERY) return [];
      return searchEmojis(token.query, MAX_SUGGESTIONS);
    }
    // Plain word: exact matches only, so ordinary sentences stay quiet.
    return findEmojisByWord(token.query, MAX_SUGGESTIONS);
  }, [token, dismissed]);

  const open = suggestions.length > 0;

  // Reset highlight whenever the result set changes.
  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  // Clear a stale dismissal once the user types a different token.
  useEffect(() => {
    if (dismissed && query !== dismissed) setDismissed(null);
  }, [query, dismissed]);

  const replaceToken = useCallback(
    (tokenLength: number, replacement: string) => {
      const before = text.slice(0, caret);
      const after = text.slice(caret);
      const colon = before.length - tokenLength; // position of the leading ':'
      const next = before.slice(0, colon) + replacement + after;
      setText(next);

      const nextCaret = colon + replacement.length;
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (el) {
          el.focus();
          el.setSelectionRange(nextCaret, nextCaret);
          el.dispatchEvent(new Event("input", { bubbles: true }));
        }
        setCaret(nextCaret);
      });
    },
    [text, caret, setText, textareaRef]
  );

  const select = useCallback(
    (index: number) => {
      const emoji = suggestions[index];
      if (!emoji || !token) return;
      replaceToken(token.length, emoji.char + " ");
    },
    [suggestions, token, replaceToken]
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!open) return false;
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setActiveIndex((i) => (i + 1) % suggestions.length);
          return true;
        case "ArrowUp":
          e.preventDefault();
          setActiveIndex((i) => (i - 1 + suggestions.length) % suggestions.length);
          return true;
        case "Enter":
          // For a plain-word suggestion, Enter should still send the message
          // (the word stays as typed) — only Tab / click accepts the emoji.
          // A `:shortcode` was explicit intent, so Enter accepts it.
          if (token?.kind === "word") return false;
          e.preventDefault();
          select(activeIndex);
          return true;
        case "Tab":
          e.preventDefault();
          select(activeIndex);
          return true;
        case "Escape":
          e.preventDefault();
          setDismissed(query);
          return true;
        default:
          return false;
      }
    },
    [open, suggestions.length, select, activeIndex, query, token]
  );

  return {
    suggestions,
    activeIndex,
    open,
    setActiveIndex,
    select,
    syncCaret,
    handleKeyDown,
  };
}

/**
 * If `text` ends in a complete `:shortcode:` token, return the text with that
 * token replaced by its emoji. Returns null when there's nothing to convert.
 * Lets power users type `:fire:` and get 🔥 without touching the picker.
 */
export function autoReplaceClosedShortcode(text: string): string | null {
  const match = text.match(CLOSED_RE);
  if (!match) return null;
  const emoji = findEmojiByName(match[1]);
  if (!emoji) return null;
  const token = `:${match[1]}:`;
  return text.slice(0, text.length - token.length) + emoji.char + " ";
}
