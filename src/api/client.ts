import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import type { Chat, Message } from "@/types";
import { isTauriRuntime } from "@/lib/tauriEnv";
import {
  mergeChatThreads,
  chatGuidVariants,
  notePreferredSendGuid,
} from "@/lib/chatThreadMerge";

// Re-check Private API availability at most this often; the helper can drop
// out mid-session when Messages restarts.
const PRIVATE_API_TTL_MS = 60_000;

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
  private privateApiOk = false;
  private privateApiChecked: number | null = null;

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

  /**
   * Raw contact avatars from the server's macOS Contacts database (no Private
   * API involved). Returns base64 image data per contact with every address
   * (phones + emails) it should match; callers downscale and cache.
   */
  async getContactAvatarsRaw(): Promise<Array<{ addresses: string[]; avatar: string }>> {
    const url = `${this.baseUrl}/api/v1/contact?${this.authParam()}&extraProperties=avatar`;
    const res = await httpFetch(url);
    if (!res.ok) return [];
    const json = await res.json();
    const contacts: Array<{
      avatar?: string | null;
      phoneNumbers?: Array<{ address?: string | null }>;
      emails?: Array<{ address?: string | null }>;
    }> = json?.data ?? [];
    const out: Array<{ addresses: string[]; avatar: string }> = [];
    for (const c of contacts) {
      if (!c.avatar) continue;
      const addresses = [...(c.phoneNumbers ?? []), ...(c.emails ?? [])]
        .map((e) => e.address ?? "")
        .filter(Boolean);
      if (addresses.length > 0) out.push({ addresses, avatar: c.avatar });
    }
    return out;
  }

  async getChats(): Promise<Chat[]> {
    const url = `${this.baseUrl}/api/v1/chat/query?${this.authParam()}`;
    let res: Response;
    try {
      res = await httpFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Ask for the last message inline: without it every chat needed its
        // own limit-1 probe afterwards (600+ requests on a real account).
        body: JSON.stringify({ with: ["lastMessage"] }),
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
      // The server response is cast, not validated. A missing unreadCount would
      // otherwise become NaN on the first increment — and NaN is sticky, since
      // the reset path only fires on `unreadCount > 0`.
      if (typeof chat.unreadCount !== "number" || !Number.isFinite(chat.unreadCount)) {
        chat.unreadCount = 0;
      }
      for (const p of chat.participants ?? []) {
        if (!p.firstName) {
          const name = contactMap.get(p.address);
          if (name) p.firstName = name;
        }
      }
      // Sort key + preview straight from the server's lastMessage, so the list
      // is complete without any follow-up requests.
      if (chat.lastMessage?.dateCreated) {
        chat.activityAt = chat.lastMessage.dateCreated;
        chat.lastMessageText ??= chat.lastMessage.text ?? "";
      }
    }

    // Collapse split per-service DM threads (pre-macOS-26 hosts) into one
    // conversation per contact, like Apple's Messages app does.
    const merged = mergeChatThreads(chats);

    // Derive chat-list ordering and reply routing from the lastMessage the
    // server just gave us. A merged conversation spans several threads, so pick
    // whichever variant saw the newest traffic — the same decision
    // enrichChatActivity used to make with one HTTP request per variant.
    const rawByGuid = new Map(chats.map((c) => [c.guid, c]));
    // If not a single chat came back with a lastMessage, the server most likely
    // ignored `with` — leave activityAt unset so the fallback probes. If some
    // chats have one, the server honoured it and the rest are genuinely empty.
    const serverHonouredWith = chats.some((c) => c.lastMessage);
    for (const chat of merged) {
      let newest: Message | null = null;
      let newestVariant = chat.guid;
      for (const variant of chatGuidVariants(chat.guid)) {
        const candidate = rawByGuid.get(variant)?.lastMessage;
        if (candidate && (!newest || candidate.dateCreated > newest.dateCreated)) {
          newest = candidate;
          newestVariant = variant;
        }
      }
      if (!newest) {
        // Genuinely empty conversation: record that, so the fallback doesn't
        // re-probe it on every single load.
        if (serverHonouredWith) chat.activityAt = 0;
        continue;
      }
      chat.activityAt = newest.dateCreated;
      chat.lastMessageText = newest.text ?? "";
      notePreferredSendGuid(newestVariant);
    }
    return merged;
  }

  /**
   * Fallback for servers that ignore `with: ["lastMessage"]` (older
   * BlueBubbles): fill activityAt/preview for the chats that came back without
   * one, probing only those and updating the list once when done. On a server
   * that honours the flag this makes no requests at all.
   */
  /**
   * Fallback for chats that came back without a lastMessage.
   *
   * getChats now derives activity and reply routing from the chat list itself,
   * so this only probes what the server couldn't answer for. Chats it has
   * already established are empty carry activityAt === 0 and are skipped, so a
   * quiet conversation isn't re-probed on every load.
   */
  async enrichChatActivity(
    chats: Chat[],
    onBatch: (sortedChats: Chat[]) => void
  ): Promise<void> {
    const stale = chats.filter((c) => c.activityAt === undefined);
    if (stale.length === 0) return;

    const MAX_CONCURRENT = 5;
    for (let i = 0; i < stale.length; i += MAX_CONCURRENT) {
      await Promise.all(
        stale.slice(i, i + MAX_CONCURRENT).map(async (chat) => {
          try {
            // A merged conversation spans several underlying threads; the
            // preview must reflect whichever thread saw the latest message.
            let newest: Message | null = null;
            let newestVariant = chat.guid;
            for (const variant of chatGuidVariants(chat.guid)) {
              const msgs = await this._getMessages(variant, 1, false);
              if (msgs.length > 0 && (!newest || msgs[0].dateCreated > newest.dateCreated)) {
                newest = msgs[0];
                newestVariant = variant;
              }
            }
            chat.activityAt = newest?.dateCreated ?? 0;
            if (newest) {
              chat.lastMessageText = newest.text ?? "";
              // Replies should go out on the service the contact last used.
              notePreferredSendGuid(newestVariant);
            }
          } catch {}
        })
      );
    }
    // One update at the end: emitting per batch replaced (and re-sorted) the
    // whole chat list ceil(N/5) times, which made the list jump while loading.
    onBatch([...chats].sort((a, b) => (b.activityAt ?? 0) - (a.activityAt ?? 0)));
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
    // A merged conversation reads from every underlying thread (usually just
    // one; two for split iMessage/SMS pairs) and interleaves by time, stamped
    // with the canonical guid so the UI sees a single conversation.
    const variants = chatGuidVariants(chatGUID);
    let msgs: Message[];
    if (variants.length === 1) {
      msgs = await this._getMessages(chatGUID, limit, true, after);
    } else {
      const perThread = await Promise.all(
        variants.map((v) => this._getMessages(v, limit, true, after).catch(() => []))
      );
      msgs = perThread
        .flat()
        .sort((a, b) => a.dateCreated - b.dateCreated)
        .slice(-limit);
      for (const m of msgs) {
        m.chatGUID = chatGUID;
      }
    }

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

  /**
   * Whether the server can send through the Private API right now.
   *
   * macOS 26 broke AppleScript sending in Messages, so on those hosts the
   * Private API is the only working path. It is not a static property: the
   * helper is a dylib injected into Messages and drops out whenever Messages or
   * the server restarts (`private_api: true, helper_connected: false`). Hence a
   * short TTL rather than a permanent cache — a stale "yes" would keep routing
   * sends into a path that silently stopped working.
   */
  private async canUsePrivateApi(): Promise<boolean> {
    const now = Date.now();
    if (this.privateApiChecked !== null && now - this.privateApiChecked < PRIVATE_API_TTL_MS) {
      return this.privateApiOk;
    }
    this.privateApiChecked = now;
    try {
      const res = await httpFetch(`${this.baseUrl}/api/v1/server/info?${this.authParam()}`);
      if (!res.ok) {
        this.privateApiOk = false;
        return false;
      }
      const json = await res.json();
      const info = json?.data ?? {};
      this.privateApiOk = info.private_api === true && info.helper_connected === true;
    } catch {
      // Unreachable server: let the send itself produce the real error.
      this.privateApiOk = false;
    }
    return this.privateApiOk;
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
      // Replies require the Private API regardless (AppleScript can't thread).
      // Plain messages prefer it when it's actually usable, and only fall back
      // to AppleScript otherwise — which is what fails on macOS 26.
      method: replyToGUID || (await this.canUsePrivateApi()) ? "private-api" : "apple-script",
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

  /** Send a file attachment. Uses the AppleScript method, which does not
   *  require the BlueBubbles Private API (only replies/reactions do). */
  async sendAttachment(
    chatGUID: string,
    file: Blob,
    name: string,
    tempGuid?: string
  ): Promise<void> {
    const url = `${this.baseUrl}/api/v1/message/attachment?${this.authParam()}`;
    const form = new FormData();
    form.append("chatGuid", chatGUID);
    form.append("tempGuid", tempGuid ?? crypto.randomUUID());
    form.append("name", name);
    form.append("method", "apple-script");
    form.append("attachment", file, name);
    const res = await httpFetch(url, { method: "POST", body: form });
    if (!res.ok) {
      let detail = "";
      try {
        detail = await res.text();
      } catch {}
      throw new Error(
        `sendAttachment failed: HTTP ${res.status}${detail ? ` - ${detail.slice(0, 160)}` : ""}`
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
