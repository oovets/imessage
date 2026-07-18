// Auto-converts the most common ASCII emoticons to emoji as you type.
// A match only fires on a word boundary (preceded by start/space) and once the
// emoticon is complete (followed by space or end), so URLs like http:// and
// mid-word colons are left alone.

const EMOTICONS: Record<string, string> = {
  "<3": "❤️",
  "</3": "💔",
  ":)": "🙂",
  ":-)": "🙂",
  "=)": "🙂",
  ":D": "😃",
  ":-D": "😃",
  "=D": "😃",
  ":(": "🙁",
  ":-(": "🙁",
  ";)": "😉",
  ";-)": "😉",
  ":P": "😛",
  ":-P": "😛",
  ":p": "😛",
  ":-p": "😛",
  "XD": "😆",
  "xD": "😆",
  ":'(": "😢",
  ":o": "😮",
  ":O": "😮",
  ":*": "😘",
  ":|": "😐",
  ":/": "😕",
  ":-/": "😕",
  ">:(": "😠",
};

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Longest first so ">:(" wins over ":(", and ":-)" over ":)".
const ALTERNATION = Object.keys(EMOTICONS)
  .sort((a, b) => b.length - a.length)
  .map(escapeRegExp)
  .join("|");

const EMOTICON_RE = new RegExp(`(^|\\s)(${ALTERNATION})(?=\\s|$)`, "g");

export function autoConvertEmoticons(text: string): string {
  return text.replace(EMOTICON_RE, (_m, lead: string, emoticon: string) => {
    return lead + (EMOTICONS[emoticon] ?? emoticon);
  });
}
