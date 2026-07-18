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
