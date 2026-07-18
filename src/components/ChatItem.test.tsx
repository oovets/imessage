// @vitest-environment jsdom
import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Chat } from "@/types";
import { ChatItem } from "./ChatItem";

vi.mock("@/telegram/useTelegramAvatar", () => ({ useTelegramAvatar: () => null }));
vi.mock("@/lib/contactAvatars", () => ({ useContactAvatar: () => null }));

const chat = (over: Partial<Chat> = {}): Chat =>
  ({
    guid: "sl:work:C1",
    displayName: "#daily",
    chatIdentifier: "C1",
    participants: [],
    lastMessage: null,
    unreadCount: 0,
    ...over,
  }) as Chat;

describe("ChatItem star", () => {
  it("renders the star affordance and toggles on click without selecting", () => {
    const onToggleStar = vi.fn();
    const onSelect = vi.fn();
    const { getByLabelText } = render(
      <ChatItem
        chat={chat()}
        isSelected={false}
        onSelect={onSelect}
        starred={false}
        onToggleStar={onToggleStar}
      />
    );
    fireEvent.click(getByLabelText("Star chat"));
    expect(onToggleStar).toHaveBeenCalledWith("sl:work:C1");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("shows a filled, always-visible star when pinned", () => {
    const { getByLabelText } = render(
      <ChatItem
        chat={chat()}
        isSelected={false}
        onSelect={() => {}}
        starred
        onToggleStar={() => {}}
      />
    );
    const star = getByLabelText("Unstar chat");
    expect(star.className).toContain("text-amber-500");
    expect(star.className).not.toContain("opacity-0");
  });
});
