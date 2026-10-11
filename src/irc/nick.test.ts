import { describe, expect, it } from "vitest";
import { ircLineParts, ircLower, nickHue } from "./nick";

describe("nick colors", () => {
  it("are stable, case-insensitive and ignore a trailing underscore", () => {
    expect(nickHue("anna")).toBe(nickHue("anna"));
    expect(nickHue("Anna")).toBe(nickHue("anna"));
    expect(nickHue("anna_")).toBe(nickHue("anna"));
    expect(nickHue("Nick[away]")).toBe(nickHue("nick{away}"));
  });

  it("spread different nicks over the palette", () => {
    const nicks = ["anna", "bob", "stevoo", "carol", "dave", "erin", "frank", "grace", "heidi", "ivan"];
    expect(new Set(nicks.map(nickHue)).size).toBeGreaterThan(5);
  });

  it("never pick a hue that washes out on a light background", () => {
    for (let i = 0; i < 500; i++) {
      const h = nickHue(`nick${i}`);
      expect(h < 45 || h > 110).toBe(true);
    }
  });

  it("fold like IRC does", () => {
    expect(ircLower("Nick[A]\\~")).toBe("nick{a}|^");
  });
});

describe("ircLineParts", () => {
  it("prefixes a plain line only when it opens a group", () => {
    expect(ircLineParts("hej", "anna", true)).toEqual({ before: "", nick: "anna", after: " ", rest: "hej" });
    expect(ircLineParts("hej", "anna", false).nick).toBeNull();
  });

  it("finds the nick already in actions and notices", () => {
    expect(ircLineParts("* anna waves", "anna", false)).toEqual({
      before: "* ",
      nick: "anna",
      after: " ",
      rest: "waves",
    });
    expect(ircLineParts("-anna- psst", "anna", true)).toEqual({
      before: "-",
      nick: "anna",
      after: "- ",
      rest: "psst",
    });
  });
});
