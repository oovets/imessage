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

const log = (m) => console.log(`[bench] ${m}`);
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

const cases = readJson(CASES, []);
if (cases.length === 0) {
  console.error(`No cases in ${CASES}`);
  process.exit(1);
}

// ---------------------------------------------------------------- prompt
// Mirrors src/lib/aiReply.ts closely enough to benchmark prompt changes; keep
// the two in step when the runtime prompt changes shape.
function buildPrompt(rel) {
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

// ---------------------------------------------------------------- run
const t0 = Date.now();
log(`${cases.length} cases × ${RUNS} run(s) — model ${MODEL}, label "${LABEL}"`);
const scores = [];

for (const c of cases) {
  const rel = c.profile ? relFor(c.profile) : null;
  const system = buildPrompt(rel);
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
      scores.push({ case: c.name, reply, ...s });
      const verdict = s.wouldSend ? "✓" : "✗";
      console.log(
        `  ${verdict} ${c.name.padEnd(22)} me:${s.soundsLikeMe} fit:${s.fitsRecipient} ` +
          `ai:${s.tooAiLike} verb:${s.tooVerbose}  "${reply.slice(0, 48)}"`
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
  cases: cases.length,
  samples: scores.length,
  soundsLikeMe: avg((x) => x.soundsLikeMe),
  fitsRecipient: avg((x) => x.fitsRecipient),
  tooAiLike: avg((x) => x.tooAiLike),
  tooVerbose: avg((x) => x.tooVerbose),
  wouldSendRate: +(scores.filter((x) => x.wouldSend).length / scores.length).toFixed(2),
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

mkdirSync(BENCH, { recursive: true });
appendFileSync(HISTORY, JSON.stringify(result) + "\n");
log(`recorded → ${HISTORY}`);
