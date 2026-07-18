// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BlueBubblesClient } from "./client";
import { preferredSendGuid } from "@/lib/chatThreadMerge";

vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));
vi.mock("@/lib/tauriEnv", () => ({ isTauriRuntime: () => false }));

interface Call {
  url: string;
  method: string;
  body: unknown;
}

let calls: Call[] = [];

function jsonResponse(data: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ data }),
    text: async () => "",
  } as unknown as Response;
}

function chat(guid: string, lastMessage: { text: string; dateCreated: number } | null) {
  return {
    guid,
    displayName: "",
    chatIdentifier: guid,
    participants: [{ address: "+46701234567", firstName: "" }],
    lastMessage,
    unreadCount: 0,
  };
}

/** Route every request the client makes, recording it. */
function mockServer(chats: unknown[], messagesForGuid: () => unknown[] = () => []) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({
        url,
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (url.includes("/contact/query")) return jsonResponse([]);
      if (url.includes("/chat/query")) return jsonResponse(chats);
      return jsonResponse(messagesForGuid());
    })
  );
}

const chatQueries = () => calls.filter((c) => c.url.includes("/chat/query"));
const messageGets = () => calls.filter((c) => c.url.includes("/message"));

beforeEach(() => {
  calls = [];
});

describe("getChats", () => {
  it("asks for lastMessage and makes no per-chat requests", async () => {
    // Regression: getChats used to POST {} — no lastMessage came back, so
    // enrichChatActivity issued one limit-1 GET per chat (per merged variant)
    // on every single chat-list load.
    const chats = Array.from({ length: 50 }, (_, i) =>
      chat(`iMessage;-;+4670000${i}`, { text: `hi ${i}`, dateCreated: 1000 + i })
    );
    mockServer(chats);

    const client = new BlueBubblesClient("http://server:1234", "pw");
    const result = await client.getChats();

    expect(chatQueries()).toHaveLength(1);
    expect(chatQueries()[0].body).toEqual({ with: ["lastMessage"] });
    expect(messageGets()).toHaveLength(0);
    expect(result).toHaveLength(50);
  });

  it("derives activityAt and the preview from the returned lastMessage", async () => {
    mockServer([chat("iMessage;-;+46701234567", { text: "senaste", dateCreated: 4242 })]);

    const [result] = await new BlueBubblesClient("http://s:1234", "pw").getChats();

    expect(result.activityAt).toBe(4242);
    expect(result.lastMessageText).toBe("senaste");
  });

  it("routes replies to whichever merged thread saw the newest message", async () => {
    // The merged-thread send routing used to depend on enrichChatActivity
    // probing each variant; it must survive on the no-extra-request path.
    mockServer([
      chat("iMessage;-;+46701234567", { text: "gammal", dateCreated: 100 }),
      chat("SMS;-;+46701234567", { text: "nyare", dateCreated: 900 }),
    ]);

    const merged = await new BlueBubblesClient("http://s:1234", "pw").getChats();

    expect(merged).toHaveLength(1);
    expect(merged[0].activityAt).toBe(900);
    expect(preferredSendGuid(merged[0].guid)).toBe("SMS;-;+46701234567");
    expect(messageGets()).toHaveLength(0);
  });
});

describe("enrichChatActivity fallback", () => {
  it("does nothing when the server already supplied lastMessage", async () => {
    mockServer([chat("iMessage;-;+46701234567", { text: "hi", dateCreated: 10 })]);
    const client = new BlueBubblesClient("http://s:1234", "pw");
    const chats = await client.getChats();
    calls = [];

    const onBatch = vi.fn();
    await client.enrichChatActivity(chats, onBatch);

    expect(messageGets()).toHaveLength(0);
    expect(onBatch).not.toHaveBeenCalled();
  });

  it("probes only the chats that came back without one", async () => {
    // Older servers ignore `with`, so lastMessage is absent and we must still
    // fill activityAt — but only for those chats.
    mockServer(
      [
        chat("iMessage;-;+46700000001", { text: "har", dateCreated: 10 }),
        chat("iMessage;-;+46700000002", null),
      ],
      () => [{ guid: "m1", text: "hämtad", dateCreated: 55, isFromMe: false, attachments: [] }]
    );
    const client = new BlueBubblesClient("http://s:1234", "pw");
    const chats = await client.getChats();
    calls = [];

    const onBatch = vi.fn();
    await client.enrichChatActivity(chats, onBatch);

    // Exactly one chat lacked lastMessage -> exactly one probe.
    expect(messageGets()).toHaveLength(1);
    // And one list update, not one per batch.
    expect(onBatch).toHaveBeenCalledTimes(1);
  });
});
