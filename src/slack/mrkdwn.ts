/**
 * Slack mrkdwn → plain text.
 *
 * Slack does not send the text a human typed. Entities are wrapped in angle
 * brackets — `<https://x.com|the label>`, `<@U08846VMHT5>`, `<#C123|general>` —
 * and `&`, `<`, `>` are HTML-escaped. Rendering that raw shows the brackets and,
 * worse, breaks link previews: the URL extractor reads `https://x.com|the label`
 * as one token, so no preview is ever fetched.
 *
 * Everything else (bold, italics, code) is left alone — the message renderer
 * already treats text as plain and that is how the other sources behave.
 */

import { SLACK_EMOJI, SKIN_TONES } from "./emojiMap";

/** `<@U123>` / `<@U123|name>` — the id is resolved against a name map. */
const USER_MENTION = /<@([UVW][A-Z0-9]+)(?:\|([^>]*))?>/g;
/** `<#C123|general>` — Slack always includes the name here. */
const CHANNEL_MENTION = /<#(C[A-Z0-9]+)(?:\|([^>]*))?>/g;
/** `<!here>`, `<!channel>`, `<!subteam^S123|@team>`. */
const SPECIAL_MENTION = /<!([^>|]+)(?:\|([^>]*))?>/g;
/** Any remaining `<url>` or `<url|label>`. */
const LINK = /<((?:https?|mailto):[^>|]+)(?:\|([^>]*))?>/g;

/** `:heart:` — Slack stores emoji as shortcodes, not characters. */
const SHORTCODE = /:([a-zA-Z0-9_+-]+):/g;

/**
 * Turn `:rotating_light:` into 🚨 (full Slack set, see emojiMap.ts) and
 * compose skin tones: `🤞:skin-tone-2:` → 🤞🏻.
 *
 * Two reasons this is not cosmetic. Shortcodes render as literal text in the
 * bubble, and — more importantly — one that reaches the style corpus teaches
 * the model to write ":heart:", which `enforceEmojiPolicy` cannot strip: that
 * filter matches emoji *characters*, so the shortcode would slip through every
 * emoji guardrail we have.
 *
 * Workspace-custom emoji (`:aspace-logo:`) have no unicode character and are
 * left as they are.
 */
function replaceShortcodes(text: string): string {
  return text.replace(SHORTCODE, (whole, name: string) => {
    const tone = SKIN_TONES[name];
    if (tone) return tone; // appended straight after its base emoji
    return SLACK_EMOJI[name] ?? whole;
  });
}

function unescapeEntities(text: string): string {
  // Order matters: &amp; last, or "&amp;lt;" would decode twice.
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

// ---------------------------------------------------------------- marks
//
// Slack formatting: *bold*, _italic_, ~strike~, `code`, ```pre```. These are
// parsed to spans (not HTML) so the bubble can render real styling while the
// chat-list preview and the training corpus get clean text without markers.

export type SlackSpan = {
  kind: "text" | "bold" | "italic" | "strike" | "code" | "pre";
  text: string;
};

const PRE = /```\n?([\s\S]*?)```/g;
const CODE = /`([^`\n]+)`/g;
// Inline marks only take effect at word boundaries — "5*3*2" and snake_case
// stay untouched, which is also how Slack itself parses.
const BOUNDARY = String.raw`[\s(.,;:!?'"‘’“”]`;
const inlineMark = (ch: string) =>
  new RegExp(
    `(?<=^|${BOUNDARY})\\${ch}(\\S(?:[^\\${ch}\\n]*?\\S)?)\\${ch}(?=$|${BOUNDARY})`,
    "g"
  );
const BOLD = inlineMark("*");
const ITALIC = inlineMark("_");
const STRIKE = inlineMark("~");

/** Split every `text` span that matches `re` into (text, styled, text, …). */
function splitBy(
  spans: SlackSpan[],
  re: RegExp,
  kind: SlackSpan["kind"]
): SlackSpan[] {
  const out: SlackSpan[] = [];
  for (const span of spans) {
    if (span.kind !== "text") {
      out.push(span);
      continue;
    }
    let last = 0;
    re.lastIndex = 0;
    for (let m = re.exec(span.text); m; m = re.exec(span.text)) {
      if (m.index > last) out.push({ kind: "text", text: span.text.slice(last, m.index) });
      out.push({ kind, text: m[1] });
      last = m.index + m[0].length;
    }
    if (last < span.text.length) out.push({ kind: "text", text: span.text.slice(last) });
  }
  return out;
}

/** Parse one message's text into renderable spans. */
export function parseSlackMarks(text: string): SlackSpan[] {
  let spans: SlackSpan[] = [{ kind: "text", text }];
  spans = splitBy(spans, PRE, "pre");
  spans = splitBy(spans, CODE, "code");
  spans = splitBy(spans, BOLD, "bold");
  spans = splitBy(spans, ITALIC, "italic");
  spans = splitBy(spans, STRIKE, "strike");
  return spans;
}

/** "*Analytics stale* — `aspace-prod-54`" → "Analytics stale — aspace-prod-54". */
export function stripSlackMarks(text: string): string {
  return parseSlackMarks(text)
    .map((s) => s.text)
    .join("");
}

/**
 * @param userNames  Slack user id -> display name, for `<@U123>` without a label.
 */
export function slackTextToPlain(
  text: string,
  userNames: Record<string, string> = {}
): string {
  if (!text) return "";

  return replaceShortcodes(
    unescapeEntities(
      text
      .replace(USER_MENTION, (_m, id: string, label?: string) => {
        const name = label || userNames[id];
        // An unresolved id is still better shown as @U123 than as a raw entity.
        return `@${name || id}`;
      })
      .replace(CHANNEL_MENTION, (_m, id: string, name?: string) => `#${name || id}`)
      .replace(SPECIAL_MENTION, (_m, kind: string, label?: string) => {
        if (label) return label.startsWith("@") ? label : `@${label}`;
        // `subteam^S123` with no label carries nothing readable.
        return `@${kind.split("^")[0]}`;
      })
      // A bare `<url>` becomes the url; a labelled one keeps the label but
      // appends the target, so the link is still visible and previewable.
        .replace(LINK, (_m, url: string, label?: string) =>
          !label || label === url ? url : `${label} (${url})`
        )
    )
  );
}
