#!/usr/bin/env node
// personality-benchmark.mjs — treat personality like unit tests (§16).
//
// Replays a fixed set of conversations through the reply pipeline and has the
// model judge each answer against the distilled profile, so a prompt or model
// change can be measured instead of guessed at. Results append to a history
// file, and each run prints its delta against the previous one.
//
// Cases live in ai/benchmark/cases.json:
//   [{ "name": "...", "profile": "<relationship guid or null>",
//      "messages": [{ "fromMe": false, "text": "..." }, ...] }]
//
// If that file doesn't exist, --seed writes a starter set built from your own
// relationship profiles.
//
// Usage:
//   node scripts/personality-benchmark.mjs [--seed] [--model gemma3:12b]
//     [--ollama http://gpulab:11434] [--label "no-critique"] [--runs 1]

import { mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 ? process.argv[i + 1] : d;
};
const has = (n) => process.argv.includes(`--${n}`);

const AI = join(homedir(), "Library/Application Support/com.oovets.messages/ai");
const BENCH = join(AI, "benchmark");
const CASES = join(BENCH, "cases.json");
const HISTORY = join(BENCH, "runs.jsonl");
const OLLAMA = arg("ollama", "http://gpulab:11434").replace(/\/$/, "");
const MODEL = arg("model", "gemma3:12b");
const LABEL = arg("label", MODEL);
const RUNS = parseInt(arg("runs", "1"), 10);
const RETRIEVAL = has("retrieval");
const EMBED_MODEL = arg("embed-model", "bge-m3");
const EMB_DIR = join(AI, "embeddings");

const log = (m) => console.log(`[bench] ${m}`);

// ---------------------------------------------------------------- retrieval
// Mirrors src/lib/aiContext.ts + the host-side scorer, so a benchmark result
// reflects what the app actually feeds the model.
const unpackVec = (b64) => {
  const buf = Buffer.from(b64, "base64");
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
};
const cosine = (a, b) => {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
};

async function embedQuery(text) {
  const res = await fetch(`${OLLAMA}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, input: [text] }),
  });
  if (!res.ok) throw new Error(`embed: HTTP ${res.status}`);
  return (await res.json()).embeddings[0];
}

/** Top episodes for a query within one conversation (same cutoff as the app). */
async function retrieve(guid, query, k = 3) {
  const index = readJson(join(EMB_DIR, "index.json"));
  if (!index) return [];
  const entry = index.conversations.find(
    (c) => c.guid === guid || (c.guids ?? []).includes(guid)
  );
  if (!entry) return [];
  const data = readJson(join(EMB_DIR, entry.file));
  if (!data) return [];
  const qv = await embedQuery(query);
  const scored = data.episodes
    .map((ep) => ({ at: ep.at, text: ep.text, score: cosine(qv, unpackVec(ep.v)) }))
    .sort((a, b) => b.score - a.score);
  const top = scored[0]?.score ?? 0;
  return scored.filter((e) => e.score >= top - 0.08 && e.score >= 0.4).slice(0, k);
}
const readJson = (p, fallback = null) => {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
};

// ---------------------------------------------------------------- profiles
const style = readJson(join(AI, "style_profile.json"));
const index = readJson(join(AI, "index.json"), { relationships: [] });
if (!style) {
  console.error("No style profile — run scripts/style-distiller.mjs first.");
  process.exit(1);
}
const relFor = (guid) => {
  const entry = index.relationships.find((r) => r.guid === guid);
  return entry ? readJson(join(AI, entry.file)) : null;
};

// ---------------------------------------------------------------- seeding
if (has("seed") || !existsSync(CASES)) {
  mkdirSync(BENCH, { recursive: true });
  // Situations that stress different axes: a favour, bad news, banter, a
  // stranger pushing, and a plan being made.
  const prompts = [
    ["asks a favour", "hej! kan du hjälpa mig flytta på lördag? blir pizza efteråt"],
    ["bad news", "fick precis veta att pappa är inlagd igen. orkar inte riktigt"],
    ["banter", "haha du är helt jävla värdelös på padel, erkänn"],
    ["pushy stranger", "Hey, quick question — you ever made money online, not strictly legal?"],
    ["making plans", "ska vi ta en öl i veckan? tis eller ons funkar för mig"],
  ];
  const top = index.relationships.slice(0, 3);
  const cases = [];
  for (const [name, text] of prompts) {
    cases.push({ name, profile: top[0]?.guid ?? null, messages: [{ fromMe: false, text }] });
  }
  for (const r of top.slice(1)) {
    cases.push({
      name: `banter (${r.name})`,
      profile: r.guid,
      messages: [{ fromMe: false, text: "haha du är helt jävla värdelös på padel, erkänn" }],
    });
  }
  writeFileSync(CASES, JSON.stringify(cases, null, 2));
  log(`seeded ${cases.length} cases → ${CASES}`);
  if (has("seed")) process.exit(0);
}

// ---------------------------------------------------------------- memory cases
// The style cases can't measure retrieval: none of them reference anything
// from the past, so context has nothing to contribute. Memory probes are
// generated FROM real indexed episodes — a message whose answer requires
// knowing something said long ago — and stored separately so the two
// benchmarks stay honest about what they measure.
const MEMORY_CASES = join(BENCH, "memory-cases.json");

if (has("seed-memory")) {
  const index = readJson(join(EMB_DIR, "index.json"));
  if (!index) {
    console.error("No embedding index — run scripts/conversation-indexer.mjs first.");
    process.exit(1);
  }
  mkdirSync(BENCH, { recursive: true });
  const cases = [];
  const wanted = parseInt(arg("count", "8"), 10);
  // Biggest conversations first: most history, most to remember.
  const convs = [...index.conversations].sort((a, b) => b.episodes - a.episodes).slice(0, wanted);
  for (const conv of convs) {
    const data = readJson(join(EMB_DIR, conv.file));
    if (!data || data.episodes.length < 20) continue;
    // An episode from the older half — recent ones would sit in the visible
    // window anyway, which is exactly the case retrieval must beat.
    const pool = data.episodes.slice(0, Math.floor(data.episodes.length / 2));
    const ep = pool[Math.floor(pool.length / 2)];
    const raw = await chat([
      {
        role: "system",
        content:
          "You write realistic chat messages. Given an excerpt of an old conversation, write ONE " +
          "short message that person might send TODAY which can only be answered well by " +
          "remembering that excerpt (a follow-up, a callback, 'what did we say about…'). " +
          "Do not restate the details — the point is that the recipient must recall them. " +
          'Answer with ONLY minified JSON: {"message":"...","recalls":"<the fact needed, one line>"}',
      },
      { role: "user", content: ep.text.slice(0, 1200) },
    ], 200);
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) continue;
    try {
      const parsed = JSON.parse(m[0]);
      cases.push({
        name: `memory: ${conv.name}`.slice(0, 40),
        profile: conv.guid,
        recalls: parsed.recalls,
        messages: [{ fromMe: false, text: parsed.message }],
      });
      log(`  seeded ${conv.name}: "${parsed.message.slice(0, 60)}"`);
    } catch { /* skip malformed */ }
  }
  writeFileSync(MEMORY_CASES, JSON.stringify(cases, null, 2));
  log(`seeded ${cases.length} memory cases -> ${MEMORY_CASES}`);
  process.exit(0);
}

const cases = has("memory")
  ? readJson(MEMORY_CASES, [])
  : readJson(CASES, []);
if (cases.length === 0) {
  console.error(`No cases in ${has("memory") ? MEMORY_CASES : CASES} — seed first.`);
  process.exit(1);
}

// ---------------------------------------------------------------- prompt
// Mirrors src/lib/aiReply.ts closely enough to benchmark prompt changes; keep
// the two in step when the runtime prompt changes shape.
function buildPrompt(rel, retrieved = []) {
  const card = style.card ?? {};
  const st = style.stats ?? {};
  const sections = [
    "You are replying as me in a personal chat. Match my tone and language, keep replies short and natural, never mention being an AI.",
    "Hard rules: never copy any previous message verbatim; never invent facts, plans or commitments; never mention being an AI; never explain yourself; reply in the same language as the conversation; never use nicknames or terms of address unless they appear in THIS contact's examples; output ONLY the reply text.",
  ];
  const styleLines = [
    card.summary,
    card.humor && `Humor: ${card.humor}`,
    st.medianWords && `Typical message length: ~${st.medianWords} words.`,
    (st.lowercaseStartRate ?? 0) > 0.4 && "Often starts messages in lowercase.",
    (st.terminalPeriodRate ?? 1) < 0.1 && "Almost never ends messages with a period.",
  ].filter(Boolean);
  sections.push(`MY WRITING STYLE:\n- ${styleLines.join("\n- ")}`);
  if (rel?.card?.summary) sections.push(`HOW I WRITE TO ${rel.name}:\n- ${rel.card.summary}`);
  if (rel?.examples?.length) {
    sections.push(
      "EXAMPLES of messages I have sent this contact — style only, never copy facts:\n" +
        rel.examples.slice(0, 5).map((e) => `- ${e}`).join("\n")
    );
  }
  if (retrieved.length > 0) {
    sections.push(
      "RELEVANT PAST CONTEXT — dated excerpts from earlier in this conversation. " +
        "Use them for facts, plans and continuity; never quote or copy them:\n" +
        retrieved.map((e) => `---\n${e.text.slice(0, 700)}`).join("\n")
    );
  }
  return sections.join("\n\n");
}

async function chat(messages, maxTokens = 120) {
  const res = await fetch(`${OLLAMA}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, temperature: 1.0, messages }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  return (json?.choices?.[0]?.message?.content ?? "").trim();
}

/** LLM-as-a-judge: "would the user actually send this?" (§16). */
async function judge(system, incoming, reply) {
  const raw = await chat(
    [
      {
        role: "system",
        content:
          "Judge whether the drafted reply sounds like the person described below. " +
          'Answer with ONLY minified JSON: {"soundsLikeMe":0-10,"fitsRecipient":0-10,' +
          '"tooAiLike":0-10,"tooVerbose":0-10,"wouldSend":true|false}. ' +
          "tooAiLike and tooVerbose are problems — higher is worse. Be strict.\n\n" +
          system,
      },
      { role: "user", content: `They received: "${incoming}"\n\nDrafted reply: "${reply}"\n\nScore it.` },
    ],
    200
  );
  const m = raw.match(/\{[\s\S]*\}/);
  return m ? JSON.parse(m[0]) : null;
}

/**
 * Memory probe judge. The style judge answers "does this sound like them",
 * which retrieval can improve without the reply using any recalled fact —
 * so measuring retrieval needs its own question, asked without the reply's
 * style in view.
 */
async function judgeMemory(incoming, reply, recalls) {
  const raw = await chat([
    {
      role: "system",
      content:
        "A person was asked something that refers back to an earlier conversation. " +
        "Judge ONLY whether their reply shows they remember the specific fact below. " +
        "Short replies can still show recall; vague agreement ('ja visst', 'haha') does NOT. " +
        'Answer with ONLY minified JSON: {"showsRecall":0-10,"invented":true|false}. ' +
        "invented = the reply asserts details that contradict or go beyond the fact.",
    },
    {
      role: "user",
      content: `Fact they should remember: ${recalls}\n\nThey received: "${incoming}"\n\nTheir reply: "${reply}"\n\nScore it.`,
    },
  ], 150);
  const m = raw.match(/\{[\s\S]*\}/);
  return m ? JSON.parse(m[0]) : null;
}

// ---------------------------------------------------------------- run
const t0 = Date.now();
log(`${cases.length} cases × ${RUNS} run(s) — model ${MODEL}, label "${LABEL}"`);
const scores = [];

for (const c of cases) {
  const rel = c.profile ? relFor(c.profile) : null;
  const incoming0 = [...c.messages].reverse().find((m) => !m.fromMe)?.text ?? "";
  const retrieved =
    RETRIEVAL && c.profile ? await retrieve(c.profile, incoming0).catch(() => []) : [];
  const system = buildPrompt(rel, retrieved);
  const context = c.messages.map((m) => ({
    role: m.fromMe ? "assistant" : "user",
    content: m.text,
  }));
  const incoming = [...c.messages].reverse().find((m) => !m.fromMe)?.text ?? "";

  for (let i = 0; i < RUNS; i++) {
    try {
      const reply = await chat([{ role: "system", content: system }, ...context], 80);
      const s = await judge(system, incoming, reply);
      if (!s) continue;
      const mem = c.recalls ? await judgeMemory(incoming, reply, c.recalls) : null;
      scores.push({ case: c.name, reply, ...s, ...(mem ?? {}) });
      const verdict = s.wouldSend ? "✓" : "✗";
      const ctx = RETRIEVAL ? `ctx:${retrieved.length} ` : "";
      const recall = mem ? `recall:${mem.showsRecall}${mem.invented ? "!" : ""} ` : "";
      console.log(
        `  ${verdict} ${c.name.padEnd(22)} ${ctx}${recall}me:${s.soundsLikeMe} ` +
          `verb:${s.tooVerbose}  "${reply.slice(0, 40)}"`
      );
    } catch (e) {
      log(`  ! ${c.name}: ${e.message}`);
    }
  }
}

if (scores.length === 0) {
  console.error("No scores collected.");
  process.exit(1);
}

const avg = (f) => +(scores.reduce((s, x) => s + (f(x) ?? 0), 0) / scores.length).toFixed(2);
const result = {
  at: new Date().toISOString(),
  label: LABEL,
  model: MODEL,
  retrieval: RETRIEVAL,
  cases: cases.length,
  samples: scores.length,
  soundsLikeMe: avg((x) => x.soundsLikeMe),
  fitsRecipient: avg((x) => x.fitsRecipient),
  tooAiLike: avg((x) => x.tooAiLike),
  tooVerbose: avg((x) => x.tooVerbose),
  wouldSendRate: +(scores.filter((x) => x.wouldSend).length / scores.length).toFixed(2),
  ...(scores.some((x) => x.showsRecall !== undefined)
    ? {
        showsRecall: avg((x) => x.showsRecall),
        inventedRate: +(
          scores.filter((x) => x.invented).length / scores.length
        ).toFixed(2),
      }
    : {}),
  durationSec: Math.round((Date.now() - t0) / 1000),
};

// Compare against the previous run before recording this one.
const history = existsSync(HISTORY)
  ? readFileSync(HISTORY, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
  : [];
const prev = history[history.length - 1];

console.log("\n" + "─".repeat(58));
const fmt = (k, better = "up") => {
  const now = result[k];
  if (!prev) return `${k}: ${now}`;
  const d = +(now - prev[k]).toFixed(2);
  const good = better === "up" ? d > 0 : d < 0;
  const arrow = d === 0 ? "=" : good ? "▲" : "▼";
  return `${k}: ${now} (${arrow}${d >= 0 ? "+" : ""}${d} vs ${prev.label})`;
};
console.log(`[bench] ${LABEL} — ${result.samples} samples in ${result.durationSec}s`);
console.log("  " + fmt("wouldSendRate"));
console.log("  " + fmt("soundsLikeMe"));
console.log("  " + fmt("fitsRecipient"));
console.log("  " + fmt("tooAiLike", "down"));
console.log("  " + fmt("tooVerbose", "down"));
if (result.showsRecall !== undefined) {
  console.log("  " + fmt("showsRecall"));
  console.log("  " + fmt("inventedRate", "down"));
}

mkdirSync(BENCH, { recursive: true });
appendFileSync(HISTORY, JSON.stringify(result) + "\n");
log(`recorded → ${HISTORY}`);
