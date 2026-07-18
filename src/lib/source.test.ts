import { describe, expect, it } from "vitest";
import {
  SOURCE_CAPABILITIES,
  SOURCE_PREFIX,
  isSource,
  sourceOfGuid,
  supports,
  type ChatSource,
} from "./source";

const ALL_SOURCES: ChatSource[] = ["imessage", "telegram", "slack"];

describe("sourceOfGuid", () => {
  it("detects telegram by prefix", () => {
    expect(sourceOfGuid("tg:1:12345")).toBe("telegram");
  });

  it("detects slack by prefix", () => {
    expect(sourceOfGuid("sl:T123:C456")).toBe("slack");
  });

  it("treats unprefixed GUIDs as iMessage", () => {
    expect(sourceOfGuid("iMessage;-;+46701234567")).toBe("imessage");
    expect(sourceOfGuid("SMS;-;+46701234567")).toBe("imessage");
  });

  it("does not mistake an iMessage GUID containing colons for a prefixed source", () => {
    // iMessage GUIDs are full of separators — only a leading prefix counts.
    expect(sourceOfGuid("iMessage;+;chat tg:not-a-prefix")).toBe("imessage");
  });
});

describe("isSource", () => {
  it("matches only the owning source", () => {
    expect(isSource("tg:1:2", "telegram")).toBe(true);
    expect(isSource("tg:1:2", "imessage")).toBe(false);
    expect(isSource("iMessage;-;+1", "imessage")).toBe(true);
  });
});

describe("capabilities", () => {
  it("keeps contact avatars to iMessage, whose Contacts DB provides them", () => {
    expect(supports("iMessage;-;+1", "contactAvatars")).toBe(true);
    expect(supports("tg:1:2", "contactAvatars")).toBe(false);
    expect(supports("sl:T1:C2", "contactAvatars")).toBe(false);
  });

  it("answers every capability for every source", () => {
    for (const source of ALL_SOURCES) {
      expect(SOURCE_CAPABILITIES[source]).toBeDefined();
      expect(typeof SOURCE_CAPABILITIES[source].contactAvatars).toBe("boolean");
    }
  });
});

describe("prefix table", () => {
  it("gives every non-iMessage source a distinct, non-empty prefix", () => {
    const prefixes = Object.values(SOURCE_PREFIX);
    expect(prefixes.every((p) => p.length > 0)).toBe(true);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });

  it("round-trips each prefix back to its source", () => {
    for (const [source, prefix] of Object.entries(SOURCE_PREFIX)) {
      expect(sourceOfGuid(`${prefix}whatever`)).toBe(source);
    }
  });
});
