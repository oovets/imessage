import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import type { Chat, Message } from "@/types";
import { isTauriRuntime } from "@/lib/tauriEnv";

const CONTACT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// Route API calls through the Tauri HTTP plugin (Rust-side) when running in the
// desktop shell. The WebView's own fetch is subject to WKWebView App Transport
// Security and CORS, which block cleartext-HTTP calls to a LAN BlueBubbles
// server (e.g. http://192.168.x.x:1234) — the plugin is immune to both. Falls
// back to the browser fetch in the pure-web build. Same pattern as linkPreview.
const httpFetch: typeof fetch = (input: RequestInfo | URL, init?: RequestInit) =>
  isTauriRuntime()
    ? (tauriFetch as unknown as typeof fetch)(input, init)
    : fetch(input, init);

function encodeParam(value: string): string {
  return encodeURIComponent(value).replace(/!/g, "%21");
}

export class BlueBubblesClient {
  private baseUrl: string;
  private password: string;
  private contactCache: Map<string, string> | null = null;

  constructor(serverUrl: string, password: string) {
    this.baseUrl = serverUrl.replace(/\/$/, "");
    this.password = password;
  }

  private authParam(): string {
    return `guid=${encodeParam(this.password)}`;
  }

  private contactCacheKey(): string {
    return `bb-contact-cache:${this.baseUrl}`;
  }

  private restoreContactCacheFromStorage(): Map<string, string> | null {
    if (typeof window === "undefined") return null;
    try {
      const raw = window.localStorage.getItem(this.contactCacheKey());
      if (!raw) return null;
      const parsed = JSON.parse(raw) as {
        updatedAt?: number;
        contacts?: Record<string, string>;
      };
      if (!parsed || typeof parsed !== "object") return null;
      if (typeof parsed.updatedAt !== "number") return null;
      if (Date.now() - parsed.updatedAt > CONTACT_CACHE_TTL_MS) return null;
      const contacts = parsed.contacts ?? {};
      const map = new Map<string, string>();
      for (const [address, name] of Object.entries(contacts)) {
        if (address && typeof name === "string" && name) {
          map.set(address, name);
        }
      }
      return map;
    } catch {
      return null;
    }
  }

  private persistContactCacheToStorage(map: Map<string, string>): void {
    if (typeof window === "undefined") return;
    try {
      const contacts = Object.fromEntries(map.entries());
      window.localStorage.setItem(
        this.contactCacheKey(),
        JSON.stringify({
          updatedAt: Date.now(),
          contacts,
        })
      );
    } catch {}
  }

  async getContacts(): Promise<Map<string, string>> {
    if (this.contactCache !== null) {
      return this.contactCache;
    }
    const restored = this.restoreContactCacheFromStorage();
    if (restored) {
      this.contactCache = restored;
      return restored;
    }

    try {
      const url = `${this.baseUrl}/api/v1/contact/query?${this.authParam()}`;
      const res = await httpFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });

      if (!res.ok) {
        this.contactCache = new Map();
        return this.contactCache;
      }

      const json = await res.json();
      const contacts: Array<{
        displayName: string;
        phoneNumbers: Array<{ address: string }>;
      }> = json?.data?.data ?? json?.data ?? [];

      const map = new Map<string, string>();
      for (const c of contacts) {
        if (c.displayName) {
          for (const p of c.phoneNumbers ?? []) {
            if (p.address) map.set(p.address, c.displayName);
          }
        }
      }

      this.contactCache = map;
      this.persistContactCacheToStorage(map);
      return map;
    } catch {
      this.contactCache = new Map();
      return this.contactCache;
    }
  }

  async getChats(): Promise<Chat[]> {
    const url = `${this.baseUrl}/api/v1/chat/query?${this.authParam()}`;
    let res: Response;
    try {
      res = await httpFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
    } catch (err) {
      throw new Error(`getChats network error for ${this.baseUrl}: ${String(err)}`);
    }
    if (!res.ok) {
      let detail = "";
      try {
        detail = await res.text();
      } catch {}
      throw new Error(
        `getChats failed for ${this.baseUrl}: HTTP ${res.status}${detail ? ` - ${detail.slice(0, 160)}` : ""}`
      );
    }
    const json = await res.json();
    const chats: Chat[] =
      json?.data?.data ?? json?.data?.chats ?? json?.data ?? [];

    const contactMap = await this.getContacts();
    for (const chat of chats) {
      for (const p of chat.participants ?? []) {
        if (!p.firstName) {
          const name = contactMap.get(p.address);
          if (name) p.firstName = name;
        }
      }
    }

    return chats;
  }

  async enrichChatActivity(
    chats: Chat[],
    onBatch: (sortedChats: Chat[]) => void
  ): Promise<void> {
    type Entry = { chat: Chat; lastMsgTime: number };
    const entries: Entry[] = chats.map((chat) => ({ chat, lastMsgTime: 0 }));

    const MAX_CONCURRENT = 5;
    for (let i = 0; i < chats.length; i += MAX_CONCURRENT) {
      await Promise.all(
        chats.slice(i, i + MAX_CONCURRENT).map(async (chat, batchIdx) => {
          const idx = i + batchIdx;
          try {
            const msgs = await this._getMessages(chat.guid, 1, false);
            if (msgs.length > 0) {
              entries[idx].lastMsgTime = msgs[0].dateCreated;
              entries[idx].chat.lastMessageText = msgs[0].text ?? "";
              // Record the activity time used for unified chat-list ordering.
              entries[idx].chat.activityAt = msgs[0].dateCreated;
            }
          } catch {}
        })
      );
      const sorted = [...entries]
        .sort((a, b) => b.lastMsgTime - a.lastMsgTime)
        .map((e) => e.chat);
      onBatch(sorted);
    }
  }

  private async _getMessages(
    chatGUID: string,
    limit: number,
    includeAttachments: boolean,
    after?: number
  ): Promise<Message[]> {
    let qs = `${this.authParam()}&limit=${limit}`;
    if (includeAttachments) {
      qs += `&with=attachments&withAttachments=true&includeAttachments=true`;
    }
    if (after) {
      qs += `&after=${after}`;
    }
    const url =
      `${this.baseUrl}/api/v1/chat/${encodeURIComponent(chatGUID)}/message` +
      `?${qs}`;

    const res = await httpFetch(url);
    if (!res.ok) throw new Error(`getMessages failed: ${res.status}`);
    const json = await res.json();

    const msgs: Message[] =
      (Array.isArray(json?.data?.data) && json.data.data) ||
      (Array.isArray(json?.data) && json.data) ||
      (Array.isArray(json?.messages) && json.messages) ||
      [];

    for (const m of msgs) {
      m.chatGUID = chatGUID;
    }

    return [...msgs].reverse();
  }

  async getMessages(chatGUID: string, limit = 50, after?: number): Promise<Message[]> {
    const msgs = await this._getMessages(chatGUID, limit, true, after);

    const contactMap = await this.getContacts();
    for (const m of msgs) {
      if (m.handle && !m.handle.firstName) {
        const name = contactMap.get(m.handle.address);
        if (name) m.handle.firstName = name;
      }
    }

    return msgs;
  }

  getAttachmentUrl(
    attachmentGUID: string,
    opts?: { width?: number; quality?: "good" | "better" | "best" }
  ): string {
    let url = `${this.baseUrl}/api/v1/attachment/${encodeURIComponent(attachmentGUID)}/download?${this.authParam()}`;
    // Server-side downscale for inline thumbnails. Unknown params are ignored
    // by the BlueBubbles server (it returns the original), and the caller has an
    // onError fallback to the full URL, so this can never break rendering.
    if (opts?.width) url += `&width=${opts.width}`;
    if (opts?.quality) url += `&quality=${opts.quality}`;
    return url;
  }

  async sendMessage(
    chatGUID: string,
    text: string,
    replyToGUID = "",
    tempGuid?: string
  ): Promise<void> {
    const url = `${this.baseUrl}/api/v1/message/text?${this.authParam()}`;
    const payload: Record<string, unknown> = {
      chatGuid: chatGUID,
      message: text,
      method: replyToGUID ? "private-api" : "apple-script",
      tempGuid: tempGuid ?? crypto.randomUUID(),
    };
    if (replyToGUID) {
      payload.selectedMessageGuid = replyToGUID;
      payload.partIndex = 0;
    }
    const res = await httpFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      let detail = "";
      try {
        detail = await res.text();
      } catch {}
      throw new Error(
        `sendMessage failed: HTTP ${res.status}${detail ? ` - ${detail.slice(0, 160)}` : ""}`
      );
    }
  }

  async sendReaction(
    chatGUID: string,
    selectedMessageGUID: string,
    reaction: string,
    partIndex = 0
  ): Promise<void> {
    const url = `${this.baseUrl}/api/v1/message/react?${this.authParam()}`;
    const res = await httpFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatGuid: chatGUID,
        selectedMessageGuid: selectedMessageGUID,
        reaction,
        partIndex,
      }),
    });
    if (!res.ok) throw new Error(`sendReaction failed: ${res.status}`);
  }
}
