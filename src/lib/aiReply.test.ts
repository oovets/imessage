import { describe, expect, it } from "vitest";
import { __testing } from "./aiReply";

const { enforceEmojiPolicy } = __testing;

describe("emoji policy enforcement", () => {
  // Prompting alone didn't hold: gemma3:12b produced a laughing emoji in 6 of 6
  // replies when its favourites were listed, and still 3 of 6 when asked not to.
  const laughs = { allow: true, laughterIsText: true, directive: "" };

  it("drops laughter emoji for someone who types their laughter", () => {
    expect(enforceEmojiPolicy("ja ok fine 😂", laughs)).toBe("ja ok fine");
  });

  it("keeps a non-laughter emoji", () => {
    expect(enforceEmojiPolicy("aja skit å ta dig 🙄", laughs)).toBe("aja skit å ta dig 🙄");
  });

  it("keeps at most one emoji", () => {
    expect(enforceEmojiPolicy("nice 🙄 kul 👍", laughs)).toBe("nice 🙄 kul");
  });

  it("strips everything when this reply drew no emoji", () => {
    const none = { allow: false, laughterIsText: true, directive: "" };
    expect(enforceEmojiPolicy("lol seriöst 😂 helt värdelös 😅", none)).toBe(
      "lol seriöst helt värdelös"
    );
  });

  it("leaves laughter emoji alone for someone who actually uses them", () => {
    const drawn = { allow: true, laughterIsText: false, directive: "" };
    expect(enforceEmojiPolicy("ja ok fine 😂", drawn)).toBe("ja ok fine 😂");
  });
});
