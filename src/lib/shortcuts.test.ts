import { afterEach, describe, expect, it, vi } from "vitest";
import { altLabel, isPrimaryModifier, modLabel, shiftModLabel } from "@/lib/shortcuts";

function stubPlatform(platform: string) {
  vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("shortcut labels", () => {
  it("uses glyphs on macOS", () => {
    stubPlatform("MacIntel");
    expect(modLabel("K")).toBe("⌘K");
    expect(modLabel(2)).toBe("⌘2");
    expect(shiftModLabel("D")).toBe("⇧⌘D");
    expect(altLabel("↵")).toBe("⌥↵");
  });

  it("spells modifiers out on Linux", () => {
    stubPlatform("Linux x86_64");
    expect(modLabel("K")).toBe("Ctrl+K");
    expect(modLabel(2)).toBe("Ctrl+2");
    expect(shiftModLabel("D")).toBe("Ctrl+Shift+D");
    expect(altLabel("↵")).toBe("Alt+↵");
  });
});

describe("isPrimaryModifier", () => {
  it("is ⌘ alone on macOS", () => {
    stubPlatform("MacIntel");
    expect(isPrimaryModifier({ metaKey: true, ctrlKey: false })).toBe(true);
    expect(isPrimaryModifier({ metaKey: false, ctrlKey: true })).toBe(false);
    expect(isPrimaryModifier({ metaKey: true, ctrlKey: true })).toBe(false);
  });

  it("is Ctrl alone on Linux", () => {
    stubPlatform("Linux x86_64");
    expect(isPrimaryModifier({ metaKey: false, ctrlKey: true })).toBe(true);
    expect(isPrimaryModifier({ metaKey: true, ctrlKey: false })).toBe(false);
    expect(isPrimaryModifier({ metaKey: true, ctrlKey: true })).toBe(false);
  });
});
