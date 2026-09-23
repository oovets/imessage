// @vitest-environment jsdom
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Chat, Message } from "@/types";

// The store arms its debounce timer while hydrating at import, so timers must
// be fake before the module loads.
type Store = (typeof import("./useAppStore"))["useAppStore"];
let useAppStore: Store;

const KEY = "imessage-cache";
const CHAT = "iMessage;-;+46701234567";

let writes: string[] = [];
let failWrites = false;

// Node's own (file-less) localStorage global shadows jsdom's, so the store
// gets an in-memory one that also records what reaches it.
const saved = new Map<string, string>();
const memoryStorage = {
  getItem: (key: string) => saved.get(key) ?? null,
  setItem: (key: string, value: string) => {
    if (key === KEY) {
      if (failWrites) throw new DOMException("full", "QuotaExceededError");
      writes.push(value);
    }
    saved.set(key, String(value));
  },
  removeItem: (key: string) => {
    saved.delete(key);
  },
  clear: () => saved.clear(),
  key: (i: number) => [...saved.keys()][i] ?? null,
  get length() {
    return saved.size;
  },
};

beforeAll(async () => {
  vi.useFakeTimers();
  vi.stubGlobal("localStorage", memoryStorage);
  ({ useAppStore } = await import("./useAppStore"));
});

afterAll(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** The pagehide handler writes whatever is pending right away. */
function flushNow() {
  window.dispatchEvent(new Event("pagehide"));
}

beforeEach(() => {
  failWrites = false;
  flushNow();
  writes = [];
});

function lastWrittenState(): Record<string, unknown> {
  expect(writes.length).toBeGreaterThan(0);
  return JSON.parse(writes[writes.length - 1]).state;
}

describe("persist flushes", () => {
  it("writes nothing when only transient state changes", () => {
    const s = useAppStore.getState();
    s.setTyping(CHAT, true);
    s.setChatQuery("anna");
    s.setLoadingMessages(true);
    s.setWsConnected(true);
    s.setTelegramPresence("tg:1:2", { online: true, lastSeen: null });
    vi.advanceTimersByTime(5_000);
    expect(writes).toHaveLength(0);
  });

  it("writes a persisted change once, after the quiet period", () => {
    const before = useAppStore.getState().showTimestamps;
    useAppStore.getState().setShowTimestamps(!before);
    vi.advanceTimersByTime(499);
    expect(writes).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(writes).toHaveLength(1);
    expect(lastWrittenState().showTimestamps).toBe(!before);
  });

  it("keeps a pending write waiting while transient activity continues, as before", () => {
    useAppStore.getState().setShowAvatars(!useAppStore.getState().showAvatars);
    vi.advanceTimersByTime(400);
    useAppStore.getState().setChatQuery("a");
    vi.advanceTimersByTime(400);
    useAppStore.getState().setChatQuery("ab");
    vi.advanceTimersByTime(400);
    expect(writes).toHaveLength(0);
    vi.advanceTimersByTime(100);
    expect(writes).toHaveLength(1);
  });

  it("writes a change that is reverted before the flush as the reverted value", () => {
    const original = useAppStore.getState().superlightMode;
    useAppStore.getState().setSuperlightMode(!original);
    useAppStore.getState().setSuperlightMode(original);
    vi.advanceTimersByTime(500);
    expect(writes).toHaveLength(1);
    expect(lastWrittenState().superlightMode).toBe(original);
  });

  it("writes again after the storage was cleared", () => {
    useAppStore.persist.clearStorage();
    useAppStore.getState().setChatQuery("x");
    vi.advanceTimersByTime(500);
    expect(writes).toHaveLength(1);
  });

  it("retries a write that did not land on the next set", () => {
    failWrites = true;
    useAppStore.getState().setShowTimestamps(!useAppStore.getState().showTimestamps);
    vi.advanceTimersByTime(500);
    expect(writes).toHaveLength(0);

    failWrites = false;
    useAppStore.getState().setChatQuery("retry");
    vi.advanceTimersByTime(500);
    expect(writes).toHaveLength(1);
    expect(lastWrittenState().showTimestamps).toBe(useAppStore.getState().showTimestamps);
  });
});

describe("persisted messages", () => {
  it("keep every declared field, in order, and drop only undeclared ones", () => {
    // Shaped like a BlueBubbles HTTP message: declared fields interleaved with
    // raw server fields on the message, its handle and its attachments.
    const raw = {
      originalROWID: 11,
      guid: "m1",
      text: "hej",
      attributedBody: [{ string: "hej", runs: [] }],
      handle: { originalROWID: 2, address: "+46701234567", service: "iMessage", firstName: "Anna" },
      isFromMe: true,
      dateCreated: 5_000,
      dateRead: 6_000,
      attachments: [
        {
          originalROWID: 3,
          guid: "att-1",
          uti: "public.jpeg",
          mimeType: "image/jpeg",
          transferName: "IMG_1.jpg",
          totalBytes: 1234,
          url: "https://example.test/a",
        },
      ],
      associatedMessageGuid: "",
      associatedMessageType: "",
      chatGUID: CHAT,
      pending: false,
      failed: true,
      failedReason: "Not delivered",
      tempGuid: "temp-1",
      tgReactions: ["👍 2"],
      payloadData: { big: "x".repeat(100) },
    } as unknown as Message;

    useAppStore.getState().setMessages(CHAT, [raw]);
    flushNow();

    const persisted = (lastWrittenState().messages as Record<string, Message[]>)[CHAT][0];
    expect(Object.keys(persisted)).toEqual([
      "guid",
      "text",
      "handle",
      "isFromMe",
      "dateCreated",
      "attachments",
      "associatedMessageGuid",
      "associatedMessageType",
      "chatGUID",
      "pending",
      "failed",
      "failedReason",
      "tempGuid",
      "tgReactions",
    ]);
    expect(persisted).toEqual({
      guid: "m1",
      text: "hej",
      handle: { address: "+46701234567", firstName: "Anna" },
      isFromMe: true,
      dateCreated: 5_000,
      attachments: [
        {
          guid: "att-1",
          mimeType: "image/jpeg",
          transferName: "IMG_1.jpg",
          url: "https://example.test/a",
        },
      ],
      associatedMessageGuid: "",
      associatedMessageType: "",
      chatGUID: CHAT,
      pending: false,
      failed: true,
      failedReason: "Not delivered",
      tempGuid: "temp-1",
      tgReactions: ["👍 2"],
    });

    // Only the copy on disk is slim; the live message is untouched.
    const live = useAppStore.getState().messages[CHAT][0] as unknown as Record<string, unknown>;
    expect(live.attributedBody).toBeDefined();
    expect((live.handle as Record<string, unknown>).service).toBe("iMessage");
  });
});

describe("persisted message lists", () => {
  it("follow every replaced list, so a failed send is still failed after a restart", () => {
    const sent: Message = {
      guid: "local-t1",
      tempGuid: "t1",
      text: "hej",
      isFromMe: true,
      dateCreated: 1_000,
      handle: null,
      attachments: [],
      associatedMessageGuid: "",
      associatedMessageType: "",
      chatGUID: CHAT,
      pending: true,
    };
    const persisted = () =>
      (lastWrittenState().messages as Record<string, Message[]>)[CHAT].find(
        (m) => m.guid === "local-t1"
      );

    useAppStore.getState().setMessages(CHAT, [sent]);
    flushNow();
    expect(persisted()?.pending).toBe(true);

    // The list slimmed above is memoized; the replacement must not reuse it.
    useAppStore
      .getState()
      .replaceMessage(CHAT, "local-t1", { ...sent, pending: false, failed: true, failedReason: "x" });
    flushNow();
    expect(persisted()).toMatchObject({ pending: false, failed: true, failedReason: "x" });
  });
});

// The previous partialize, verbatim, as the byte-for-byte reference.
function legacySlimChat(c: Chat): Chat {
  return {
    guid: c.guid,
    displayName: c.displayName,
    chatIdentifier: c.chatIdentifier,
    participants: (c.participants ?? []).map((p) => ({
      address: p.address,
      firstName: p.firstName,
    })),
    lastMessage: c.lastMessage
      ? ({ dateCreated: c.lastMessage.dateCreated, text: c.lastMessage.text } as Message)
      : null,
    unreadCount: c.unreadCount,
    lastMessageText: c.lastMessageText,
    activityAt: c.activityAt,
    avatarUrl: c.avatarUrl,
    slackSection: c.slackSection,
  } as Chat;
}

function legacySerialised(): string {
  const s = useAppStore.getState();
  const state = {
    superlightMode: s.superlightMode,
    showTimestamps: s.showTimestamps,
    showAvatars: s.showAvatars,
    aiReply: s.aiReply,
    aiReplyChats: s.aiReplyChats,
    onboardingDismissed: s.onboardingDismissed,
    sidebarHidden: s.sidebarHidden,
    appearance: s.appearance,
    linkPreviewsEnabled: s.linkPreviewsEnabled,
    linkPreviewCache: s.linkPreviewCache,
    chats: s.chats.map(legacySlimChat),
    paneTree: s.paneTree,
    activePaneId: s.activePaneId,
    paneLayouts: s.paneLayouts,
    messages: Object.fromEntries(
      Object.entries(s.messages).map(([k, v]) => [k, (v as Message[]).slice(-100)])
    ),
    messageOrder: s.messageOrder,
    messageFetchedAt: s.messageFetchedAt,
    accountLabels: s.accountLabels,
    collapsedAccounts: s.collapsedAccounts,
    starredChats: s.starredChats,
  };
  return JSON.stringify({ state, version: 0 });
}

function slimMessage(guid: string, dateCreated: number, extra: Partial<Message> = {}): Message {
  return {
    guid,
    text: `text ${guid}`,
    isFromMe: false,
    dateCreated,
    handle: { address: "+1", firstName: "Bo" },
    attachments: [],
    associatedMessageGuid: "",
    associatedMessageType: "",
    chatGUID: CHAT,
    ...extra,
  };
}

describe("persisted bytes", () => {
  it("are identical to the previous serialisation when nothing undeclared is stored", () => {
    const rawChat = {
      guid: CHAT,
      displayName: "",
      chatIdentifier: "+46701234567",
      participants: [{ address: "+46701234567", firstName: "Anna", service: "iMessage" }],
      lastMessage: slimMessage("last", 9_000),
      unreadCount: 2,
      lastMessageText: "hi",
      activityAt: 9_000,
      style: 45,
      isArchived: false,
    } as unknown as Chat;
    const long = Array.from({ length: 120 }, (_, i) =>
      slimMessage(`m${i}`, i, i % 7 === 0 ? { pending: true, tempGuid: `t${i}` } : {})
    );
    useAppStore.setState({
      chats: [
        rawChat,
        {
          guid: "tg:1:5",
          displayName: "Group",
          chatIdentifier: "5",
          participants: [],
          lastMessage: null,
          unreadCount: 0,
          lastMessageText: "",
          activityAt: 0,
        },
      ],
      messages: {
        [CHAT]: long,
        "tg:1:5": [
          slimMessage("tg:1:5:1", 1, {
            chatGUID: "tg:1:5",
            failed: true,
            failedReason: "flood",
            tgReactions: ["❤️"],
          }),
        ],
      },
      messageOrder: [CHAT, "tg:1:5"],
      messageFetchedAt: { [CHAT]: 119, "tg:1:5": 1 },
      paneLayouts: { split_a: [40, 60] },
      starredChats: [CHAT],
    });
    flushNow();

    expect(writes).toHaveLength(1);
    expect(writes[0]).toBe(legacySerialised());
  });
});
