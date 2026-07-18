import { describe, expect, it } from "vitest";
import { slackTextToPlain } from "./mrkdwn";
import { extractFirstUrl } from "@/lib/linkPreview";

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
