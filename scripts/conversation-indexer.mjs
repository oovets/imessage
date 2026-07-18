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

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { collectIMessage, collectTelegram, collectSlack } from "./lib/collect.mjs";

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

// Collection lives in lib/collect.mjs — shared with social-graph.mjs so the
// credential lookups, thread merging and Slack mrkdwn handling exist once.

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
    ...(await collectIMessage({ server: SERVER, password: arg("password", null), log })),
    ...collectTelegram(),
    ...(await collectSlack({ log })),
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

  // MERGE with the existing index, never replace it. A partial run
  // (--max-conversations, --min-messages, a crash) would otherwise silently
  // shrink the index to whatever this run happened to touch, and every
  // consumer — retrieval, state, the social graph — would quietly lose
  // conversations whose embedding files are still sitting right there.
  const priorIndex = existsSync(join(OUT, "index.json"))
    ? (JSON.parse(readFileSync(join(OUT, "index.json"), "utf8")).conversations ?? [])
    : [];
  const merged = new Map(priorIndex.map((c) => [c.guid, c]));
  for (const entry of indexEntries) merged.set(entry.guid, entry);
  // Drop entries whose data file has since been removed.
  const conversations = [...merged.values()].filter((c) => existsSync(join(OUT, c.file)));

  writeFileSync(
    join(OUT, "index.json"),
    JSON.stringify({ model: MODEL, updatedAt: Date.now(), conversations }, null, 2)
  );
  log(`done — ${embedded} embedded, ${reused} reused, ${indexEntries.length} this run, ${conversations.length} indexed`);
}

await main();
