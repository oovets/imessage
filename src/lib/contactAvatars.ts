// Contact avatars for iMessage chats, from the BlueBubbles contacts API (the
// server's macOS Contacts database — no Private API needed).
//
// The raw payload is heavy (100+ contact photos ≈ several MB), so each photo
// is downscaled once to a 64px JPEG thumbnail; the resulting map is a few
// hundred KB, kept in memory and persisted to localStorage with a TTL so app
// restarts skip the big fetch. Contact phone numbers come formatted
// ("070-753 11 17") while chat participants use E.164 ("+46707531117"), so
// lookups match on the last digits rather than the exact string.

import { useEffect, useState } from "react";
import type { Chat } from "@/types";
import { useAppStore } from "@/store/useAppStore";
import { supports } from "@/lib/source";
import { getClient } from "@/api/clientFactory";

const THUMB_SIZE = 64;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const cacheKey = (serverUrl: string) => `bb-avatar-cache:${serverUrl}`;

/** Phone numbers match on their last 9 digits (country-code agnostic); emails lowercased. */
function normalizeAddress(addr: string): string | null {
  const trimmed = addr.trim();
  if (!trimmed) return null;
  if (trimmed.includes("@")) return trimmed.toLowerCase();
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length < 5) return null;
  return digits.slice(-9);
}

async function downscale(b64: string): Promise<string | null> {
  try {
    const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes]));
    const scale = THUMB_SIZE / Math.min(bitmap.width, bitmap.height);
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();
    return canvas.toDataURL("image/jpeg", 0.8);
  } catch {
    return null;
  }
}

// normalized address -> thumbnail data URL
let avatarMap: Map<string, string> | null = null;
let building: Promise<Map<string, string>> | null = null;
const listeners = new Set<() => void>();

function restore(serverUrl: string): Map<string, string> | null {
  try {
    const raw = window.localStorage.getItem(cacheKey(serverUrl));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { at?: number; thumbs?: Record<string, string> };
    if (!parsed.at || Date.now() - parsed.at > CACHE_TTL_MS) return null;
    return new Map(Object.entries(parsed.thumbs ?? {}));
  } catch {
    return null;
  }
}

function persist(serverUrl: string, map: Map<string, string>): void {
  try {
    window.localStorage.setItem(
      cacheKey(serverUrl),
      JSON.stringify({ at: Date.now(), thumbs: Object.fromEntries(map) })
    );
  } catch {
    /* quota — live without the persisted copy */
  }
}

function ensureBuilt(serverUrl: string, password: string): void {
  if (avatarMap || building) return;
  const restored = restore(serverUrl);
  if (restored) {
    avatarMap = restored;
    listeners.forEach((fn) => fn());
    return;
  }
  building = (async () => {
    const map = new Map<string, string>();
    try {
      const raw = await getClient(serverUrl, password).getContactAvatarsRaw();
      for (const contact of raw) {
        const thumb = await downscale(contact.avatar);
        if (!thumb) continue;
        for (const addr of contact.addresses) {
          const key = normalizeAddress(addr);
          if (key) map.set(key, thumb);
        }
      }
      persist(serverUrl, map);
    } catch {
      /* server unreachable — initials fallback remains */
    }
    avatarMap = map;
    building = null;
    listeners.forEach((fn) => fn());
    return map;
  })();
}

/**
 * The contact avatar (thumbnail data URL) for an iMessage address, or null.
 * Respects the global "show avatars" setting (off = no fetch, initials only).
 */
export function useContactAvatarForAddress(address: string | null): string | null {
  const serverUrl = useAppStore((s) => s.serverUrl);
  const password = useAppStore((s) => s.password);
  const showAvatars = useAppStore((s) => s.showAvatars);
  const [, bump] = useState(0);

  const eligible = showAvatars && !!address && !!serverUrl;

  useEffect(() => {
    if (!eligible) return;
    ensureBuilt(serverUrl, password);
    if (avatarMap) return;
    const listener = () => bump((n) => n + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, [eligible, serverUrl, password]);

  if (!eligible || !avatarMap) return null;
  const key = normalizeAddress(address);
  return (key && avatarMap.get(key)) || null;
}

/**
 * The contact avatar for a 1-on-1 iMessage chat, or null (Telegram chats have
 * their own hook; group chats keep initials).
 */
export function useContactAvatar(chat: Chat): string | null {
  const participants = chat.participants ?? [];
  const eligible = supports(chat.guid, "contactAvatars") && participants.length === 1;
  return useContactAvatarForAddress(eligible ? (participants[0].address ?? null) : null);
}
