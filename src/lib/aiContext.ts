// Reply-time retrieval over the conversation-embedding index (RAG).
//
// The heavy work — loading megabytes of packed vectors and scoring them —
// happens host-side (ai_retrieve_context); this module only decides WHAT to
// ask and degrades to nothing on any failure. Retrieval is an enhancement:
// a reply without past context beats no reply, so nothing here ever throws.

import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "@/lib/tauriEnv";
import type { Message } from "@/types";
import type { AiReplyConfig } from "@/lib/aiReply";

export interface RetrievedEpisode {
  at: number;
  text: string;
  score: number;
}

/** Default embedding model; must match what built the index (bge-m3). */
const EMBED_MODEL = "bge-m3";
/** Hard ceiling on how long we let retrieval hold up a reply. */
const RETRIEVAL_TIMEOUT_MS = 3000;

/**
 * The query is the incoming burst — what the reply must answer — not the
 * whole recent window, which would drown the question in our own answers.
 */
export function retrievalQuery(history: Message[]): string {
  const incoming: string[] = [];
  for (let i = history.length - 1; i >= 0 && incoming.length < 3; i--) {
    const m = history[i];
    if (m.isFromMe) {
      if (incoming.length > 0) break; // burst ended
      continue;
    }
    const t = (m.text ?? "").trim();
    if (t) incoming.unshift(t);
  }
  return incoming.join("\n").slice(0, 600);
}

export async function retrieveContext(
  chatGuid: string,
  history: Message[],
  cfg: AiReplyConfig
): Promise<RetrievedEpisode[]> {
  if (!isTauriRuntime()) return [];
  const query = retrievalQuery(history);
  if (!query) return [];

  const timeout = new Promise<RetrievedEpisode[]>((resolve) =>
    setTimeout(() => resolve([]), RETRIEVAL_TIMEOUT_MS)
  );
  const fetch = invoke<RetrievedEpisode[]>("ai_retrieve_context", {
    chatGuid,
    query,
    endpoint: cfg.endpoint.trim().replace(/\/$/, ""),
    model: cfg.embedModel?.trim() || EMBED_MODEL,
    k: 3,
  }).catch(() => [] as RetrievedEpisode[]);

  const episodes = await Promise.race([fetch, timeout]);
  // Episodes overlapping the visible recent window add nothing — the model
  // already sees those messages verbatim. Keep only genuinely older context.
  const oldestVisible = history.length > 0 ? history[0].dateCreated : 0;
  return episodes.filter((e) => e.at < oldestVisible - 60_000);
}

// ---------------------------------------------------------------- state
//
// Where the relationship stands right now (scripts/state-extractor.mjs).
// Unlike retrieval this needs no query and is always present, which is why
// it survives terse replies: it doesn't add words to an answer, it changes
// which short answer is right.

export interface ConversationState {
  openQuestions?: { who: "me" | "them"; text: string }[];
  plans?: { what: string; when: string; settled?: boolean }[];
  promises?: { who: "me" | "them"; text: string }[];
  threads?: string[];
  mood?: string;
}

/** Stop trusting an extraction once it's older than this. */
const STATE_MAX_AGE_MS = 7 * 24 * 3600_000;

export async function loadConversationState(
  chatGuid: string
): Promise<ConversationState | null> {
  if (!isTauriRuntime()) return null;
  const raw = await invoke<string | null>("ai_conversation_state", { chatGuid }).catch(
    () => null
  );
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { extractedAt?: number; state?: ConversationState };
    if (parsed.extractedAt && Date.now() - parsed.extractedAt > STATE_MAX_AGE_MS) return null;
    return parsed.state ?? null;
  } catch {
    return null;
  }
}

/** Prompt lines for the state, or [] when nothing is actually open. */
export function stateLines(state: ConversationState | null): string[] {
  if (!state) return [];
  const lines: string[] = [];
  for (const q of state.openQuestions ?? []) {
    lines.push(`${q.who === "me" ? "I asked and they never answered" : "They asked and I never answered"}: "${q.text}"`);
  }
  for (const p of state.plans ?? []) {
    lines.push(`Plan${p.settled ? "" : " (not settled)"}: ${p.what}${p.when ? ` — ${p.when}` : ""}`);
  }
  for (const p of state.promises ?? []) {
    lines.push(`${p.who === "me" ? "I promised" : "They promised"}: ${p.text}`);
  }
  const threads = (state.threads ?? []).slice(0, 6);
  if (threads.length) lines.push(`Currently in play: ${threads.join(", ")}`);
  if (state.mood) lines.push(`Tone between us lately: ${state.mood}`);
  return lines;
}
