#!/usr/bin/env node
// conversation-indexer.mjs — episode embeddings per conversation (RAG).
//
// The reply engine's context is the last ~20 messages, which is blind to
// everything earlier: plans made last week, questions left open. This script
// collects BOTH sides of every substantial conversation (iMessage, Telegram,
// Slack), splits them into episodes at natural gaps, embeds each episode with
// a multilingual model (bge-m3 — chosen 4/4 over nomic 2/4 on Swedish/English
// cross-lingual retrieval), and writes per-conversation indexes the app scans
// with brute-force cosine at reply time. At this scale (tens of thousands of
// episodes at most) a vector database would be pure ceremony.
//
// Embeddings are cheap to redo and derived from data the machine already
// holds, so they live as plain files next to the profiles.
//
// Usage:
//   node scripts/conversation-indexer.mjs                  # index top conversations
//     [--server http://localhost:1234] [--ollama http://gpulab:11434]
//     [--model bge-m3] [--max-conversations 40] [--min-messages 30]
//   node scripts/conversation-indexer.mjs --search "padel" --chat pelle
//                                                          # retrieval spot-check

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 ? process.argv[i + 1] : d;
};

const SERVER = (arg("server", "http://localhost:1234")).replace(/\/$/, "");
const OLLAMA = (arg("ollama", "http://gpulab:11434")).replace(/\/$/, "");
const MODEL = arg("model", "bge-m3");
const MAX_CONVS = parseInt(arg("max-conversations", "40"), 10);
const MIN_MSGS = parseInt(arg("min-messages", "30"), 10);
const OUT = join(homedir(), "Library/Application Support/com.oovets.messages/ai/embeddings");
const TG_DB = join(homedir(), "Library/Application Support/dev.stefan.TelegramGui/telegram_gui.db");

// Episode shape: split at gaps of 3h+, cap length so one marathon evening
// doesn't become a single blob too big to retrieve precisely.
const GAP_MS = 3 * 3600_000;
const MAX_EP_MSGS = 25;
const MIN_EP_CHARS = 60;
const MAX_EP_CHARS = 1500;

const log = (m) => console.log(`[indexer] ${m}`);

// ---------------------------------------------------------------- helpers

function safeName(guid) {
  return guid.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 120);
}

function hashText(text) {
  return createHash("sha1").update(text).digest("hex").slice(0, 12);
}

function packVector(vec) {
  return Buffer.from(new Float32Array(vec).buffer).toString("base64");
}

function unpackVector(b64) {
  const buf = Buffer.from(b64, "base64");
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function embed(inputs) {
  const res = await fetch(`${OLLAMA}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, input: inputs }),
  });
  if (!res.ok) throw new Error(`embed: HTTP ${res.status}`);
  return (await res.json()).embeddings;
}

// ---------------------------------------------------------------- collection
//
// Same sources and credential paths as the style distiller, but keeping BOTH
// sides of each conversation — retrieval needs what they said, not only what
// I answered.

function bbPassword() {
  const flag = arg("password", null);
  if (flag) return flag;
  try {
    const raw = execFileSync(
      "security",
      ["find-generic-password", "-s", "com.oovets.messages", "-a", "secure-config", "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    ).trim();
    const pw = JSON.parse(raw).password;
    if (pw) return pw;
  } catch { /* locked or denied */ }
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

async function bbFetch(path) {
  const res = await fetch(`${SERVER}${path}`);
  if (!res.ok) throw new Error(`${path.split("?")[0]}: HTTP ${res.status}`);
  return res.json();
}

/** address -> contact display name, same source the distiller uses. */
async function bbContactNames(pw) {
  try {
    const json = await bbFetch(`/api/v1/contact?password=${pw}`);
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

async function imessageConversations() {
  const pw = bbPassword();
  if (!pw) {
    log("! iMessage: no BlueBubbles password found, skipping");
    return [];
  }
  const names = await bbContactNames(pw);
  let chats;
  try {
    const json = await fetch(`${SERVER}/api/v1/chat/query?password=${pw}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ limit: 1000 }),
    }).then((r) => r.json());
    chats = json?.data ?? [];
  } catch (e) {
    log(`! iMessage: ${e.message}`);
    return [];
  }

  // Merge split iMessage/SMS threads per address, like the app and distiller.
  const byAddress = new Map();
  for (const c of chats) {
    const m = /^(any|iMessage|SMS|RCS);-;(.+)$/.exec(c.guid ?? "");
    if (!m) continue;
    const entry = byAddress.get(m[2]) ?? { address: m[2], guids: [], name: null };
    entry.guids.push(c.guid);
    const p = (c.participants ?? [])[0];
    const key = m[2].includes("@") ? m[2].toLowerCase() : m[2].replace(/\D/g, "").slice(-9);
    entry.name ||= c.displayName
      || (p && [p.firstName, p.lastName].filter(Boolean).join(" "))
      || names.get(key)
      || m[2];
    byAddress.set(m[2], entry);
  }

  const out = [];
  for (const e of byAddress.values()) {
    const canonical = e.guids.find((g) => g.startsWith("iMessage;") || g.startsWith("any;")) ?? e.guids[0];
    const messages = [];
    for (const guid of e.guids) {
      for (let offset = 0; offset < 5000; offset += 1000) {
        let json;
        try {
          json = await bbFetch(
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
    out.push({ guid: canonical, guids: e.guids, name: e.name, messages });
  }
  return out;
}

function telegramConversations() {
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
      guid: key, guids: [key],
      name: titles.get(String(r.chat_id)) || `Telegram ${r.chat_id}`,
      messages: [],
    };
    entry.messages.push({ at: Date.parse(r.date) || 0, fromMe: !!r.outgoing, text: r.text.trim() });
    byChat.set(key, entry);
  }
  return [...byChat.values()];
}

function slackWorkspaces() {
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
  } catch { /* fall through */ }
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

async function slackConversations() {
  const out = [];
  for (const ws of slackWorkspaces()) {
    if (!ws.token) continue;
    let me, userNames = {};
    try {
      me = (await slackApi(ws.token, "auth.test")).user_id;
      let cursor;
      do {
        const res = await slackApi(ws.token, "users.list", { limit: 200, ...(cursor ? { cursor } : {}) });
        for (const u of res.members ?? []) {
          userNames[u.id] = u.profile?.display_name?.trim() || u.real_name?.trim() || u.name || u.id;
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
        exclude_archived: true, limit: 200,
      })).channels ?? [];
    } catch (e) {
      log(`! slack ${ws.name} conversations: ${e.message}`);
      continue;
    }
    const wsId = ws.id ?? ws.name;
    for (const ch of channels) {
      try {
        const res = await slackApi(ws.token, "conversations.history", { channel: ch.id, limit: 400 });
        const messages = [];
        for (const m of res.messages ?? []) {
          if (m.subtype && m.subtype !== "thread_broadcast") continue;
          const text = (m.text ?? "")
            .replace(/<@([UVW][A-Z0-9]+)(?:\|([^>]*))?>/g, (_x, id, l) => `@${l || userNames[id] || id}`)
            .replace(/<#(C[A-Z0-9]+)(?:\|([^>]*))?>/g, (_x, id, n) => `#${n || id}`)
            .replace(/<((?:https?|mailto):[^>|]+)(?:\|([^>]*))?>/g, (_x, u, l) => l || u)
            .trim();
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
        out.push({ guid: `sl:${wsId}:${ch.id}`, guids: [`sl:${wsId}:${ch.id}`], name, messages });
      } catch { /* not_in_channel etc */ }
    }
  }
  return out;
}

// ---------------------------------------------------------------- episodes

function toEpisodes(conv) {
  const episodes = [];
  let current = [];
  const flush = () => {
    if (current.length === 0) return;
    // Render as dialogue with a date header — the date matters at retrieval
    // time ("last Saturday" means nothing without it).
    const day = new Date(current[0].at).toISOString().slice(0, 10);
    let text = `[${day}] `;
    const lines = [];
    for (const m of current) {
      const who = m.fromMe ? "Me" : (m.who ?? conv.name ?? "Them");
      lines.push(`${who}: ${m.text}`);
    }
    text += lines.join("\n");
    if (text.length >= MIN_EP_CHARS) {
      episodes.push({
        at: current[0].at,
        endAt: current[current.length - 1].at,
        n: current.length,
        text: text.length > MAX_EP_CHARS ? text.slice(0, MAX_EP_CHARS) + "…" : text,
      });
    }
    current = [];
  };
  for (const m of conv.messages) {
    const prev = current[current.length - 1];
    if (prev && (m.at - prev.at > GAP_MS || current.length >= MAX_EP_MSGS)) flush();
    current.push(m);
  }
  flush();
  return episodes;
}

// ---------------------------------------------------------------- search

async function search(query, chatFilter) {
  const indexPath = join(OUT, "index.json");
  if (!existsSync(indexPath)) {
    console.error("No index yet — run the indexer first.");
    process.exit(1);
  }
  const index = JSON.parse(readFileSync(indexPath, "utf8"));
  const entries = index.conversations.filter(
    (c) => !chatFilter || c.name.toLowerCase().includes(chatFilter.toLowerCase())
  );
  if (entries.length === 0) {
    console.error(`No indexed conversation matches "${chatFilter}".`);
    process.exit(1);
  }
  const [qv] = await embed([query]);
  for (const entry of entries.slice(0, 3)) {
    const data = JSON.parse(readFileSync(join(OUT, entry.file), "utf8"));
    const scored = data.episodes
      .map((ep) => ({ ep, score: cosine(qv, unpackVector(ep.v)) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
    console.log(`\n=== ${entry.name} (${data.episodes.length} episoder)`);
    for (const { ep, score } of scored) {
      const preview = ep.text.replace(/\n/g, " / ").slice(0, 180);
      console.log(`  ${score.toFixed(3)}  ${preview}`);
    }
  }
}

// ---------------------------------------------------------------- main

async function main() {
  const query = arg("search", null);
  if (query) return search(query, arg("chat", ""));

  mkdirSync(OUT, { recursive: true });
  log("collecting conversations (both sides)…");
  const convs = [
    ...(await imessageConversations()),
    ...telegramConversations(),
    ...(await slackConversations()),
  ]
    .filter((c) => c.messages.length >= MIN_MSGS)
    .sort((a, b) => b.messages.length - a.messages.length)
    .slice(0, MAX_CONVS);
  log(`${convs.length} conversations to index (min ${MIN_MSGS} msgs, top ${MAX_CONVS})`);

  const indexEntries = [];
  let embedded = 0, reused = 0;
  for (const conv of convs) {
    const episodes = toEpisodes(conv);
    if (episodes.length === 0) continue;
    const file = `${safeName(conv.guid)}.json`;
    const path = join(OUT, file);

    // Reuse embeddings for episodes whose content hasn't changed — the whole
    // point of batch indexing is that re-runs only pay for what's new.
    const prior = existsSync(path)
      ? new Map(
          JSON.parse(readFileSync(path, "utf8")).episodes.map((e) => [`${e.at}:${e.h}`, e.v])
        )
      : new Map();

    const out = [];
    const toEmbed = [];
    for (const ep of episodes) {
      const h = hashText(ep.text);
      const v = prior.get(`${ep.at}:${h}`);
      if (v) {
        out.push({ ...ep, h, v });
        reused++;
      } else {
        toEmbed.push({ ...ep, h });
      }
    }
    for (let i = 0; i < toEmbed.length; i += 16) {
      const batch = toEmbed.slice(i, i + 16);
      const vecs = await embed(batch.map((e) => e.text));
      batch.forEach((ep, j) => out.push({ ...ep, v: packVector(vecs[j]) }));
      embedded += batch.length;
    }
    out.sort((a, b) => a.at - b.at);

    writeFileSync(
      path,
      JSON.stringify({ model: MODEL, guid: conv.guid, name: conv.name, updatedAt: Date.now(), episodes: out })
    );
    // Every underlying guid maps to the file, so the app finds the index from
    // whichever thread guid it holds (merged iMessage/SMS threads).
    indexEntries.push({ guid: conv.guid, guids: conv.guids, name: conv.name, file, episodes: out.length });
    log(`  ${conv.name}: ${out.length} episoder → ${file}`);
  }

  writeFileSync(
    join(OUT, "index.json"),
    JSON.stringify({ model: MODEL, updatedAt: Date.now(), conversations: indexEntries }, null, 2)
  );
  log(`done — ${embedded} embedded, ${reused} reused, ${indexEntries.length} conversations`);
}

await main();
