#!/usr/bin/env node
// style-distiller.mjs — offline Style Distiller (AI Personality Engine §2/§3/§11).
//
// Reads every message YOU have sent — iMessage via the local BlueBubbles API,
// Telegram via the app's local SQLite — computes hard statistical writing
// traits, selects representative few-shot examples per contact, and has a
// local LLM distill compact qualitative style cards. Output:
//
//   <out>/style_profile.json            global stats + style card
//   <out>/relationships/<guid>.json     per-contact stats, card and examples
//   <out>/index.json                    listing for the app to load
//
// Runs in batch (nightly or on demand) — never in realtime (§8). Everything
// stays on your machines: BlueBubbles on localhost, the LLM on your GPU box.
//
// Usage:
//   node scripts/style-distiller.mjs [--server http://localhost:1234]
//     [--ollama http://gpulab:11434] [--model gemma3:12b]
//     [--out "~/Library/Application Support/com.oovets.messages/ai"]
//     [--max-contacts 25] [--min-sent 30] [--skip-llm]

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------- args
const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : def;
};
const has = (name) => process.argv.includes(`--${name}`);

const SERVER = (arg("server", "http://localhost:1234")).replace(/\/$/, "");
const OLLAMA = (arg("ollama", "http://gpulab:11434")).replace(/\/$/, "");
const MODEL = arg("model", "gemma3:12b");
const OUT = arg("out", join(homedir(), "Library/Application Support/com.oovets.messages/ai"));
const MAX_CONTACTS = parseInt(arg("max-contacts", "25"), 10);
const MIN_SENT = parseInt(arg("min-sent", "30"), 10);
const SKIP_LLM = has("skip-llm");
const TG_DB = join(homedir(), "Library/Application Support/dev.stefan.TelegramGui/telegram_gui.db");

const log = (msg) => console.log(`[distiller] ${msg}`);

/** Previously written profile, if any — used to preserve cards on stat-only runs. */
function readExisting(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- credentials
/**
 * The server password, tried in order: --password, the app's keychain entry,
 * then the BlueBubbles server's own config database. The keychain is the
 * natural source but is denied to non-interactive processes, so scheduled
 * runs (§19) rely on the last one.
 */
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
  } catch {
    /* locked or denied — fall through */
  }

  try {
    const db = join(
      homedir(),
      "Library/Application Support/bluebubbles-server/config.db"
    );
    const pw = execFileSync(
      "sqlite3",
      ["-readonly", db, "SELECT value FROM config WHERE name='password';"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    ).trim();
    if (pw) return pw;
  } catch {
    /* no local server */
  }

  throw new Error(
    "Could not determine the BlueBubbles password — pass --password, or run where the server lives."
  );
}

// ---------------------------------------------------------------- collection
async function bbFetch(path, opts) {
  const res = await fetch(`${SERVER}${path}`, opts);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

/** address -> contact display name, from the server's Contacts database. */
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

/** All 1-on-1 conversations, split iMessage/SMS threads merged per address. */
async function bbConversations(pw) {
  const names = await bbContactNames(pw);
  const json = await bbFetch(`/api/v1/chat/query?password=${pw}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ limit: 1000 }),
  });
  const chats = json?.data ?? [];
  const byAddress = new Map();
  for (const c of chats) {
    const m = /^(any|iMessage|SMS|RCS);-;(.+)$/.exec(c.guid ?? "");
    if (!m) continue;
    const entry = byAddress.get(m[2]) ?? { address: m[2], guids: [], name: null };
    entry.guids.push(c.guid);
    const p = (c.participants ?? [])[0];
    entry.name ||= c.displayName || (p && [p.firstName, p.lastName].filter(Boolean).join(" ")) || null;
    byAddress.set(m[2], entry);
  }
  return [...byAddress.values()].map((e) => {
    const key = e.address.includes("@")
      ? e.address.toLowerCase()
      : e.address.replace(/\D/g, "").slice(-9);
    return {
      guid: e.guids.find((g) => g.startsWith("iMessage;") || g.startsWith("any;")) ?? e.guids[0],
      guids: e.guids,
      name: e.name ?? names.get(key) ?? e.address,
    };
  });
}

/** Sent + incoming messages for one conversation (all underlying threads). */
async function bbMessages(pw, conv, capPerThread = 3000) {
  const sent = [];
  const incomingTimes = [];
  for (const guid of conv.guids) {
    for (let offset = 0; offset < capPerThread; offset += 1000) {
      const json = await bbFetch(
        `/api/v1/chat/${encodeURIComponent(guid)}/message?password=${pw}&limit=1000&offset=${offset}`
      );
      const msgs = json?.data ?? [];
      for (const m of msgs) {
        // Tapbacks are stored as text ("Laughed at …") — not real writing.
        if (m.associatedMessageGuid) continue;
        const t = (m.text ?? "").trim();
        if (m.isFromMe && t) sent.push({ text: t, at: m.dateCreated ?? 0 });
        if (!m.isFromMe) incomingTimes.push(m.dateCreated ?? 0);
      }
      if (msgs.length < 1000) break;
    }
  }
  sent.sort((a, b) => a.at - b.at);
  return { sent, incomingTimes: incomingTimes.sort((a, b) => a - b) };
}

/** Telegram: sent messages per chat from the app's local SQLite. */
function tgConversations() {
  if (!existsSync(TG_DB)) return [];
  const q = (sql) => {
    try {
      const out = execFileSync("sqlite3", ["-json", "-readonly", TG_DB, sql], { encoding: "utf8" }).trim();
      return out ? JSON.parse(out) : [];
    } catch {
      return [];
    }
  };
  // Chat title column name varies; detect it.
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
      sent: [], incomingTimes: [],
    };
    const at = Date.parse(r.date) || 0;
    if (r.outgoing) entry.sent.push({ text: r.text.trim(), at });
    else entry.incomingTimes.push(at);
    byChat.set(key, entry);
  }
  return [...byChat.values()];
}

// ---------------------------------------------------------------- slack
//
// Slack is a third corpus of the user's own writing, and a distinctly
// different register from iMessage and Telegram — which is exactly why it is
// worth having: the relationship profiles get sharper when the same person is
// seen writing to colleagues as well as to friends.

/**
 * Workspace tokens, from the app's keychain blob or the legacy TUI config.
 * The blob stores `name<TAB>base64` lines under one entry.
 */
function slackWorkspaces() {
  const fromBlob = () => {
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
    return null;
  };
  const fromFile = () => {
    const path = join(homedir(), ".slack_config.json");
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8")).workspaces;
  };

  for (const source of [fromBlob, fromFile]) {
    try {
      const ws = source();
      if (Array.isArray(ws) && ws.length > 0) return ws;
    } catch {
      /* try the next source */
    }
  }
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

/** Conversations from every workspace, with the user's own messages. */
/**
 * Slack user id -> display name for a whole workspace, in one paged call.
 *
 * Without it, DMs are named after the raw id ("Slack DM (U08846VMHT5)") and
 * that id ends up in the prompt as "HOW I WRITE TO …", which teaches the model
 * nothing. Prefers the @nickname, then the real name, then the handle.
 */
async function slackUserMap(token) {
  const names = {};
  let cursor;
  do {
    const res = await slackApi(token, "users.list", { limit: 200, ...(cursor ? { cursor } : {}) });
    for (const u of res.members ?? []) {
      names[u.id] =
        u.profile?.display_name?.trim() || u.real_name?.trim() || u.name || u.id;
    }
    cursor = res.response_metadata?.next_cursor || "";
  } while (cursor);
  return names;
}

/**
 * Strip Slack's mrkdwn entities so the corpus holds what a human would read.
 * Mirrors src/slack/mrkdwn.ts — duplicated because this script is plain Node
 * and cannot import the app's TypeScript.
 */
function stripSlackMrkdwn(text, userNames = {}) {
  return text
    .replace(/<@([UVW][A-Z0-9]+)(?:\|([^>]*))?>/g, (_m, id, label) => `@${label || userNames[id] || id}`)
    .replace(/<#(C[A-Z0-9]+)(?:\|([^>]*))?>/g, (_m, id, name) => `#${name || id}`)
    .replace(/<!([^>|]+)(?:\|([^>]*))?>/g, (_m, kind, label) => `@${label || kind.split("^")[0]}`)
    .replace(/<((?:https?|mailto):[^>|]+)(?:\|([^>]*))?>/g, (_m, url, label) => label || url)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** "mpdm-pelle--dev--stefan-1" is Slack's internal id for a group DM. */
function prettyGroupDmName(raw) {
  const m = /^mpdm-(.+?)-\d+$/.exec(raw);
  if (!m) return `#${raw}`;
  return m[1].split("--").join(", ");
}

async function slackConversations(perChannel = 400) {
  const workspaces = slackWorkspaces();
  if (workspaces.length === 0) return [];
  const out = [];

  for (const ws of workspaces) {
    const token = ws.token;
    if (!token) continue;
    let me;
    try {
      me = (await slackApi(token, "auth.test")).user_id;
    } catch (e) {
      log(`  ! slack ${ws.name}: ${e.message}`);
      continue;
    }

    const userNames = await slackUserMap(token).catch((e) => {
      log(`  ! slack ${ws.name} users: ${e.message}`);
      return {};
    });

    let channels;
    try {
      const res = await slackApi(token, "users.conversations", {
        types: "public_channel,private_channel,im,mpim",
        exclude_archived: true,
        limit: 200,
      });
      channels = res.channels ?? [];
    } catch (e) {
      log(`  ! slack ${ws.name} conversations: ${e.message}`);
      continue;
    }

    for (const ch of channels) {
      try {
        const res = await slackApi(token, "conversations.history", {
          channel: ch.id,
          limit: perChannel,
        });
        const sent = [];
        const incomingTimes = [];
        for (const m of res.messages ?? []) {
          // Joins, leaves and other channel chatter aren't writing.
          if (m.subtype && m.subtype !== "thread_broadcast") continue;
          const text = stripSlackMrkdwn((m.text ?? "").trim(), userNames);
          const at = Math.round(Number.parseFloat(m.ts) * 1000);
          if (m.user === me) {
            if (text) sent.push({ text, at });
          } else {
            incomingTimes.push(at);
          }
        }
        if (sent.length === 0) continue;
        const name = ch.is_im
          ? (userNames[ch.user] ?? ch.user ?? ch.id)
          : ch.is_mpim
            ? prettyGroupDmName(ch.name ?? ch.id)
            : `#${ch.name ?? ch.id}`;
        out.push({
          guid: `sl:${ws.name}:${ch.id}`,
          guids: [`sl:${ws.name}:${ch.id}`],
          name: `${name} · ${ws.name}`,
          sent: sent.sort((a, b) => a.at - b.at),
          incomingTimes: incomingTimes.sort((a, b) => a - b),
        });
      } catch {
        // not_in_channel and friends are expected; skip quietly
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- stats
const EMOJI_RE = /\p{Extended_Pictographic}/gu;
const LAUGH_EMOJI_RE = /[\u{1F602}\u{1F923}\u{1F606}\u{1F605}\u{1F604}\u{1F603}]/u;
// How this person laughs in writing. Models default to a laughing emoji; many
// people type it instead, and which one wins is measurable.
const LAUGH_TEXT_RE = /\b(ha){2,}\b|\blol\b|\bhehe\b|\basg\b|\blmao\b/i;
const URL_RE = /https?:\/\/\S+/;

function median(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function computeStats(sent, incomingTimes) {
  const texts = sent.map((m) => m.text);
  const n = texts.length;
  if (n === 0) return null;
  const words = texts.map((t) => t.split(/\s+/).length);
  const emojiPerMsg = texts.map((t) => (t.match(EMOJI_RE) ?? []).length);
  const emojiCounts = new Map();
  for (const t of texts) for (const e of t.match(EMOJI_RE) ?? []) emojiCounts.set(e, (emojiCounts.get(e) ?? 0) + 1);

  // Favorite expressions: 2–3-word n-grams, lowercased, seen ≥ max(5, n/200).
  const ngramCounts = new Map();
  for (const t of texts) {
    const w = t.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").split(/\s+/).filter(Boolean);
    for (const len of [2, 3]) {
      for (let i = 0; i + len <= w.length; i++) {
        const g = w.slice(i, i + len).join(" ");
        if (g.length >= 5) ngramCounts.set(g, (ngramCounts.get(g) ?? 0) + 1);
      }
    }
  }
  const ngramMin = Math.max(5, Math.round(n / 200));
  const favoriteExpressions = [...ngramCounts.entries()]
    .filter(([, c]) => c >= ngramMin)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 25)
    .map(([g, c]) => ({ phrase: g, count: c }));

  // Reply latency: for each incoming message, time to the next sent message.
  const latencies = [];
  let si = 0;
  for (const it of incomingTimes) {
    while (si < sent.length && sent[si].at <= it) si++;
    if (si < sent.length) {
      const d = sent[si].at - it;
      if (d > 0 && d < 6 * 3600_000) latencies.push(d);
    }
  }

  // Where emoji land, and whether laughter is typed or drawn.
  const endsWithEmoji = texts.filter((t) => {
    const tail = t.trim().slice(-2);
    return tail && EMOJI_RE.test(tail);
  }).length;
  const laughEmoji = texts.filter((t) => LAUGH_EMOJI_RE.test(t)).length;
  const laughText = texts.filter((t) => LAUGH_TEXT_RE.test(t)).length;

  const uniq = new Set(texts.flatMap((t) => t.toLowerCase().split(/\s+/))).size;
  return {
    sentCount: n,
    avgWords: +(words.reduce((a, b) => a + b, 0) / n).toFixed(1),
    medianWords: median(words),
    exclamationRate: +(texts.filter((t) => t.includes("!")).length / n).toFixed(3),
    questionRate: +(texts.filter((t) => t.includes("?")).length / n).toFixed(3),
    ellipsisRate: +(texts.filter((t) => /\.\.\.|…/.test(t)).length / n).toFixed(3),
    terminalPeriodRate: +(texts.filter((t) => /[a-zåäö]\.$/i.test(t)).length / n).toFixed(3),
    lowercaseStartRate: +(texts.filter((t) => /^[a-zåäö]/.test(t)).length / n).toFixed(3),
    emojiPerMessage: +(emojiPerMsg.reduce((a, b) => a + b, 0) / n).toFixed(2),
    topEmoji: [...emojiCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([e]) => e),
    emojiAtEndRate: +(endsWithEmoji / n).toFixed(3),
    laughEmojiRate: +(laughEmoji / n).toFixed(3),
    laughTextRate: +(laughText / n).toFixed(3),
    favoriteExpressions,
    vocabularyUniqueWords: uniq,
    medianReplyLatencySec: Math.round(median(latencies) / 1000),
  };
}

/** 3–20 representative examples: varied length, spread over time, no URLs. */
function pickExamples(sent, max = 20) {
  const ok = sent.filter((m) => !URL_RE.test(m.text) && m.text.length >= 8 && m.text.length <= 240);
  if (ok.length <= max) return ok.map((m) => m.text);
  const step = ok.length / max;
  const out = [];
  for (let i = 0; i < max; i++) out.push(ok[Math.floor(i * step)].text);
  return [...new Set(out)];
}

// ---------------------------------------------------------------- LLM distill
async function distill(samples, kind, name) {
  const prompt = kind === "global"
    ? `Below are ${samples.length} text messages written by one person, in their own words. Distill their WRITING STYLE (not the topics).`
    : `Below are ${samples.length} messages one person sent to their contact "${name}". Distill how this person writes TO THIS CONTACT specifically.`;
  const res = await fetch(`${OLLAMA}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 600,
      messages: [
        {
          role: "system",
          content:
            "You are a writing-style analyst. Answer with ONLY minified JSON, no markdown, matching: " +
            '{"summary":string,"humor":string,"sarcasm_0_10":number,"warmth_0_10":number,' +
            '"directness_0_10":number,"formality_0_10":number,"energy":string,' +
            '"signature_phrases":string[],"emoji_style":string,"language_notes":string,' +
            '"do":string[],"dont":string[]}. Describe style only — never quote facts, names or events from the messages. ' +
            'signature_phrases must be general expressions only — NEVER nicknames, pet names or terms of address ' +
            '(those are relationship-specific and belong only in a relationship profile, and only when analyzing that relationship).',
        },
        { role: "user", content: `${prompt}\n\n${samples.map((s) => `- ${s}`).join("\n")}` },
      ],
    }),
  });
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
  const json = await res.json();
  const raw = json?.choices?.[0]?.message?.content ?? "";
  const match = raw.match(/\{[\s\S]*\}/);
  return match ? JSON.parse(match[0]) : null;
}

/** distill with one retry — local models occasionally emit broken JSON. */
async function distillWithRetry(samples, kind, name) {
  try {
    return await distill(samples, kind, name);
  } catch {
    return distill(samples, kind, name);
  }
}

// ---------------------------------------------------------------- main
const t0 = Date.now();
const pw = bbPassword();
log(`output: ${OUT}`);
mkdirSync(join(OUT, "relationships"), { recursive: true });

log("collecting iMessage conversations…");
const convs = await bbConversations(pw);
log(`  ${convs.length} 1-on-1 iMessage/SMS conversations`);

const collected = [];
for (const conv of convs) {
  const { sent, incomingTimes } = await bbMessages(pw, conv);
  if (sent.length > 0) collected.push({ ...conv, sent, incomingTimes });
}
log(`  ${collected.length} with sent messages`);

log("collecting Slack conversations…");
const slConvs = (await slackConversations().catch((e) => {
  log(`  ! slack: ${e.message}`);
  return [];
})).filter((c) => c.sent.length > 0);
log(`  ${slConvs.length} with sent messages`);
collected.push(...slConvs);

log("collecting Telegram conversations…");
const tgConvs = tgConversations().filter((c) => c.sent.length > 0);
log(`  ${tgConvs.length} with sent messages`);
collected.push(...tgConvs);

const allSent = collected.flatMap((c) => c.sent).sort((a, b) => a.at - b.at);
log(`corpus: ${allSent.length} sent messages total`);

// -------- global profile
const globalStats = computeStats(allSent, []);
// --skip-llm refreshes statistics only; keep any card already distilled rather
// than overwriting it with null (that silently guts existing profiles).
const prevGlobal = readExisting(join(OUT, "style_profile.json"));
let globalCard = prevGlobal?.card ?? null;
if (!SKIP_LLM) {
  log("distilling global style card…");
  const sample = pickExamples(allSent, 150);
  globalCard = await distillWithRetry(sample, "global").catch((e) => (log(`  ! ${e.message}`), null));
}
writeFileSync(
  join(OUT, "style_profile.json"),
  JSON.stringify(
    {
      version: 1,
      generatedAt: new Date().toISOString(),
      corpus: { conversations: collected.length, sentMessages: allSent.length },
      stats: globalStats,
      card: globalCard,
    },
    null, 2
  )
);
log("wrote style_profile.json");

// -------- relationship profiles (top contacts by sent volume)
const top = collected
  .filter((c) => c.sent.length >= MIN_SENT)
  .sort((a, b) => b.sent.length - a.sent.length)
  .slice(0, MAX_CONTACTS);
log(`building ${top.length} relationship profiles (min ${MIN_SENT} sent)…`);

const index = [];
for (const conv of top) {
  const stats = computeStats(conv.sent, conv.incomingTimes);
  const examples = pickExamples(conv.sent, 20);
  const safe = conv.guid.replace(/[^A-Za-z0-9+@.-]/g, "_");
  const prevRel = readExisting(join(OUT, `relationships/${safe}.json`));
  let card = prevRel?.card ?? null;
  if (!SKIP_LLM) {
    card = await distillWithRetry(pickExamples(conv.sent, 60), "relationship", conv.name).catch(
      (e) => (log(`  ! ${conv.name}: ${e.message}`), null)
    );
  }
  const file = `relationships/${safe}.json`;
  writeFileSync(
    join(OUT, file),
    JSON.stringify(
      { version: 1, guid: conv.guid, guids: conv.guids, name: conv.name, stats, card, examples },
      null, 2
    )
  );
  index.push({ guid: conv.guid, guids: conv.guids, name: conv.name, file, sentCount: conv.sent.length });
  log(`  ${conv.name}: ${conv.sent.length} sent → ${file}`);
}

writeFileSync(join(OUT, "index.json"), JSON.stringify({ version: 1, relationships: index }, null, 2));
log(`done in ${Math.round((Date.now() - t0) / 1000)}s — ${index.length} relationships + global profile`);
