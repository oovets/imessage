#!/usr/bin/env node
// state-extractor.mjs — where each relationship currently stands.
//
// Retrieval answers "what did we say about X" — but only when the incoming
// message has enough semantic content to find X, and the benchmark showed
// vague callbacks ("remember that nickname?") miss. State answers a different
// question that needs no query at all: what is open right now. Plans with
// dates, questions nobody answered, things I promised. It goes into every
// prompt unconditionally, which is exactly why it survives terse replies —
// it changes WHICH short answer is right.
//
// Output: ai/state/<file>.json per conversation + ai/state/index.json
//
// Usage:
//   node scripts/state-extractor.mjs                    # all indexed conversations
//     [--ollama http://gpulab:11434] [--model gemma3:12b]
//     [--max-conversations 40] [--recent-days 45] [--force]
//   node scripts/state-extractor.mjs --chat pelle --print

import { mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 ? process.argv[i + 1] : d;
};
const has = (n) => process.argv.includes(`--${n}`);

const OLLAMA = (arg("ollama", "http://gpulab:11434")).replace(/\/$/, "");
const MODEL = arg("model", "gemma3:12b");
const AI = join(homedir(), "Library/Application Support/com.oovets.messages/ai");
const EMB = join(AI, "embeddings");
const OUT = join(AI, "state");
const MAX_CONVS = parseInt(arg("max-conversations", "40"), 10);
const RECENT_DAYS = parseInt(arg("recent-days", "45"), 10);
/** Ollama defaults to 4096, which a conversation tail overflows on its own. */
const NUM_CTX = parseInt(arg("num-ctx", "16384"), 10);
const MAX_TAIL_CHARS = parseInt(arg("max-tail-chars", "20000"), 10);
const FORCE = has("force");

const log = (m) => console.log(`[state] ${m}`);
const readJson = (p, fallback = null) => {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
};

/**
 * Ollama's NATIVE endpoint, not the OpenAI-compatible one — deliberately.
 *
 * The default context window is 4096 tokens and /v1/chat/completions gives no
 * way to raise it: a conversation tail silently filled the whole window, the
 * model got one token to answer with, and extraction returned "Okay". Nothing
 * errored; the run just reported zero. num_ctx is only reachable here.
 */
async function chat(messages, maxTokens = 700) {
  const res = await fetch(`${OLLAMA}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages,
      stream: false,
      options: { num_ctx: NUM_CTX, temperature: 0.2, num_predict: maxTokens },
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const content = (json?.message?.content ?? "").trim();
  // A prompt that still overflows leaves no room to answer — surface it
  // rather than recording an empty state.
  if (json?.prompt_eval_count && json.prompt_eval_count >= NUM_CTX - 64) {
    throw new Error(`prompt filled the context window (${json.prompt_eval_count}/${NUM_CTX})`);
  }
  return content;
}

const SYSTEM =
  "You read the tail of a chat log between 'Me' and one other person and report WHERE THINGS " +
  "STAND right now. Facts only, from the text — never guess, never fill gaps. Today is TODAY " +
  "given below; use it to decide what is still upcoming.\n\n" +
  "Answer with ONLY minified JSON:\n" +
  '{"openQuestions":[{"who":"me|them","text":"…"}],' +
  '"plans":[{"what":"…","when":"YYYY-MM-DD or a phrase as written","settled":true|false}],' +
  '"promises":[{"who":"me|them","text":"…"}],' +
  '"threads":["short topic currently in play"],' +
  '"mood":"one clause on the current tone between us"}\n\n' +
  "Rules: an openQuestion is one asked and NOT answered later in the log. A promise is an " +
  "explicit commitment ('jag fixar', 'I'll send it'), not politeness. Drop anything already " +
  "resolved or in the past. Empty arrays are correct and expected — most conversations have " +
  "little open. Keep every entry under 15 words, in the language it was said.";

/** The recent tail is what "current" means; older history is retrieval's job. */
function recentTail(episodes, days) {
  const cutoff = Date.now() - days * 86_400_000;
  const recent = episodes.filter((e) => e.at >= cutoff);
  // A quiet conversation still has a state — fall back to the last few episodes.
  const chosen = recent.length >= 3 ? recent : episodes.slice(-6);
  let text = "";
  for (const ep of chosen.slice(-40)) {
    if (text.length + ep.text.length > MAX_TAIL_CHARS) break;
    text += ep.text + "\n\n";
  }
  return { text: text.trim(), episodes: chosen.length, newest: episodes[episodes.length - 1]?.at ?? 0 };
}

async function main() {
  const index = readJson(join(EMB, "index.json"));
  if (!index) {
    console.error("No embedding index — run scripts/conversation-indexer.mjs first.");
    process.exit(1);
  }
  mkdirSync(OUT, { recursive: true });

  const filter = (arg("chat", "") || "").toLowerCase();
  const convs = index.conversations
    .filter((c) => !filter || c.name.toLowerCase().includes(filter))
    .sort((a, b) => b.episodes - a.episodes)
    .slice(0, MAX_CONVS);

  const today = new Date().toISOString().slice(0, 10);
  const entries = [];
  let extracted = 0, skipped = 0;

  for (const conv of convs) {
    const data = readJson(join(EMB, conv.file));
    if (!data || data.episodes.length === 0) continue;
    const tail = recentTail(data.episodes, RECENT_DAYS);
    if (!tail.text) continue;

    const file = conv.file;
    const path = join(OUT, file);
    const prior = readJson(path);
    // Nothing new since the last extraction: keep it. State that is a night
    // old is fine; state recomputed from identical input is waste.
    if (!FORCE && prior && prior.newestAt === tail.newest) {
      entries.push({ guid: conv.guid, guids: conv.guids, name: conv.name, file });
      skipped++;
      continue;
    }

    let state = null;
    try {
      const raw = await chat([
        { role: "system", content: `${SYSTEM}\n\nTODAY: ${today}` },
        { role: "user", content: `Conversation with ${conv.name}:\n\n${tail.text}` },
      ]);
      const m = raw.match(/\{[\s\S]*\}/);
      state = m ? JSON.parse(m[0]) : null;
    } catch (e) {
      log(`  ! ${conv.name}: ${e.message}`);
    }
    if (!state) {
      log(`  ! ${conv.name}: no JSON in model output`);
      continue;
    }

    writeFileSync(
      path,
      JSON.stringify({
        guid: conv.guid,
        name: conv.name,
        extractedAt: Date.now(),
        newestAt: tail.newest,
        episodes: tail.episodes,
        state,
      })
    );
    entries.push({ guid: conv.guid, guids: conv.guids, name: conv.name, file });
    extracted++;
    const n = (k) => (state[k] ?? []).length;
    log(`  ${conv.name}: ${n("openQuestions")}q ${n("plans")}p ${n("promises")}pr ${n("threads")}t`);
    if (has("print")) console.log(`    ${JSON.stringify(state)}`);
  }

  writeFileSync(
    join(OUT, "index.json"),
    JSON.stringify({ model: MODEL, updatedAt: Date.now(), conversations: entries }, null, 2)
  );
  log(`done — ${extracted} extracted, ${skipped} unchanged`);
}

await main();
