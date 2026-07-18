// Loads the Style Distiller's output (global style profile + per-relationship
// profiles) through the Tauri commands, with a short TTL cache so a fresh
// distiller run is picked up without restarting the app.

import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "@/lib/tauriEnv";

const TTL_MS = 5 * 60_000;

export interface StyleCard {
  summary?: string;
  humor?: string;
  sarcasm_0_10?: number;
  warmth_0_10?: number;
  directness_0_10?: number;
  formality_0_10?: number;
  energy?: string;
  signature_phrases?: string[];
  emoji_style?: string;
  language_notes?: string;
  do?: string[];
  dont?: string[];
}

export interface StyleStats {
  avgWords?: number;
  medianWords?: number;
  lowercaseStartRate?: number;
  terminalPeriodRate?: number;
  emojiPerMessage?: number;
  topEmoji?: string[];
  favoriteExpressions?: Array<{ phrase: string; count: number }>;
}

export interface StyleProfile {
  stats?: StyleStats;
  card?: StyleCard | null;
}

export interface RelationshipProfile {
  name?: string;
  stats?: StyleStats;
  card?: StyleCard | null;
  examples?: string[];
}

export interface AiProfiles {
  style: StyleProfile | null;
  relationship: RelationshipProfile | null;
}

function safeParse<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

let styleCache: { at: number; value: StyleProfile | null } | null = null;
const relCache = new Map<string, { at: number; value: RelationshipProfile | null }>();

export async function loadAiProfiles(chatGuid: string): Promise<AiProfiles> {
  if (!isTauriRuntime()) return { style: null, relationship: null };
  const now = Date.now();

  if (!styleCache || now - styleCache.at > TTL_MS) {
    const raw = await invoke<string | null>("ai_style_profile").catch(() => null);
    styleCache = { at: now, value: safeParse<StyleProfile>(raw) };
  }

  let rel = relCache.get(chatGuid);
  if (!rel || now - rel.at > TTL_MS) {
    const raw = await invoke<string | null>("ai_relationship_profile", { chatGuid }).catch(
      () => null
    );
    rel = { at: now, value: safeParse<RelationshipProfile>(raw) };
    relCache.set(chatGuid, rel);
  }

  return { style: styleCache.value, relationship: rel.value };
}
