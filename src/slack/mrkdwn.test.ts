import { describe, expect, it } from "vitest";
import { slackTextToPlain } from "./mrkdwn";
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
