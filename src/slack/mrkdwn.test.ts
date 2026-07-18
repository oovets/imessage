import { describe, expect, it } from "vitest";
import { parseSlackMarks, slackTextToPlain, stripSlackMarks } from "./mrkdwn";
import { extractFirstUrl } from "@/lib/linkPreview";
import { slFileToAttachment } from "./adapters";
import type { SlFile } from "./types";

describe("slackTextToPlain", () => {
  it("resolves user mentions to names", () => {
    expect(slackTextToPlain("hej <@U0884> kolla", { U0884: "pelle" })).toBe(
      "hej @pelle kolla"
    );
  });

  it("prefers the label Slack already put in the mention", () => {
    expect(slackTextToPlain("<@U0884|andreas> ping", {})).toBe("@andreas ping");
  });

  it("keeps an unresolved mention readable rather than raw", () => {
    expect(slackTextToPlain("<@U0884> hm", {})).toBe("@U0884 hm");
  });

  it("unwraps channels and special mentions", () => {
    expect(slackTextToPlain("<#C123|aspace-nyc> <!here>", {})).toBe(
      "#aspace-nyc @here"
    );
  });

  it("unwraps a bare auto-linked url", () => {
    expect(slackTextToPlain("kolla <https://example.com/a>", {})).toBe(
      "kolla https://example.com/a"
    );
  });

  it("keeps both label and target for a labelled link", () => {
    expect(slackTextToPlain("<https://example.com|the docs>", {})).toBe(
      "the docs (https://example.com)"
    );
  });

  it("unescapes html entities", () => {
    expect(slackTextToPlain("a &lt;b&gt; &amp; c", {})).toBe("a <b> & c");
  });

  it("leaves plain text alone", () => {
    expect(slackTextToPlain("bara vanlig text", {})).toBe("bara vanlig text");
  });
});

describe("link previews on Slack text", () => {
  // The reason mrkdwn has to be unwrapped before rendering: the URL extractor
  // swallows the label, so a labelled Slack link never previewed.
  it("finds no usable url in raw mrkdwn", () => {
    expect(extractFirstUrl("<https://example.com|the docs>")).not.toBe(
      "https://example.com/"
    );
  });

  it("finds the url once unwrapped", () => {
    expect(extractFirstUrl(slackTextToPlain("<https://example.com|the docs>", {}))).toBe(
      "https://example.com/"
    );
  });
});

describe("slFileToAttachment", () => {
  const file = (over: Partial<SlFile>): SlFile => ({
    id: null,
    name: null,
    mimetype: null,
    url_private: null,
    size: null,
    ...over,
  });

  it("keys on the file id when Slack sends one", () => {
    const att = slFileToAttachment("work", file({ id: "F123", url_private: "https://x/a.png" }));
    expect(att?.guid).toBe("slfile:work:F123");
  });

  it("drops a file with no url, since it cannot be fetched", () => {
    expect(slFileToAttachment("work", file({ id: "F123" }))).toBeNull();
  });

  it("gives id-less files distinct keys, so their caches never collide", () => {
    // The key becomes the temp filename — a shared fallback would make two
    // different images overwrite each other on disk.
    const a = slFileToAttachment("work", file({ url_private: "https://x/a.png" }));
    const b = slFileToAttachment("work", file({ url_private: "https://x/b.png" }));
    expect(a?.guid).not.toBe(b?.guid);
  });
});

describe("emoji shortcodes", () => {
  it("converts a known shortcode to its character", () => {
    expect(slackTextToPlain("ses imorrn :heart:", {})).toBe("ses imorrn ❤️");
  });

  it("leaves workspace-custom emoji alone, since they have no character", () => {
    expect(slackTextToPlain("nice :aspace-logo:", {})).toBe("nice :aspace-logo:");
  });

  it("keeps shortcodes out of text the emoji policy would have to filter", () => {
    // enforceEmojiPolicy strips emoji characters, not ":heart:" — so an
    // unconverted shortcode slips past every emoji guardrail.
    expect(slackTextToPlain("tack :heart:", {})).not.toContain(":heart:");
  });
});

describe("full emoji set + marks (the alert-bot messages)", () => {
  it("converts shortcodes outside the small autocomplete table", () => {
    expect(slackTextToPlain(":rotating_light: nere", {})).toBe("🚨 nere");
    expect(slackTextToPlain(":large_green_circle: ok", {})).toBe("🟢 ok");
  });

  it("composes skin tones onto the preceding emoji", () => {
    expect(slackTextToPlain(":crossed_fingers::skin-tone-2:", {})).toBe("🤞🏻");
  });

  it("parses the alert message into styled spans", () => {
    const text = slackTextToPlain(
      ":rotating_light: ALERT TRIGGERED: *Analytics stale* — `aspace-prod-54`",
      {}
    );
    const spans = parseSlackMarks(text);
    expect(spans).toEqual([
      { kind: "text", text: "🚨 ALERT TRIGGERED: " },
      { kind: "bold", text: "Analytics stale" },
      { kind: "text", text: " — " },
      { kind: "code", text: "aspace-prod-54" },
    ]);
  });

  it("leaves math and snake_case alone", () => {
    expect(parseSlackMarks("5*3*2 och foo_bar_baz")).toEqual([
      { kind: "text", text: "5*3*2 och foo_bar_baz" },
    ]);
  });

  it("strips marks for previews and the corpus", () => {
    expect(stripSlackMarks("*oplog-fönstret* är nere på `4h`")).toBe(
      "oplog-fönstret är nere på 4h"
    );
  });
});
