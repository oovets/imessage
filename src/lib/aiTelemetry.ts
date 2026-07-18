// AI reply telemetry (Personality Engine §14) — what the model suggested and
// what the user did with it. Every edit is training data: the diff between the
// draft and what was actually sent is the clearest signal we get about where
// the personality is off.
//
// Events are appended as JSON lines to ai/telemetry.jsonl via Rust; nothing
// leaves the machine.

import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "@/lib/tauriEnv";

export type AiEventKind =
  | "generated" // a draft was produced
  | "accepted" // sent exactly as suggested
  | "edited" // sent after changes (carries the diff)
  | "rejected" // dismissed without sending
  | "auto_sent"; // auto mode sent it without review

export interface AiEvent {
  at: number;
  kind: AiEventKind;
  chatGuid: string;
  model: string;
  /** Relationship profile used, when the chat had one. */
  profile?: string | null;
  /** Generation latency, on "generated". */
  latencyMs?: number;
  draftChars?: number;
  sentChars?: number;
  /** Levenshtein-free rough diff: chars/words added+removed. */
  charDiff?: number;
  wordDiff?: number;
  /** Seconds between accepting a draft and sending it. */
  editSeconds?: number;
}

export function log(event: Omit<AiEvent, "at">): void {
  if (!isTauriRuntime()) return;
  const full: AiEvent = { at: Date.now(), ...event };
  void invoke("ai_log_event", { event: JSON.stringify(full) }).catch(() => {});
}

/** Symmetric-difference word count — cheap stand-in for a real diff. */
export function wordDiff(a: string, b: string): number {
  const wa = a.toLowerCase().split(/\s+/).filter(Boolean);
  const wb = b.toLowerCase().split(/\s+/).filter(Boolean);
  const counts = new Map<string, number>();
  for (const w of wa) counts.set(w, (counts.get(w) ?? 0) + 1);
  for (const w of wb) counts.set(w, (counts.get(w) ?? 0) - 1);
  let diff = 0;
  for (const n of counts.values()) diff += Math.abs(n);
  return diff;
}

export interface AiSummary {
  generated: number;
  accepted: number;
  edited: number;
  rejected: number;
  autoSent: number;
  /** Share of reviewed drafts sent untouched — the headline quality number. */
  acceptRate: number;
  medianLatencyMs: number;
  medianWordDiff: number;
  medianEditSeconds: number;
  byProfile: Array<{ profile: string; reviewed: number; acceptRate: number }>;
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.floor(s.length / 2)]);
}

export async function loadSummary(): Promise<AiSummary | null> {
  if (!isTauriRuntime()) return null;
  const raw = await invoke<string | null>("ai_read_telemetry").catch(() => null);
  if (!raw) return null;

  const events: AiEvent[] = raw
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as AiEvent;
      } catch {
        return null;
      }
    })
    .filter((e): e is AiEvent => e !== null);
  if (events.length === 0) return null;

  const of = (k: AiEventKind) => events.filter((e) => e.kind === k);
  const accepted = of("accepted");
  const edited = of("edited");
  const rejected = of("rejected");
  const reviewed = accepted.length + edited.length + rejected.length;

  const perProfile = new Map<string, { reviewed: number; accepted: number }>();
  for (const e of [...accepted, ...edited, ...rejected]) {
    const key = e.profile || "(no profile)";
    const cur = perProfile.get(key) ?? { reviewed: 0, accepted: 0 };
    cur.reviewed++;
    if (e.kind === "accepted") cur.accepted++;
    perProfile.set(key, cur);
  }

  return {
    generated: of("generated").length,
    accepted: accepted.length,
    edited: edited.length,
    rejected: rejected.length,
    autoSent: of("auto_sent").length,
    acceptRate: reviewed > 0 ? accepted.length / reviewed : 0,
    medianLatencyMs: median(of("generated").map((e) => e.latencyMs ?? 0).filter(Boolean)),
    medianWordDiff: median(edited.map((e) => e.wordDiff ?? 0)),
    medianEditSeconds: median(edited.map((e) => e.editSeconds ?? 0).filter(Boolean)),
    byProfile: [...perProfile.entries()]
      .map(([profile, v]) => ({
        profile,
        reviewed: v.reviewed,
        acceptRate: v.reviewed > 0 ? v.accepted / v.reviewed : 0,
      }))
      .sort((a, b) => b.reviewed - a.reviewed)
      .slice(0, 8),
  };
}
