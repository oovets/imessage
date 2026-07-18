import { describe, expect, it } from "vitest";
import { retrievalQuery } from "./aiContext";
import { buildSystemPrompt } from "./aiReply";
import type { Message } from "@/types";

const msg = (text: string, fromMe: boolean, at = 0): Message =>
  ({ guid: `${at}`, text, isFromMe: fromMe, dateCreated: at, handle: null,
     attachments: [], associatedMessageGuid: "", associatedMessageType: "", chatGUID: "c" }) as Message;

describe("retrievalQuery", () => {
  it("takes the last incoming burst, not our own replies", () => {
    const q = retrievalQuery([
      msg("gammalt", false, 1),
      msg("mitt svar", true, 2),
      msg("hänger padeln?", false, 3),
      msg("lördag 10?", false, 4),
    ]);
    expect(q).toBe("hänger padeln?\nlördag 10?");
  });

  it("stops at the previous burst boundary", () => {
    const q = retrievalQuery([
      msg("första frågan", false, 1),
      msg("svarade här", true, 2),
      msg("ny fråga", false, 3),
    ]);
    expect(q).toBe("ny fråga");
  });

  it("is empty when the last message is ours", () => {
    expect(retrievalQuery([msg("incoming", false, 1), msg("jag sist", true, 2)])).toBe("incoming");
  });
});

describe("prompt with retrieved context", () => {
  it("adds a dated past-context section with an anti-copy directive", () => {
    const prompt = buildSystemPrompt(
      "Reply as me.", "Pelle", null, "unknown", undefined, "auto", undefined,
      [{ at: 1, text: "[2026-06-12] Me: bokar banan\nPelle: nice", score: 0.55 }]
    );
    expect(prompt).toContain("RELEVANT PAST CONTEXT");
    expect(prompt).toContain("[2026-06-12] Me: bokar banan");
    expect(prompt).toContain("never quote or copy");
  });

  it("omits the section entirely when nothing was retrieved", () => {
    const prompt = buildSystemPrompt("Reply as me.", "Pelle", null);
    expect(prompt).not.toContain("RELEVANT PAST CONTEXT");
  });
});
