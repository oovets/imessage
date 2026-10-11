// Nicks in IRC chats: one stable color per nick, and the nick inline at the
// start of a line rather than as a label above it — IRC reads as a transcript.

import { cn } from "@/lib/utils";

/**
 * Hues that stay readable as text in both themes. Yellows and yellow-greens
 * (roughly 45–110) wash out on a light background, so they're left out.
 */
const HUES = [0, 15, 28, 125, 145, 165, 182, 198, 212, 228, 248, 265, 282, 300, 318, 338];

/** IRC's default casemapping (rfc1459): `[]\~` are upper case of `{}|^`. */
export function ircLower(name: string): string {
  return name.replace(/[A-Z[\]\\~]/g, (c) =>
    c === "[" ? "{" : c === "]" ? "}" : c === "\\" ? "|" : c === "~" ? "^" : c.toLowerCase()
  );
}

/**
 * The hue for a nick. Case-insensitive, and trailing `_`/`` ` `` are ignored,
 * so `anna_` (the nick you get when `anna` is taken) keeps anna's color.
 */
export function nickHue(nick: string): number {
  const key = ircLower(nick).replace(/[_`]+$/, "") || ircLower(nick);
  // FNV-1a, so the color is the same on every run and every machine.
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return HUES[(hash >>> 0) % HUES.length];
}

export function Nick({ nick, className }: { nick: string; className?: string }) {
  return (
    <span
      style={{ "--nick-h": nickHue(nick) } as React.CSSProperties}
      className={cn(
        "font-semibold text-[hsl(var(--nick-h)_70%_36%)] dark:text-[hsl(var(--nick-h)_75%_70%)]",
        className
      )}
    >
      {nick}
    </span>
  );
}

/**
 * Split an IRC line's display text (see ircDisplayText) around the sender's
 * nick: `* anna waves` and `-anna- psst` carry it already, a plain line gets
 * it in front when it opens a group.
 */
export function ircLineParts(
  text: string,
  nick: string,
  showNick: boolean
): { before: string; nick: string | null; after: string; rest: string } {
  if (text.startsWith(`* ${nick} `)) {
    return { before: "* ", nick, after: " ", rest: text.slice(nick.length + 3) };
  }
  if (text.startsWith(`-${nick}- `)) {
    return { before: "-", nick, after: "- ", rest: text.slice(nick.length + 3) };
  }
  return showNick
    ? { before: "", nick, after: " ", rest: text }
    : { before: "", nick: null, after: "", rest: text };
}
