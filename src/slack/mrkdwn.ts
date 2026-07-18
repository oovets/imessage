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

/** `<@U123>` / `<@U123|name>` — the id is resolved against a name map. */
const USER_MENTION = /<@([UVW][A-Z0-9]+)(?:\|([^>]*))?>/g;
/** `<#C123|general>` — Slack always includes the name here. */
const CHANNEL_MENTION = /<#(C[A-Z0-9]+)(?:\|([^>]*))?>/g;
/** `<!here>`, `<!channel>`, `<!subteam^S123|@team>`. */
const SPECIAL_MENTION = /<!([^>|]+)(?:\|([^>]*))?>/g;
/** Any remaining `<url>` or `<url|label>`. */
const LINK = /<((?:https?|mailto):[^>|]+)(?:\|([^>]*))?>/g;

function unescapeEntities(text: string): string {
  // Order matters: &amp; last, or "&amp;lt;" would decode twice.
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/**
 * @param userNames  Slack user id -> display name, for `<@U123>` without a label.
 */
export function slackTextToPlain(
  text: string,
  userNames: Record<string, string> = {}
): string {
  if (!text) return "";

  return unescapeEntities(
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
  );
}
