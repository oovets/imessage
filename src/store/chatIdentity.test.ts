// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Chat, Message } from "@/types";
import { useAppStore } from "./useAppStore";

const IM = "iMessage;-;+46701234567";

function chat(guid: string, extra: Partial<Chat> = {}): Chat {
  return {
    guid,
    displayName: `Chat ${guid}`,
    chatIdentifier: guid,
    participants: [],
    lastMessage: null,
    unreadCount: 0,
    lastMessageText: "",
    activityAt: 0,
    ...extra,
  };
}

function message(guid: string, dateCreated: number, extra: Partial<Message> = {}): Message {
  return {
    guid,
    text: "hej",
    isFromMe: false,
    dateCreated,
    handle: null,
    attachments: [],
    associatedMessageGuid: "",
    associatedMessageType: "",
    chatGUID: IM,
    ...extra,
  };
}

/** Deep copy: a fresh object graph, like every source's reload produces. */
function fresh<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

/** Counts store notifications from here on. */
function watchCommits() {
  const listener = vi.fn();
  const unsubscribe = useAppStore.subscribe(listener);
  return {
    get count() {
      return listener.mock.calls.length;
    },
    unsubscribe,
  };
}

beforeEach(() => {
  useAppStore.setState({
    chats: [],
    messages: {},
    messageFetchedAt: {},
    messageOrder: [],
    typingChats: {},
    replyTarget: {},
    paneLayouts: {},
    paneTree: { type: "leaf", id: "pane_root", chatGUID: null },
    activePaneId: "pane_root",
  });
});

describe("setChatsForSource", () => {
  const tgChats = () => [
    chat("tg:1:1", { activityAt: 3_000, lastMessageText: "a" }),
    chat("tg:1:2", {
      activityAt: 2_000,
      lastMessageText: "b",
      lastMessage: message("tg:1:2:last", 2_000, { text: "b" }),
    }),
  ];

  it("keeps the stored list when a reload changes nothing", () => {
    useAppStore.getState().setTelegramChats(tgChats());
    const before = useAppStore.getState().chats;
    const commits = watchCommits();

    useAppStore.getState().setTelegramChats(fresh(tgChats()));

    expect(useAppStore.getState().chats).toBe(before);
    expect(commits.count).toBe(0);
    commits.unsubscribe();
  });

  it("replaces only the chat that changed", () => {
    useAppStore.getState().setTelegramChats(tgChats());
    const [first, second] = useAppStore.getState().chats;

    const reloaded = fresh(tgChats());
    reloaded[1].unreadCount = 4;
    useAppStore.getState().setTelegramChats(reloaded);

    const after = useAppStore.getState().chats;
    expect(after[0]).toBe(first);
    expect(after[1]).not.toBe(second);
    expect(after[1]).toBe(reloaded[1]);
    expect(after[1].unreadCount).toBe(4);
  });

  // One entry per Chat field, so a field added to Chat fails to compile here
  // until reuse is shown to notice a change to it (guid is the identity;
  // unreadCount has its own test below, since a count above 0 is refreshed
  // regardless).
  const FIELD_CHANGES: Record<Exclude<keyof Chat, "guid" | "unreadCount">, Partial<Chat>[]> = {
    displayName: [{ displayName: "Renamed" }],
    chatIdentifier: [{ chatIdentifier: "other" }],
    lastMessageText: [{ lastMessageText: "new" }],
    activityAt: [{ activityAt: 9_999 }],
    avatarUrl: [{ avatarUrl: "https://example.test/a.png" }],
    slackSection: [{ slackSection: "Private" }],
    mutedUntil: [{ mutedUntil: 9_999 }],
    participants: [{ participants: [{ address: "+1", firstName: "Ann" }] }],
    lastMessage: [
      { lastMessage: message("tg:1:2:last", 2_000, { text: "c" }) },
      { lastMessage: message("tg:1:2:last", 2_001, { text: "b" }) },
      { lastMessage: null },
    ],
  };
  const cases = Object.entries(FIELD_CHANGES).flatMap(([field, patches]) =>
    patches.map((patch, i) => [`${field} #${i + 1}`, patch] as [string, Partial<Chat>])
  );

  it.each(cases)("sees a change to %s", (_field, patch) => {
    useAppStore.getState().setTelegramChats(tgChats());
    const reloaded = fresh(tgChats());
    Object.assign(reloaded[1], patch);
    useAppStore.getState().setTelegramChats(reloaded);
    expect(useAppStore.getState().chats.find((c) => c.guid === "tg:1:2")).toBe(reloaded[1]);
  });

  it("sees a participant's name filled in", () => {
    // Contacts resolve after the first load: same address, a name now.
    const stored = chat(IM, { activityAt: 1_000, participants: [{ address: "+1", firstName: "" }] });
    useAppStore.getState().setChats([stored]);
    const reloaded = fresh(stored);
    reloaded.participants[0].firstName = "Ann";
    useAppStore.getState().setChats([reloaded]);
    expect(useAppStore.getState().chats[0]).toBe(reloaded);
  });

  it("sees an unread count going back to zero", () => {
    // Read elsewhere: the stored card has 2, the reload says 0. The fresh
    // object must win or the chat would stay in "Waiting on you".
    const stored = chat("tg:1:1", { activityAt: 3_000, unreadCount: 2 });
    useAppStore.getState().setTelegramChats([stored]);
    const reloaded = { ...fresh(stored), unreadCount: 0 };
    useAppStore.getState().setTelegramChats([reloaded]);
    expect(useAppStore.getState().chats[0]).toBe(reloaded);

    // The same through a Telegram chat_updated.
    useAppStore.getState().setTelegramChats([stored]);
    const updated = { ...fresh(stored), unreadCount: 0 };
    useAppStore.getState().upsertChat(updated);
    expect(useAppStore.getState().chats[0]).toBe(updated);
  });

  it("sees a mute lifted or moved", () => {
    // Unmuted elsewhere: the reload drops mutedUntil. A read chat is reused
    // whenever it compares equal, so the fresh object must win here or the
    // chat would stay out of "Waiting on you" once a message arrives.
    const muted = chat("tg:1:1", { activityAt: 3_000, mutedUntil: 5_000 });
    useAppStore.getState().setTelegramChats([muted]);
    const unmuted = fresh(muted);
    delete unmuted.mutedUntil;
    useAppStore.getState().setTelegramChats([unmuted]);
    expect(useAppStore.getState().chats[0]).toBe(unmuted);

    const remuted = { ...fresh(unmuted), mutedUntil: 6_000 };
    useAppStore.getState().upsertChat(remuted);
    expect(useAppStore.getState().chats[0]).toBe(remuted);
    const moved = { ...fresh(remuted), mutedUntil: 7_000 };
    useAppStore.getState().upsertChat(moved);
    expect(useAppStore.getState().chats[0]).toBe(moved);
  });

  it("still re-sorts when only the order changed", () => {
    // Unsorted (e.g. after upsertMessage moved a chat to the top).
    const [a, b] = tgChats();
    useAppStore.setState({ chats: [b, a] });
    useAppStore.getState().setTelegramChats(fresh(tgChats()));
    const after = useAppStore.getState().chats;
    expect(after.map((c) => c.guid)).toEqual(["tg:1:1", "tg:1:2"]);
    expect(after[0]).toBe(a);
    expect(after[1]).toBe(b);
  });

  it("always re-lists objects the caller hands back from the store", () => {
    // enrichChatActivity updates the stored chats in place, then hands the
    // same objects back to setChats; that must still produce a new list.
    useAppStore.getState().setChats([chat(IM, { activityAt: 1_000 })]);
    const before = useAppStore.getState().chats;
    before[0].lastMessageText = "enriched";
    const commits = watchCommits();

    useAppStore.getState().setChats([...before]);

    expect(useAppStore.getState().chats).not.toBe(before);
    expect(commits.count).toBe(1);
    commits.unsubscribe();
  });

  // An unread chat's card shows a relative time, and an open chat's pane shows
  // relative times; a reload's fresh object is what refreshes those.
  it("still hands an unread chat's card the fresh object", () => {
    const unread = chat("tg:1:1", { activityAt: 3_000, unreadCount: 2 });
    useAppStore.getState().setTelegramChats([unread]);
    const reloaded = fresh(unread);
    useAppStore.getState().setTelegramChats([reloaded]);
    expect(useAppStore.getState().chats[0]).toBe(reloaded);
  });

  it("still hands a chat open in a pane the fresh object", () => {
    const open = chat("tg:1:1", { activityAt: 3_000 });
    useAppStore.getState().setTelegramChats([open]);
    useAppStore.getState().openChatInActivePane("tg:1:1");
    const reloaded = fresh(open);
    useAppStore.getState().setTelegramChats([reloaded]);
    expect(useAppStore.getState().chats[0]).toBe(reloaded);
  });

  it("stores iMessage chats still awaiting enrichment as given", () => {
    const pending = chat(IM, { activityAt: undefined });
    useAppStore.getState().setChats([pending]);
    const reloaded = fresh(pending);
    useAppStore.getState().setChats([reloaded]);
    // enrichChatActivity will fill this very object in place.
    expect(useAppStore.getState().chats[0]).toBe(reloaded);
  });

  it("leaves other sources' chats untouched", () => {
    const im = chat(IM, { activityAt: 5_000 });
    useAppStore.getState().setChats([im]);
    useAppStore.getState().setTelegramChats(tgChats());
    expect(useAppStore.getState().chats.find((c) => c.guid === IM)).toBe(im);
  });
});

describe("upsertChat / upsertChats", () => {
  it("leaves the list alone when the chat is unchanged", () => {
    useAppStore.getState().setTelegramChats([chat("tg:1:1", { activityAt: 5 })]);
    const before = useAppStore.getState().chats;
    const commits = watchCommits();

    useAppStore.getState().upsertChat(chat("tg:1:1", { activityAt: 5 }));

    expect(useAppStore.getState().chats).toBe(before);
    expect(commits.count).toBe(0);
    commits.unsubscribe();
  });

  it("still sorts an unsorted list, like before", () => {
    const older = chat("tg:1:1", { activityAt: 1 });
    const newer = chat("tg:1:2", { activityAt: 2 });
    useAppStore.setState({ chats: [older, newer] });
    useAppStore.getState().upsertChat(fresh(older));
    expect(useAppStore.getState().chats).toEqual([newer, older]);
    expect(useAppStore.getState().chats[1]).toBe(older);
  });

  it("applies a batch exactly like one-by-one upserts, including ties", () => {
    const initial = [
      chat("tg:1:1", { activityAt: 50 }),
      chat("tg:1:2", { activityAt: 40 }),
      chat("tg:1:3", { activityAt: 40 }),
      chat("slack:w:c1", { activityAt: 40 }),
      chat("tg:1:4", { activityAt: 0 }),
      chat("tg:1:5", { activityAt: 0 }),
    ];
    const batch = [
      chat("tg:1:2", { activityAt: 40, unreadCount: 3 }),
      chat("tg:1:6", { activityAt: 40 }),
      chat("tg:1:1", { activityAt: 0 }),
      chat("tg:1:3", { activityAt: 40 }),
      chat("tg:1:2", { activityAt: 40, unreadCount: 1 }),
      chat("tg:1:4", { activityAt: 0 }),
    ];

    useAppStore.setState({ chats: fresh(initial) });
    for (const c of fresh(batch)) useAppStore.getState().upsertChat(c);
    const oneByOne = useAppStore.getState().chats;

    useAppStore.setState({ chats: fresh(initial) });
    useAppStore.getState().upsertChats(fresh(batch));
    const batched = useAppStore.getState().chats;

    expect(batched).toEqual(oneByOne);
  });

  it("commits a whole batch once", () => {
    const commits = watchCommits();
    useAppStore
      .getState()
      .upsertChats([chat("tg:1:1", { activityAt: 1 }), chat("tg:1:2", { activityAt: 2 })]);
    expect(commits.count).toBe(1);
    expect(useAppStore.getState().chats.map((c) => c.guid)).toEqual(["tg:1:2", "tg:1:1"]);
    commits.unsubscribe();
  });
});

describe("chat preview writes", () => {
  it("upsertMessage keeps the chat when the preview text is unchanged", () => {
    useAppStore.getState().setChats([chat(IM, { activityAt: 5_000, lastMessageText: "hej" })]);
    const before = useAppStore.getState().chats;

    // A receipt for an older message with the same text.
    useAppStore.getState().upsertMessage(message("m1", 4_000, { text: "hej" }));

    expect(useAppStore.getState().chats).toBe(before);
    expect(useAppStore.getState().messages[IM]).toHaveLength(1);
  });

  it("upsertMessage still refreshes an unread or open chat, as before", () => {
    useAppStore
      .getState()
      .setChats([chat(IM, { activityAt: 5_000, lastMessageText: "hej", unreadCount: 1 })]);
    const unreadBefore = useAppStore.getState().chats[0];
    useAppStore.getState().upsertMessage(message("m1", 4_000, { text: "hej" }));
    expect(useAppStore.getState().chats[0]).not.toBe(unreadBefore);

    useAppStore.getState().openChatInActivePane(IM);
    const openBefore = useAppStore.getState().chats[0];
    useAppStore.getState().upsertMessage(message("m2", 4_500, { text: "hej" }));
    expect(useAppStore.getState().chats[0]).not.toBe(openBefore);
  });

  it("upsertMessage still updates a different preview text", () => {
    useAppStore.getState().setChats([chat(IM, { activityAt: 5_000, lastMessageText: "hej" })]);
    useAppStore.getState().upsertMessage(message("m1", 4_000, { text: "edited" }));
    expect(useAppStore.getState().chats[0].lastMessageText).toBe("edited");
  });

  it("updateChatPreview skips an unchanged text", () => {
    useAppStore.getState().setChats([chat(IM, { activityAt: 1, lastMessageText: "sent" })]);
    const commits = watchCommits();
    useAppStore.getState().updateChatPreview(IM, "sent");
    expect(commits.count).toBe(0);
    useAppStore.getState().updateChatPreview(IM, "next");
    expect(commits.count).toBe(1);
    expect(useAppStore.getState().chats[0].lastMessageText).toBe("next");
    commits.unsubscribe();
  });

  it("updateChatPreview still refreshes the open chat, as before", () => {
    useAppStore.getState().setChats([chat(IM, { activityAt: 1, lastMessageText: "sent" })]);
    useAppStore.getState().openChatInActivePane(IM);
    const before = useAppStore.getState().chats[0];
    useAppStore.getState().updateChatPreview(IM, "sent");
    expect(useAppStore.getState().chats[0]).not.toBe(before);
    expect(useAppStore.getState().chats[0].lastMessageText).toBe("sent");
  });

  it("opening a chat with nothing unread keeps the chat list", () => {
    useAppStore.getState().setChats([chat(IM, { activityAt: 1 })]);
    const before = useAppStore.getState().chats;
    useAppStore.getState().openChatInActivePane(IM);
    expect(useAppStore.getState().chats).toBe(before);
    expect(useAppStore.getState().selectedChatGUID).toBe(IM);
  });

  it("opening an unread chat still clears its count", () => {
    useAppStore.getState().setChats([chat(IM, { activityAt: 1, unreadCount: 2 })]);
    useAppStore.getState().openChatInActivePane(IM);
    expect(useAppStore.getState().chats[0].unreadCount).toBe(0);
  });
});

describe("no-op transient writes", () => {
  it("setTyping(false) for a chat that isn't typing changes nothing", () => {
    const commits = watchCommits();
    useAppStore.getState().setTyping(IM, false);
    expect(commits.count).toBe(0);
    useAppStore.getState().setTyping(IM, true);
    useAppStore.getState().setTyping(IM, false);
    expect(commits.count).toBe(2);
    expect(IM in useAppStore.getState().typingChats).toBe(false);
    commits.unsubscribe();
  });

  it("setReplyTarget skips an unchanged target", () => {
    const m = message("m1", 1);
    const commits = watchCommits();
    useAppStore.getState().setReplyTarget(IM, null);
    expect(commits.count).toBe(0);
    useAppStore.getState().setReplyTarget(IM, m);
    useAppStore.getState().setReplyTarget(IM, m);
    expect(commits.count).toBe(1);
    useAppStore.getState().setReplyTarget(IM, null);
    expect(commits.count).toBe(2);
    expect(useAppStore.getState().replyTarget[IM] ?? null).toBeNull();
    commits.unsubscribe();
  });
});

describe("setPaneLayout", () => {
  it("skips a layout equal to the stored one", () => {
    useAppStore.getState().setPaneLayout("split_1", [40, 60]);
    const before = useAppStore.getState().paneLayouts;
    useAppStore.getState().setPaneLayout("split_1", [40, 60]);
    expect(useAppStore.getState().paneLayouts).toBe(before);
  });

  it("treats the panels library's 3-decimal rounding as the same layout", () => {
    useAppStore.getState().setPaneLayout("split_1", [200, 100]); // 66.666…/33.333…
    const before = useAppStore.getState().paneLayouts;
    useAppStore.getState().setPaneLayout("split_1", [66.667, 33.333]);
    expect(useAppStore.getState().paneLayouts).toBe(before);
  });

  it("writes a real change", () => {
    useAppStore.getState().setPaneLayout("split_1", [40, 60]);
    useAppStore.getState().setPaneLayout("split_1", [45, 55]);
    expect(useAppStore.getState().paneLayouts.split_1).toEqual([45, 55]);
  });

  it("writes a group seen for the first time", () => {
    useAppStore.getState().setPaneLayout("split_2", [50, 50]);
    expect(useAppStore.getState().paneLayouts.split_2).toEqual([50, 50]);
  });
});
