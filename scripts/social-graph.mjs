#!/usr/bin/env node
// social-graph.mjs — how I communicate, per relationship.
//
// The style distiller measures how I WRITE (sent messages only). This measures
// the RELATIONSHIP: both sides, so it can answer things one side cannot —
// who starts conversations, whether the exchange is balanced, how fast each of
// us answers, what hours we live in together.
//
// Clusters (Family / Work / Gym / …) come from the embedding index built by
// conversation-indexer.mjs: a conversation's centroid is the mean of its
// episode vectors, k-means groups them, and the LLM only NAMES the groups it
// is given. Asking the model to sort 40 names into buckets would invent
// structure; this way the grouping is measured and only the label is guessed.
//
// Output: ai/graph.json — the app reads it directly.
//
// Usage:
//   node scripts/social-graph.mjs [--server …] [--ollama …] [--model gemma3:12b]
//     [--clusters 6] [--min-messages 40] [--no-labels]

import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { collectAll } from "./lib/collect.mjs";

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 ? process.argv[i + 1] : d;
};
const has = (n) => process.argv.includes(`--${n}`);

const SERVER = (arg("server", "http://localhost:1234")).replace(/\/$/, "");
const OLLAMA = (arg("ollama", "http://gpulab:11434")).replace(/\/$/, "");
const MODEL = arg("model", "gemma3:12b");
const K = parseInt(arg("clusters", "6"), 10);
const MIN_MSGS = parseInt(arg("min-messages", "40"), 10);
const AI = join(homedir(), "Library/Application Support/com.oovets.messages/ai");
const EMB = join(AI, "embeddings");

const log = (m) => console.log(`[graph] ${m}`);
const readJson = (p, f = null) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return f; } };

// ---------------------------------------------------------------- metrics

const EMOJI_RE = /\p{Extended_Pictographic}/gu;
/** Reply gap beyond this isn't a reply — it's a new conversation. */
const REPLY_WINDOW_MS = 6 * 3600_000;
/** Silence longer than this makes the next message an opening move. */
const INITIATIVE_GAP_MS = 8 * 3600_000;

// Function words are the cheapest reliable language signal in short chat text:
// content words borrow across languages ("deploy", "padel"), these don't.
const SV_WORDS = /\b(och|att|jag|det|är|som|för|inte|med|har|men|vi|du|på|den|de|ska|kan|så|nu|här|då|bara|också|när|va|vad|hur|ju|väl|lite|typ|fan|asså|tack|hej)\b/gi;
const EN_WORDS = /\b(the|and|is|are|you|that|this|with|have|for|not|but|we|they|it|was|will|can|just|now|here|then|only|also|when|what|how|about|thanks|hey)\b/gi;

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function languageMix(texts) {
  let sv = 0, en = 0;
  for (const t of texts) {
    sv += (t.match(SV_WORDS) ?? []).length;
    en += (t.match(EN_WORDS) ?? []).length;
  }
  const total = sv + en;
  if (total < 10) return null; // too little signal to claim anything
  return { sv: +(sv / total).toFixed(2), en: +(en / total).toFixed(2) };
}

/** Median time from one side's message to the other side's next reply. */
function responseTimes(messages) {
  const mine = [], theirs = [];
  for (let i = 1; i < messages.length; i++) {
    const prev = messages[i - 1];
    const cur = messages[i];
    if (prev.fromMe === cur.fromMe) continue; // same speaker continuing
    const gap = cur.at - prev.at;
    if (gap <= 0 || gap > REPLY_WINDOW_MS) continue;
    (cur.fromMe ? mine : theirs).push(gap);
  }
  return {
    mineSec: mine.length >= 5 ? Math.round(median(mine) / 1000) : null,
    theirsSec: theirs.length >= 5 ? Math.round(median(theirs) / 1000) : null,
  };
}

/** Who breaks a silence — the clearest signal of who carries a relationship. */
function initiative(messages) {
  let mine = 0, theirs = 0;
  for (let i = 0; i < messages.length; i++) {
    const isOpening = i === 0 || messages[i].at - messages[i - 1].at > INITIATIVE_GAP_MS;
    if (!isOpening) continue;
    if (messages[i].fromMe) mine++; else theirs++;
  }
  const total = mine + theirs;
  return total === 0 ? null : { openings: total, mineShare: +(mine / total).toFixed(2) };
}

function hourHistogram(messages) {
  const hours = new Array(24).fill(0);
  for (const m of messages) hours[new Date(m.at).getHours()]++;
  const total = messages.length || 1;
  return hours.map((h) => +(h / total).toFixed(3));
}

function metricsFor(conv) {
  const mine = conv.messages.filter((m) => m.fromMe);
  const theirs = conv.messages.filter((m) => !m.fromMe);
  if (mine.length === 0 || theirs.length === 0) return null;

  const emojiRate = (msgs) =>
    +(msgs.reduce((s, m) => s + (m.text.match(EMOJI_RE) ?? []).length, 0) / msgs.length).toFixed(2);
  const words = (msgs) => median(msgs.map((m) => m.text.split(/\s+/).length));

  const first = conv.messages[0].at;
  const last = conv.messages[conv.messages.length - 1].at;
  return {
    guid: conv.guid,
    guids: conv.guids,
    name: conv.name,
    source: conv.source,
    messages: conv.messages.length,
    firstAt: first,
    lastAt: last,
    // Balance as a share of MY messages: 0.5 is even, >0.5 means I talk more.
    balance: +(mine.length / conv.messages.length).toFixed(2),
    response: responseTimes(conv.messages),
    emoji: { mine: emojiRate(mine), theirs: emojiRate(theirs) },
    medianWords: { mine: words(mine), theirs: words(theirs) },
    language: languageMix(conv.messages.map((m) => m.text)),
    initiative: initiative(conv.messages),
    hours: hourHistogram(conv.messages),
  };
}

// ---------------------------------------------------------------- clustering

function centroidFor(entry) {
  const data = readJson(join(EMB, entry.file));
  if (!data?.episodes?.length) return null;
  const unpack = (b64) => {
    const buf = Buffer.from(b64, "base64");
    return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  };
  const first = unpack(data.episodes[0].v);
  const sum = new Float64Array(first.length);
  for (const ep of data.episodes) {
    const v = unpack(ep.v);
    for (let i = 0; i < v.length; i++) sum[i] += v[i];
  }
  // Normalise: k-means on unit vectors makes euclidean distance track cosine.
  let norm = 0;
  for (let i = 0; i < sum.length; i++) norm += sum[i] * sum[i];
  norm = Math.sqrt(norm) || 1;
  return Float32Array.from(sum, (x) => x / norm);
}

function kmeans(vectors, k, iterations = 40) {
  if (vectors.length <= k) return vectors.map((_, i) => i);
  const dim = vectors[0].length;
  // k-means++ seeding: random seeds routinely collapse two clusters into one.
  const centroids = [vectors[0]];
  while (centroids.length < k) {
    let best = null, bestDist = -1;
    for (const v of vectors) {
      const d = Math.min(...centroids.map((c) => dist2(v, c)));
      if (d > bestDist) { bestDist = d; best = v; }
    }
    centroids.push(best);
  }
  let assign = new Array(vectors.length).fill(0);
  for (let it = 0; it < iterations; it++) {
    let moved = false;
    vectors.forEach((v, i) => {
      let bi = 0, bd = Infinity;
      centroids.forEach((c, ci) => {
        const d = dist2(v, c);
        if (d < bd) { bd = d; bi = ci; }
      });
      if (assign[i] !== bi) { assign[i] = bi; moved = true; }
    });
    if (!moved && it > 0) break;
    for (let ci = 0; ci < k; ci++) {
      const members = vectors.filter((_, i) => assign[i] === ci);
      if (members.length === 0) continue;
      const sum = new Float64Array(dim);
      for (const v of members) for (let i = 0; i < dim; i++) sum[i] += v[i];
      centroids[ci] = Float32Array.from(sum, (x) => x / members.length);
    }
  }
  return assign;
}

/** Reassign members of clusters smaller than `min` to the nearest larger one. */
function mergeSingletons(vectors, assign, min) {
  const sizes = new Map();
  for (const a of assign) sizes.set(a, (sizes.get(a) ?? 0) + 1);
  const keep = [...sizes.entries()].filter(([, n]) => n >= min).map(([c]) => c);
  if (keep.length === 0) return assign;
  const centroid = (c) => {
    const members = vectors.filter((_, i) => assign[i] === c);
    const sum = new Float64Array(vectors[0].length);
    for (const v of members) for (let i = 0; i < v.length; i++) sum[i] += v[i];
    return Float32Array.from(sum, (x) => x / members.length);
  };
  const centroids = new Map(keep.map((c) => [c, centroid(c)]));
  return assign.map((a, i) => {
    if (sizes.get(a) >= min) return a;
    let best = keep[0], bd = Infinity;
    for (const c of keep) {
      const d = dist2(vectors[i], centroids.get(c));
      if (d < bd) { bd = d; best = c; }
    }
    return best;
  });
}

function dist2(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; }
  return s;
}

async function labelClusters(clusters) {
  const describe = clusters
    .map((c, i) => `Group ${i + 1}: ${c.members.map((m) => m.name).join(", ")}\n  topics: ${c.topics.slice(0, 8).join(", ")}`)
    .join("\n");
  const res = await fetch(`${OLLAMA}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      stream: false,
      options: { num_ctx: 8192, temperature: 0.1, num_predict: 400 },
      messages: [
        {
          role: "system",
          content:
            "Name each group of a person's conversations with a short label (1-2 words) like " +
            "Family, Work, Close friends, Gym, Kids' school, Neighbours. Use the members and " +
            "topics given — do NOT regroup them, only name the groups you are given. " +
            'Answer with ONLY minified JSON: {"labels":["…","…"]} in group order.',
        },
        { role: "user", content: describe },
      ],
    }),
  });
  const json = await res.json();
  const m = (json?.message?.content ?? "").match(/\{[\s\S]*\}/);
  return m ? (JSON.parse(m[0]).labels ?? []) : [];
}

// ---------------------------------------------------------------- main

async function main() {
  log("collecting conversations…");
  const convs = (await collectAll({ server: SERVER, log: (m) => log(m) }))
    .filter((c) => c.messages.length >= MIN_MSGS);
  log(`${convs.length} conversations with ${MIN_MSGS}+ messages`);

  const nodes = convs.map(metricsFor).filter(Boolean);
  nodes.sort((a, b) => b.messages - a.messages);

  // Cluster only what the indexer has embedded; the rest stay unclustered
  // rather than being forced into a group they were never compared against.
  const index = readJson(join(EMB, "index.json"));
  let clusters = [];
  if (index) {
    const state = readJson(join(AI, "state/index.json"));
    const withVec = [];
    for (const node of nodes) {
      const entry = index.conversations.find(
        (c) => c.guid === node.guid || (c.guids ?? []).includes(node.guid)
      );
      if (!entry) continue;
      const v = centroidFor(entry);
      if (v) withVec.push({ node, v, file: entry.file });
    }
    log(`${withVec.length} conversations have embeddings to cluster`);

    if (withVec.length >= K) {
      let assign = kmeans(withVec.map((w) => w.v), K);
      // Fold singletons into their nearest real cluster. k-means gives every
      // outlier its own group, and a "group" of one person is an artifact of
      // the k we picked, not a social circle.
      assign = mergeSingletons(withVec.map((w) => w.v), assign, 2);
      const grouped = new Map();
      withVec.forEach((w, i) => {
        const g = grouped.get(assign[i]) ?? { members: [], topics: [] };
        g.members.push(w.node);
        // Topics come from the state extractor when it has run — real threads
        // beat guessing from names.
        const st = state && readJson(join(AI, "state", w.file));
        for (const t of st?.state?.threads ?? []) g.topics.push(t);
        grouped.set(assign[i], g);
      });
      clusters = [...grouped.values()].sort((a, b) => b.members.length - a.members.length);

      if (!has("no-labels")) {
        try {
          const labels = await labelClusters(clusters);
          clusters.forEach((c, i) => { c.label = labels[i] ?? `Group ${i + 1}`; });
        } catch (e) {
          log(`! labelling failed: ${e.message}`);
        }
      }
      clusters.forEach((c, i) => {
        c.label ??= `Group ${i + 1}`;
        log(`  ${c.label}: ${c.members.map((m) => m.name).join(", ")}`);
      });
    }
  }

  const clusterOf = new Map();
  clusters.forEach((c, i) => c.members.forEach((m) => clusterOf.set(m.guid, i)));

  mkdirSync(AI, { recursive: true });
  writeFileSync(
    join(AI, "graph.json"),
    JSON.stringify({
      generatedAt: Date.now(),
      clusters: clusters.map((c) => ({ label: c.label, size: c.members.length })),
      nodes: nodes.map((n) => ({ ...n, cluster: clusterOf.get(n.guid) ?? null })),
    })
  );
  log(`done — ${nodes.length} relationships, ${clusters.length} clusters → ai/graph.json`);
}

await main();
