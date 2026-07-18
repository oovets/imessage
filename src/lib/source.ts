/**
 * Message sources in the unified inbox.
 *
 * A chat's source is encoded in its GUID prefix: iMessage GUIDs are unprefixed
 * (they come from BlueBubbles as-is), every other source adds one. The source is
 * *derived* from the GUID rather than stored as a field on Chat so the two can
 * never drift, and so chats restored from the persisted cache need no migration.
 *
 * Everything that needs to know "which backend is this?" goes through here.
 * Because `ChatSource` is a closed union, adding a source makes the prefix and
 * capability tables below fail to compile until every case is answered — new
 * backends can't silently inherit iMessage behaviour.
 */

export type ChatSource = "imessage" | "telegram" | "slack";

/** GUID prefix per non-default source. iMessage is the unprefixed default. */
export const SOURCE_PREFIX: Record<Exclude<ChatSource, "imessage">, string> = {
  telegram: "tg:",
  slack: "sl:",
};

export function sourceOfGuid(guid: string): ChatSource {
  if (guid.startsWith(SOURCE_PREFIX.telegram)) return "telegram";
  if (guid.startsWith(SOURCE_PREFIX.slack)) return "slack";
  return "imessage";
}

export function isSource(guid: string, source: ChatSource): boolean {
  return sourceOfGuid(guid) === source;
}

/**
 * Per-source feature support, so components ask "does this source do X?"
 * instead of "is this Telegram?" — which is what actually breaks when a third
 * source arrives.
 */
export interface SourceCapabilities {
  /** Contact photos resolved from the BlueBubbles Contacts database. */
  contactAvatars: boolean;
}

export const SOURCE_CAPABILITIES: Record<ChatSource, SourceCapabilities> = {
  imessage: { contactAvatars: true },
  telegram: { contactAvatars: false },
  slack: { contactAvatars: false },
};

export function supports(guid: string, capability: keyof SourceCapabilities): boolean {
  return SOURCE_CAPABILITIES[sourceOfGuid(guid)][capability];
}
