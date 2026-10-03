import { describe, expect, it } from "vitest";
import { getChatDisplayName, type Chat } from "./index";

function chat(over: Partial<Chat>): Chat {
  return {
    guid: "iMessage;+;chat1",
    displayName: "",
    chatIdentifier: "chat1",
    participants: [],
    lastMessage: null,
    unreadCount: 0,
    ...over,
  };
}

const maya = { address: "+15550102", firstName: "Maya Chen" };
const jonas = { address: "+15550103", firstName: "Jonas Berg" };

describe("getChatDisplayName", () => {
  it("shows a named group's name", () => {
    expect(getChatDisplayName(chat({ displayName: "Weekend trip", participants: [maya, jonas] }))).toBe(
      "Weekend trip"
    );
  });

  it("lists the people in an unnamed group", () => {
    expect(getChatDisplayName(chat({ participants: [maya, jonas] }))).toBe("Maya Chen, Jonas Berg");
  });

  it("shows the contact for a DM", () => {
    expect(getChatDisplayName(chat({ participants: [maya] }))).toBe("Maya Chen");
  });
});
