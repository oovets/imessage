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

function cardLines(card: StyleCard | null | undefined): string[] {
  if (!card) return [];
  const out: string[] = [];
  if (card.summary) out.push(card.summary);
  if (card.humor) out.push(`Humor: ${card.humor}`);
  if (card.energy) out.push(`Energy: ${card.energy}`);
  if (card.emoji_style) out.push(`Emoji: ${card.emoji_style}`);
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
  if (card.signature_phrases?.length)
    out.push(`Signature phrases: ${card.signature_phrases.slice(0, 8).join(", ")}`);
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
  if (stats.emojiPerMessage !== undefined && stats.topEmoji?.length)
    out.push(`Emoji ~${stats.emojiPerMessage}/message; favorites: ${stats.topEmoji.slice(0, 6).join(" ")}`);
  return out;
}

/** Layered system prompt (§5): RULES / STYLE / RELATIONSHIP / EXAMPLES. Exported for the simulator's prompt inspector. */
export function buildSystemPrompt(
  userPrompt: string,
  chatName: string,
  profiles: AiProfiles | null
): string {
  const sections: string[] = [];
  sections.push(`${userPrompt.trim()}\n${HARD_RULES}`);

  const style = profiles?.style;
  if (style) {
    const lines = [...cardLines(style.card), ...statLines(style.stats)];
    if (lines.length) sections.push(`MY WRITING STYLE:\n- ${lines.join("\n- ")}`);
  }

  const rel = profiles?.relationship;
  if (rel) {
    const lines = [...cardLines(rel.card), ...statLines(rel.stats)];
    if (lines.length)
      sections.push(`HOW I WRITE TO ${rel.name ?? chatName}:\n- ${lines.join("\n- ")}`);
    const pool = rel.examples ?? [];
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

  sections.push(`Conversation: "${chatName}".`);
  return sections.join("\n\n");
}

/**
 * Ask the model for a reply to the conversation. Returns null when the model
 * has nothing usable to say (empty response) — the caller just skips replying.
 */
export async function generateReply(
  cfg: AiReplyConfig,
  history: Message[],
  chatName: string,
  profiles: AiProfiles | null = null
): Promise<string | null> {
  const base = cfg.endpoint.trim().replace(/\/$/, "");
  if (!base || !cfg.model.trim()) return null;

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
          { role: "system", content: buildSystemPrompt(cfg.systemPrompt, chatName, profiles) },
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
    return reply.length > 0 ? reply : null;
  } finally {
    clearTimeout(timer);
  }
}
