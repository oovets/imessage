import { describe, expect, it } from "vitest";
import { tgChatToChat } from "./adapters";
import type { TgChat } from "./types";

function tgChat(extra: Partial<TgChat> = {}): TgChat {
  return {
    account_id: 1,
    id: 42,
    kind: "private",
    title: "Anna",
    username: null,
    unread_count: 2,
    pinned: false,
    last_message_at: "2026-09-01T10:00:00Z",
    last_message_preview: "hej",
    avatar_key: null,
    muted_until: null,
    ...extra,
  };
}

describe("tgChatToChat mute", () => {
  it("maps muted_until to ms since the epoch", () => {
    const chat = tgChatToChat(1, tgChat({ muted_until: "2038-01-19T03:14:07Z" }));
    expect(chat.mutedUntil).toBe(2_147_483_647_000);
    expect(chat.unreadCount).toBe(2);
    const timed = tgChatToChat(1, tgChat({ muted_until: "2026-09-23T18:30:00+00:00" }));
    expect(timed.mutedUntil).toBe(Date.UTC(2026, 8, 23, 18, 30));
  });

  it("leaves an unmuted chat without the field at all", () => {
    expect("mutedUntil" in tgChatToChat(1, tgChat())).toBe(false);
    // A backend from before mutes existed sends no field.
    const legacy: Partial<TgChat> = tgChat();
    delete legacy.muted_until;
    expect("mutedUntil" in tgChatToChat(1, legacy as TgChat)).toBe(false);
    expect("mutedUntil" in tgChatToChat(1, tgChat({ muted_until: "garbage" }))).toBe(false);
  });
});
