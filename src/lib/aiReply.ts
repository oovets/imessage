// AI auto-reply: generate a reply to a conversation via an OpenAI-compatible
// chat-completions endpoint (vLLM, Ollama, llama.cpp server, …). Requests go
// through the Tauri HTTP plugin so a plain-HTTP LAN GPU box works from the
// desktop shell without webview ATS/CORS blocks.

import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { isTauriRuntime } from "@/lib/tauriEnv";
import type { Message } from "@/types";
import type { AiProfiles, StyleCard, StyleStats } from "@/lib/aiProfiles";

const httpFetch: typeof fetch = (input: RequestInfo | URL, init?: RequestInit) =>
  isTauriRuntime()
    ? (tauriFetch as unknown as typeof fetch)(input, init)
    : fetch(input, init);

export interface AiReplyConfig {
  endpoint: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
  selfCritique?: boolean;
}

const MAX_CONTEXT_MESSAGES = 20;
const MAX_TOKENS = 300;
const TIMEOUT_MS = 60_000;
const FEW_SHOT_EXAMPLES = 5;

// §9 hard rules — always present, regardless of user prompt.
const HARD_RULES =
  "Hard rules: never copy any previous message verbatim; never invent facts, plans or " +
  "commitments; never mention being an AI or assistant; never explain yourself; reply in " +
  "the same language as the conversation; never use nicknames, pet names or terms of address " +
  "unless they appear in the examples for THIS contact; output ONLY the reply text.";

/**
 * Rough Swedish-vs-English detector. Idioms and signature phrases don't survive
 * translation — offering Swedish ones while the conversation runs in English is
 * what produced replies like "Skitfett wrong idea." Cheap heuristics are plenty
 * here: we only need to know whether a phrase belongs in this conversation.
 */
const SV_WORDS =
  /\b(och|att|det|jag|inte|är|för|med|som|har|men|kan|ska|vad|här|där|hur|när|jävla|fan|typ|asså|jo|nej|hej)\b/gi;
const EN_WORDS =
  /\b(the|and|you|that|have|for|not|with|this|are|was|but|can|what|how|when|there|here|dude|yeah|okay)\b/gi;

function detectLang(text: string): "sv" | "en" | "unknown" {
  const t = text.toLowerCase();
  const sv = (t.match(SV_WORDS)?.length ?? 0) + (t.match(/[åäö]/g)?.length ?? 0);
  const en = t.match(EN_WORDS)?.length ?? 0;
  if (sv > en) return "sv";
  if (en > sv) return "en";
  return "unknown";
}

/** The language the conversation is actually being held in. */
function conversationLang(history: Message[]): "sv" | "en" | "unknown" {
  let sv = 0;
  let en = 0;
  for (const m of history.slice(-8)) {
    const l = detectLang(m.text ?? "");
    if (l === "sv") sv++;
    else if (l === "en") en++;
  }
  if (sv > en) return "sv";
  if (en > sv) return "en";
  return "unknown";
}

function cardLines(
  card: StyleCard | null | undefined,
  lang: "sv" | "en" | "unknown" = "unknown"
): string[] {
  if (!card) return [];
  const out: string[] = [];
  if (card.summary) out.push(card.summary);
  if (card.humor) out.push(`Humor: ${card.humor}`);
  if (card.energy) out.push(`Energy: ${card.energy}`);
  if (card.language_notes) out.push(`Language: ${card.language_notes}`);
  const nums: string[] = [];
  for (const [label, v] of [
    ["sarcasm", card.sarcasm_0_10],
    ["warmth", card.warmth_0_10],
    ["directness", card.directness_0_10],
    ["formality", card.formality_0_10],
  ] as const) {
    if (typeof v === "number") nums.push(`${label} ${v}/10`);
  }
  if (nums.length) out.push(nums.join(", "));
  // Only offer phrases written in the language this conversation is using.
  const phrases = (card.signature_phrases ?? []).filter((p) => {
    if (lang === "unknown") return true;
    const l = detectLang(p);
    return l === "unknown" || l === lang;
  });
  if (phrases.length) out.push(`Signature phrases: ${phrases.slice(0, 8).join(", ")}`);
  if (card.do?.length) out.push(`Do: ${card.do.slice(0, 5).join("; ")}`);
  if (card.dont?.length) out.push(`Don't: ${card.dont.slice(0, 5).join("; ")}`);
  return out;
}

function statLines(stats: StyleStats | null | undefined): string[] {
  if (!stats) return [];
  const out: string[] = [];
  if (stats.medianWords)
    out.push(`Typical message length: ~${stats.medianWords} words (avg ${stats.avgWords}).`);
  if ((stats.lowercaseStartRate ?? 0) > 0.4) out.push("Often starts messages in lowercase.");
  if ((stats.terminalPeriodRate ?? 1) < 0.1) out.push("Almost never ends messages with a period.");
  // Emoji frequency is handled separately (emojiDirective) — models can't
  // self-regulate a rate, so we decide per reply instead.
  return out;
}

/**
 * Emoji use is a per-message coin flip, not something a model can average over
 * a conversation: asking for "roughly one in five" yields one in every reply,
 * while banning them yields none. Roll the user's measured rate for THIS reply
 * and hand the model a binary instruction — over many replies the observed
 * frequency matches the real one. The relationship rate wins when present.
 */
function emojiDirective(profiles: AiProfiles | null): string {
  const rate =
    profiles?.relationship?.stats?.emojiPerMessage ??
    profiles?.style?.stats?.emojiPerMessage;
  if (rate === undefined) return "";
  if (Math.random() < Math.min(1, rate)) {
    const favs = (
      profiles?.relationship?.stats?.topEmoji ?? profiles?.style?.stats?.topEmoji ?? []
    ).slice(0, 4);
    return `EMOJI: this reply may end with a SINGLE emoji if it genuinely fits${
      favs.length ? ` (mine: ${favs.join(" ")})` : ""
    } — never more than one.`;
  }
  return "EMOJI: write this reply with NO emoji at all.";
}

/** Layered system prompt (§5): RULES / STYLE / RELATIONSHIP / EXAMPLES. Exported for the simulator's prompt inspector. */
export function buildSystemPrompt(
  userPrompt: string,
  chatName: string,
  profiles: AiProfiles | null,
  lang: "sv" | "en" | "unknown" = "unknown"
): string {
  const sections: string[] = [];
  sections.push(`${userPrompt.trim()}\n${HARD_RULES}`);

  const style = profiles?.style;
  if (style) {
    const lines = [...cardLines(style.card, lang), ...statLines(style.stats)];
    if (lines.length) sections.push(`MY WRITING STYLE:\n- ${lines.join("\n- ")}`);
  }

  const rel = profiles?.relationship;
  if (rel) {
    const lines = [...cardLines(rel.card, lang), ...statLines(rel.stats)];
    if (lines.length)
      sections.push(`HOW I WRITE TO ${rel.name ?? chatName}:\n- ${lines.join("\n- ")}`);
    let pool = rel.examples ?? [];
    // Examples teach rhythm and vocabulary — in another language they teach the
    // wrong vocabulary, so prefer ones written in the conversation's language.
    if (lang !== "unknown") {
      const matching = pool.filter((e) => {
        const l = detectLang(e);
        return l === "unknown" || l === lang;
      });
      if (matching.length >= 3) pool = matching;
    }
    if (pool.length) {
      const step = Math.max(1, Math.floor(pool.length / FEW_SHOT_EXAMPLES));
      const picked = pool.filter((_, i) => i % step === 0).slice(0, FEW_SHOT_EXAMPLES);
      sections.push(
        "EXAMPLES of messages I have sent this contact. They illustrate writing style ONLY — " +
          "never copy facts, never copy sentences; imitate rhythm, vocabulary and tone:\n" +
          picked.map((e) => `- ${e}`).join("\n")
      );
    }
  }

  // My idioms are Swedish; when the conversation isn't, say so explicitly —
  // the style (rhythm, length, casing, bluntness) still carries over, the
  // vocabulary must not.
  const profileLang = detectLang(
    (profiles?.style?.card?.signature_phrases ?? []).join(" ") || "och att det"
  );
  if (lang !== "unknown" && profileLang !== "unknown" && lang !== profileLang) {
    sections.push(
      `LANGUAGE: this conversation is in ${lang === "en" ? "English" : "Swedish"}. Reply only in that language — ` +
        "never mix in words or idioms from my other language, however characteristic they are. " +
        "Keep my rhythm, message length, casing and bluntness; translate the attitude, not the words."
    );
  }

  const emoji = emojiDirective(profiles);
  if (emoji) sections.push(emoji);

  sections.push(`Conversation: "${chatName}".`);
  return sections.join("\n\n");
}

export interface Critique {
  soundsLikeMe: number;
  fitsRecipient: number;
  tooAiLike: number;
  tooVerbose: number;
  notes: string;
}

// Two thresholds, because the axes aren't symmetric. Models treat the
// "problem" scales (tooAiLike/tooVerbose) as if the middle were neutral — a
// three-word reply scored 5/10 verbose while the notes praised its brevity —
// so only a clearly bad score should trigger a rewrite. The "higher is better"
// axes behave as documented and can keep the strict bar from §6.
const GOOD_MIN = 8;
const PROBLEM_MAX = 7;

/**
 * Score a draft against the personality (§6). Runs as a second pass on the
 * same endpoint, given the same style layers — a model judging "would he
 * actually send this?" catches the failures a generator can't see in itself
 * (leaked idioms, AI politeness, three sentences where one would do).
 * Returns null when the model doesn't answer usefully; the caller then keeps
 * the draft as-is rather than blocking on a flaky judge.
 */
export async function critiqueReply(
  cfg: AiReplyConfig,
  systemPrompt: string,
  history: Message[],
  draft: string
): Promise<Critique | null> {
  const base = cfg.endpoint.trim().replace(/\/$/, "");
  if (!base || !cfg.model.trim()) return null;

  const lastIncoming = [...history].reverse().find((m) => !m.isFromMe)?.text ?? "";
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cfg.apiKey.trim()) headers.Authorization = `Bearer ${cfg.apiKey.trim()}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await httpFetch(`${base}/chat/completions`, {
      method: "POST",
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model: cfg.model.trim(),
        max_tokens: 200,
        messages: [
          {
            role: "system",
            content:
              "You judge whether a drafted reply sounds like the person described below. " +
              "Answer with ONLY minified JSON: " +
              '{"soundsLikeMe":0-10,"fitsRecipient":0-10,"tooAiLike":0-10,"tooVerbose":0-10,"notes":"one short sentence"}. ' +
              "tooAiLike and tooVerbose are problems — higher is worse. Be strict: generic " +
              "friendliness, over-explaining, or wording the person would never use should " +
              "score badly.\n\n" +
              systemPrompt,
          },
          {
            role: "user",
            content: `They received: "${lastIncoming}"\n\nDrafted reply: "${draft}"\n\nScore it.`,
          },
        ],
      }),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const raw: unknown = json?.choices?.[0]?.message?.content;
    const match = typeof raw === "string" ? raw.match(/\{[\s\S]*\}/) : null;
    if (!match) return null;
    const parsed = JSON.parse(match[0]) as Partial<Critique>;
    return {
      soundsLikeMe: Number(parsed.soundsLikeMe ?? 10),
      fitsRecipient: Number(parsed.fitsRecipient ?? 10),
      tooAiLike: Number(parsed.tooAiLike ?? 0),
      tooVerbose: Number(parsed.tooVerbose ?? 0),
      notes: String(parsed.notes ?? ""),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Does this critique warrant a rewrite? */
export function critiqueFails(c: Critique): boolean {
  return (
    c.soundsLikeMe < GOOD_MIN ||
    c.fitsRecipient < GOOD_MIN ||
    c.tooAiLike > PROBLEM_MAX ||
    c.tooVerbose > PROBLEM_MAX
  );
}

/**
 * Ask the model for a reply to the conversation. Returns null when the model
 * has nothing usable to say (empty response) — the caller just skips replying.
 */
export interface GeneratedReply {
  text: string;
  /** The system prompt used — reused verbatim by the critique pass. */
  systemPrompt: string;
}

export async function generateReply(
  cfg: AiReplyConfig,
  history: Message[],
  chatName: string,
  profiles: AiProfiles | null = null,
  /** Critique notes from a failed attempt, to steer the rewrite (§6). */
  rewriteNotes?: string
): Promise<GeneratedReply | null> {
  const base = cfg.endpoint.trim().replace(/\/$/, "");
  if (!base || !cfg.model.trim()) return null;

  const systemPrompt = buildSystemPrompt(
    cfg.systemPrompt,
    chatName,
    profiles,
    conversationLang(history)
  );
  const context = history
    .filter((m) => (m.text ?? "").trim().length > 0)
    .slice(-MAX_CONTEXT_MESSAGES)
    .map((m) => ({
      role: m.isFromMe ? ("assistant" as const) : ("user" as const),
      content: m.text!.trim(),
    }));
  if (context.length === 0 || context[context.length - 1].role !== "user") return null;

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cfg.apiKey.trim()) headers.Authorization = `Bearer ${cfg.apiKey.trim()}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await httpFetch(`${base}/chat/completions`, {
      method: "POST",
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model: cfg.model.trim(),
        max_tokens: MAX_TOKENS,
        messages: [
          {
            role: "system",
            content: rewriteNotes
              ? `${systemPrompt}\n\nYour previous attempt was rejected: ${rewriteNotes} Write a different reply that fixes this. Do not apologise or explain — output only the reply.`
              : systemPrompt,
          },
          ...context,
        ],
      }),
    });
    if (!res.ok) {
      throw new Error(`AI endpoint returned HTTP ${res.status}`);
    }
    const json = await res.json();
    const text: unknown = json?.choices?.[0]?.message?.content;
    const reply = typeof text === "string" ? text.trim() : "";
    return reply.length > 0 ? { text: reply, systemPrompt } : null;
  } finally {
    clearTimeout(timer);
  }
}
