// Shared conversation collection for the offline AI scripts.
//
// Three scripts need the same thing — every message of every conversation,
// both sides, with timestamps — and they used to carry their own copies of
// the credential lookups and API paging. One module now, so a fix to (say)
// Slack mrkdwn stripping or merged iMessage/SMS threads lands everywhere.
//
// Returns per conversation:
//   { guid, guids, name, messages: [{ at, fromMe, text, who? }] }
// sorted oldest-first. `who` is set for Slack channels, where a message can
// come from any of several people.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const TG_DB = join(homedir(), "Library/Application Support/dev.stefan.TelegramGui/telegram_gui.db");

// ---------------------------------------------------------------- iMessage

export function bbPassword(explicit = null) {
  if (explicit) return explicit;
  try {
    const raw = execFileSync(
      "security",
      ["find-generic-password", "-s", "com.oovets.messages", "-a", "secure-config", "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    ).trim();
    const pw = JSON.parse(raw).password;
    if (pw) return pw;
  } catch { /* keychain locked or denied */ }
  try {
    const db = join(homedir(), "Library/Application Support/bluebubbles-server/config.db");
    const pw = execFileSync(
      "sqlite3", ["-readonly", db, "SELECT value FROM config WHERE name='password';"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    ).trim();
    if (pw) return pw;
  } catch { /* no local server */ }
  return null;
}

async function bbFetch(server, path) {
  const res = await fetch(`${server}${path}`);
  if (!res.ok) throw new Error(`${path.split("?")[0]}: HTTP ${res.status}`);
  return res.json();
}

/** address -> contact display name, from the server's Contacts database. */
async function bbContactNames(server, pw) {
  try {
    const json = await bbFetch(server, `/api/v1/contact?password=${pw}`);
    const map = new Map();
    for (const c of json?.data ?? []) {
      const name = [c.firstName, c.lastName].filter(Boolean).join(" ") || c.displayName;
      if (!name) continue;
      for (const e of [...(c.phoneNumbers ?? []), ...(c.emails ?? [])]) {
        const a = (e.address ?? "").trim();
        if (!a) continue;
        map.set(a.includes("@") ? a.toLowerCase() : a.replace(/\D/g, "").slice(-9), name);
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

export async function collectIMessage({ server, password, log = () => {}, maxPerThread = 5000 }) {
  const pw = bbPassword(password);
  if (!pw) {
    log("! iMessage: no BlueBubbles password found, skipping");
    return [];
  }
  const names = await bbContactNames(server, pw);
  let chats;
  try {
    const json = await fetch(`${server}/api/v1/chat/query?password=${pw}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ limit: 1000 }),
    }).then((r) => r.json());
    chats = json?.data ?? [];
  } catch (e) {
    log(`! iMessage: ${e.message}`);
    return [];
  }

  // Merge split iMessage/SMS threads per address, as the app does.
  const byAddress = new Map();
  for (const c of chats) {
    const m = /^(any|iMessage|SMS|RCS);-;(.+)$/.exec(c.guid ?? "");
    if (!m) continue;
    const entry = byAddress.get(m[2]) ?? { address: m[2], guids: [], name: null };
    entry.guids.push(c.guid);
    const p = (c.participants ?? [])[0];
    const key = m[2].includes("@") ? m[2].toLowerCase() : m[2].replace(/\D/g, "").slice(-9);
    entry.name ||=
      c.displayName ||
      (p && [p.firstName, p.lastName].filter(Boolean).join(" ")) ||
      names.get(key) ||
      m[2];
    byAddress.set(m[2], entry);
  }

  const out = [];
  for (const e of byAddress.values()) {
    const canonical =
      e.guids.find((g) => g.startsWith("iMessage;") || g.startsWith("any;")) ?? e.guids[0];
    const messages = [];
    for (const guid of e.guids) {
      for (let offset = 0; offset < maxPerThread; offset += 1000) {
        let json;
        try {
          json = await bbFetch(
            server,
            `/api/v1/chat/${encodeURIComponent(guid)}/message?password=${pw}&limit=1000&offset=${offset}`
          );
        } catch { break; }
        const msgs = json?.data ?? [];
        for (const m of msgs) {
          if (m.associatedMessageGuid) continue; // tapbacks aren't conversation
          const t = (m.text ?? "").trim();
          if (!t) continue;
          messages.push({ at: m.dateCreated ?? 0, fromMe: !!m.isFromMe, text: t });
        }
        if (msgs.length < 1000) break;
      }
    }
    if (messages.length === 0) continue;
    messages.sort((a, b) => a.at - b.at);
    out.push({ guid: canonical, guids: e.guids, name: e.name, messages, source: "imessage" });
  }
  return out;
}

// ---------------------------------------------------------------- Telegram

export function collectTelegram() {
  if (!existsSync(TG_DB)) return [];
  const q = (sql) => {
    try {
      const raw = execFileSync("sqlite3", ["-json", "-readonly", TG_DB, sql], { encoding: "utf8" }).trim();
      return raw ? JSON.parse(raw) : [];
    } catch { return []; }
  };
  const cols = q("SELECT name FROM pragma_table_info('chats');").map((r) => r.name);
  const titleCol = ["title", "name", "display_name"].find((c) => cols.includes(c));
  const idCol = cols.includes("id") ? "id" : "chat_id";
  const rows = q(`
    SELECT m.account_id AS account_id, m.chat_id AS chat_id, m.text AS text,
           m.date AS date, m.outgoing AS outgoing
    FROM messages m WHERE m.text != '' ORDER BY m.date ASC;`);
  const titles = new Map(
    titleCol ? q(`SELECT ${idCol} AS id, ${titleCol} AS t FROM chats;`).map((r) => [String(r.id), r.t]) : []
  );
  const byChat = new Map();
  for (const r of rows) {
    const key = `tg:${r.account_id}:${r.chat_id}`;
    const entry = byChat.get(key) ?? {
      guid: key,
      guids: [key],
      name: titles.get(String(r.chat_id)) || `Telegram ${r.chat_id}`,
      messages: [],
      source: "telegram",
    };
    entry.messages.push({ at: Date.parse(r.date) || 0, fromMe: !!r.outgoing, text: r.text.trim() });
    byChat.set(key, entry);
  }
  return [...byChat.values()];
}

// ---------------------------------------------------------------- Slack

export function slackWorkspaces() {
  try {
    const raw = execFileSync(
      "security",
      ["find-generic-password", "-s", "dev.stefan.TelegramGui", "-a", "secrets", "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    );
    for (const line of raw.split("\n")) {
      const [name, b64] = line.split("\t");
      if (name !== "slack-workspaces" || !b64) continue;
      return JSON.parse(Buffer.from(b64.trim(), "base64").toString("utf8"));
    }
  } catch { /* fall through to the legacy file */ }
  try {
    const path = join(homedir(), ".slack_config.json");
    if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8")).workspaces;
  } catch { /* none */ }
  return [];
}

async function slackApi(token, method, params = {}) {
  const url = new URL(`https://slack.com/api/${method}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const json = await res.json();
  if (!json.ok) throw new Error(`${method}: ${json.error}`);
  return json;
}

/** Slack renders entities, not raw text; the corpus should hold what a human reads. */
function stripMrkdwn(text, userNames) {
  return text
    .replace(/<@([UVW][A-Z0-9]+)(?:\|([^>]*))?>/g, (_m, id, l) => `@${l || userNames[id] || id}`)
    .replace(/<#(C[A-Z0-9]+)(?:\|([^>]*))?>/g, (_m, id, n) => `#${n || id}`)
    .replace(/<((?:https?|mailto):[^>|]+)(?:\|([^>]*))?>/g, (_m, u, l) => l || u)
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .trim();
}

export async function collectSlack({ log = () => {}, perChannel = 400 } = {}) {
  const out = [];
  for (const ws of slackWorkspaces()) {
    if (!ws.token) continue;
    let me;
    const userNames = {};
    try {
      me = (await slackApi(ws.token, "auth.test")).user_id;
      let cursor;
      do {
        const res = await slackApi(ws.token, "users.list", { limit: 200, ...(cursor ? { cursor } : {}) });
        for (const u of res.members ?? []) {
          userNames[u.id] =
            u.profile?.display_name?.trim() || u.real_name?.trim() || u.name || u.id;
        }
        cursor = res.response_metadata?.next_cursor || "";
      } while (cursor);
    } catch (e) {
      log(`! slack ${ws.name}: ${e.message}`);
      continue;
    }

    let channels;
    try {
      channels = (await slackApi(ws.token, "users.conversations", {
        types: "public_channel,private_channel,im,mpim",
        exclude_archived: true,
        limit: 200,
      })).channels ?? [];
    } catch (e) {
      log(`! slack ${ws.name} conversations: ${e.message}`);
      continue;
    }

    const wsId = ws.id ?? ws.name;
    for (const ch of channels) {
      try {
        const res = await slackApi(ws.token, "conversations.history", { channel: ch.id, limit: perChannel });
        const messages = [];
        for (const m of res.messages ?? []) {
          if (m.subtype && m.subtype !== "thread_broadcast") continue;
          const text = stripMrkdwn(m.text ?? "", userNames);
          if (!text) continue;
          messages.push({
            at: Math.round(Number.parseFloat(m.ts) * 1000),
            fromMe: m.user === me,
            text,
            who: m.user ? userNames[m.user] : undefined,
          });
        }
        if (messages.length === 0) continue;
        messages.sort((a, b) => a.at - b.at);
        const name = ch.is_im
          ? (userNames[ch.user] ?? ch.id)
          : `#${ch.name ?? ch.id}`;
        out.push({
          guid: `sl:${wsId}:${ch.id}`,
          guids: [`sl:${wsId}:${ch.id}`],
          name: `${name} · ${ws.name}`,
          messages,
          source: "slack",
        });
      } catch { /* not_in_channel and friends are expected */ }
    }
  }
  return out;
}

/** Everything, from every source. */
export async function collectAll({ server = "http://localhost:1234", password = null, log = () => {} } = {}) {
  return [
    ...(await collectIMessage({ server, password, log })),
    ...collectTelegram(),
    ...(await collectSlack({ log })),
  ];
}
