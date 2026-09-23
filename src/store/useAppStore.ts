import { create } from "zustand";
import { persist, type PersistStorage } from "zustand/middleware";
import {
  DEFAULT_APPEARANCE,
  FONT_SCALE_STEP,
  LEGACY_DEFAULT_FONT_FAMILY,
  clampFontScale,
  type AppearanceSettings,
  type ThemeMode,
  type ThemeTokenKey,
} from "@/lib/appearance";
import type { Attachment, Chat, Handle, LinkPreview, Message } from "@/types";
import { sourceOfGuid, type ChatSource } from "@/lib/source";
import {
  collectOpenChatGuids,
  evictMessageCache,
  touchOrder,
  type MessageCacheState,
} from "./messageCache";

const MAX_CACHED_MESSAGES = 100;
const MAX_CACHED_LINK_PREVIEWS = 200;
const MAX_PANE_DEPTH = 20;
const MAX_PANE_LEAVES = 20;
const OUTGOING_DEDUP_WINDOW_MS = 30_000;
/** react-resizable-panels rounds sizes to 3 decimals; closer is the same layout. */
const PANE_LAYOUT_EPSILON = 0.001;

/** A pending AI suggestion plus what we need to score it later. */
export interface AiDraft {
  text: string;
  at: number;
  latencyMs?: number;
  profile?: string | null;
  model: string;
  /** Set when the user pulls it into the composer (edit-time measurement). */
  usedAt?: number;
  /** Open §17 trace, closed when the user accepts/edits/rejects. */
  traceKey?: string;
}

export type PaneNode =
  | { type: "leaf"; id: string; chatGUID: string | null }
  | {
      type: "split";
      id: string;
      direction: "horizontal" | "vertical";
      children: [PaneNode, PaneNode];
    };

function uid(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

const EMPTY_LEAF: PaneNode = { type: "leaf", id: "pane_root", chatGUID: null };

function findLeafByChat(node: PaneNode, guid: string): PaneNode | null {
  if (node.type === "leaf") return node.chatGUID === guid ? node : null;
  return findLeafByChat(node.children[0], guid) ?? findLeafByChat(node.children[1], guid);
}
function findLeaf(node: PaneNode, id: string): PaneNode | null {
  if (node.type === "leaf") return node.id === id ? node : null;
  return findLeaf(node.children[0], id) ?? findLeaf(node.children[1], id);
}
function firstLeaf(node: PaneNode): PaneNode {
  return node.type === "leaf" ? node : firstLeaf(node.children[0]);
}
/**
 * Leaf panes in reading order — left-to-right, top-to-bottom. A pane's index
 * here + 1 is its ⌘N key, shown on the pane header and on sidebar rows.
 */
export function paneLeafOrder(node: PaneNode): Array<{ id: string; chatGUID: string | null }> {
  if (node.type === "leaf") return [{ id: node.id, chatGUID: node.chatGUID }];
  return [...paneLeafOrder(node.children[0]), ...paneLeafOrder(node.children[1])];
}
/** Columns along the root's horizontal splits (the board's top-level width). */
function countColumns(node: PaneNode): number {
  if (node.type === "split" && node.direction === "horizontal") {
    return countColumns(node.children[0]) + countColumns(node.children[1]);
  }
  return 1;
}
function mapTree(node: PaneNode, fn: (n: PaneNode) => PaneNode): PaneNode {
  if (node.type === "split") {
    const withMappedChildren: PaneNode = {
      ...node,
      children: [mapTree(node.children[0], fn), mapTree(node.children[1], fn)],
    };
    return fn(withMappedChildren);
  }
  return fn(node);
}

function paneTreeStats(root: PaneNode): { depth: number; leaves: number } {
  let depth = 0;
  let leaves = 0;
  const stack: Array<{ node: PaneNode; level: number }> = [{ node: root, level: 1 }];

  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.level > depth) depth = current.level;
    if (current.node.type === "leaf") {
      leaves += 1;
      continue;
    }
    stack.push({ node: current.node.children[0], level: current.level + 1 });
    stack.push({ node: current.node.children[1], level: current.level + 1 });
  }
  return { depth, leaves };
}

function isPaneTreeHealthy(root: PaneNode): boolean {
  const stats = paneTreeStats(root);
  return (
    stats.leaves >= 1 &&
    stats.leaves <= MAX_PANE_LEAVES &&
    stats.depth >= 1 &&
    stats.depth <= MAX_PANE_DEPTH
  );
}

function sanitizeLayoutPair(sizes: number[] | undefined): [number, number] {
  if (!sizes || sizes.length < 2) return [50, 50];
  const aRaw = Number(sizes[0]);
  const bRaw = Number(sizes[1]);
  if (!Number.isFinite(aRaw) || !Number.isFinite(bRaw)) return [50, 50];
  const sum = aRaw + bRaw;
  if (sum <= 0) return [50, 50];
  let a = (aRaw / sum) * 100;
  a = Math.max(15, Math.min(85, a));
  return [a, 100 - a];
}

function sanitizePaneLayouts(layouts: Record<string, number[]>): Record<string, number[]> {
  const next: Record<string, number[]> = {};
  for (const [id, sizes] of Object.entries(layouts ?? {})) {
    next[id] = sanitizeLayoutPair(sizes);
  }
  return next;
}

function ensurePaneState(tree: PaneNode, activePaneId: string): {
  tree: PaneNode;
  activePaneId: string;
} {
  if (!isPaneTreeHealthy(tree)) {
    return { tree: EMPTY_LEAF, activePaneId: EMPTY_LEAF.id };
  }
  const active = findLeaf(tree, activePaneId);
  if (active && active.type === "leaf") return { tree, activePaneId };
  return { tree, activePaneId: firstLeaf(tree).id };
}

function isLocalOptimisticMessage(message: Message): boolean {
  return message.guid.startsWith("local-") || !!message.tempGuid;
}

function shouldReplaceLocalOutgoing(local: Message, incoming: Message): boolean {
  if (!incoming.isFromMe || !local.isFromMe) return false;
  if (!isLocalOptimisticMessage(local)) return false;
  if (incoming.guid === local.guid) return false;

  if (incoming.tempGuid && local.tempGuid === incoming.tempGuid) {
    return true;
  }

  return (
    !incoming.tempGuid &&
    (local.text ?? "") === (incoming.text ?? "") &&
    (local.associatedMessageGuid ?? "") === (incoming.associatedMessageGuid ?? "") &&
    Math.abs(local.dateCreated - incoming.dateCreated) < OUTGOING_DEDUP_WINDOW_MS
  );
}

function capMessages(messages: Message[]): Message[] {
  return messages.length > MAX_CACHED_MESSAGES
    ? messages.slice(-MAX_CACHED_MESSAGES)
    : messages;
}

/**
 * Apply LRU eviction after a write to `chatGUID`. The just-written chat and any
 * chat currently open in a pane are protected from eviction; everything else
 * beyond MAX_CACHED_CHATS is dropped, oldest first. Returns the store patch.
 */
function pruneMessageCache(
  paneTree: PaneNode,
  touchedGuid: string,
  next: MessageCacheState
): MessageCacheState {
  const keep = collectOpenChatGuids(paneTree);
  keep.add(touchedGuid);
  return evictMessageCache(
    { ...next, messageOrder: touchOrder(next.messageOrder, touchedGuid) },
    keep
  );
}

function mergeMessageList(existing: Message[], incomingMessages: Message[]): Message[] {
  const byGuid = new Map(existing.map((m) => [m.guid, m]));

  for (const incoming of incomingMessages) {
    for (const [guid, local] of byGuid) {
      if (shouldReplaceLocalOutgoing(local, incoming)) {
        byGuid.delete(guid);
        break;
      }
    }
    byGuid.set(incoming.guid, incoming);
  }

  return [...byGuid.values()]
    .sort((a, b) => a.dateCreated - b.dateCreated)
    .slice(-MAX_CACHED_MESSAGES);
}

function setLeafChat(tree: PaneNode, leafId: string, chatGUID: string | null): PaneNode {
  return mapTree(tree, (n) =>
    n.type === "leaf" && n.id === leafId ? { ...n, chatGUID } : n
  );
}
function splitLeaf(
  tree: PaneNode,
  leafId: string,
  direction: "horizontal" | "vertical",
  newChatGUID: string | null
): { tree: PaneNode; newLeafId: string } {
  const newLeafId = uid("pane");
  const next = mapTree(tree, (n) => {
    if (n.type !== "leaf" || n.id !== leafId) return n;
    return {
      type: "split",
      id: uid("split"),
      direction,
      children: [
        { type: "leaf", id: n.id, chatGUID: n.chatGUID },
        { type: "leaf", id: newLeafId, chatGUID: newChatGUID },
      ],
    };
  });
  return { tree: next, newLeafId };
}
function collectSplitIds(node: PaneNode, out: Set<string>): void {
  if (node.type !== "split") return;
  out.add(node.id);
  collectSplitIds(node.children[0], out);
  collectSplitIds(node.children[1], out);
}

function pruneLayouts(
  layouts: Record<string, number[]>,
  tree: PaneNode
): Record<string, number[]> {
  const ids = new Set<string>();
  collectSplitIds(tree, ids);
  const next: Record<string, number[]> = {};
  for (const id of ids) {
    const v = layouts[id];
    if (v) next[id] = v;
  }
  return next;
}

function removeLeaf(tree: PaneNode, leafId: string): { tree: PaneNode; nextActiveId: string } {
  function helper(n: PaneNode): PaneNode | null {
    if (n.type === "leaf") return n.id === leafId ? null : n;
    const left = helper(n.children[0]);
    const right = helper(n.children[1]);
    if (!left) return right;
    if (!right) return left;
    return { ...n, children: [left, right] };
  }
  const result = helper(tree);
  if (!result) {
    const fresh: PaneNode = { type: "leaf", id: uid("pane"), chatGUID: null };
    return { tree: fresh, nextActiveId: fresh.id };
  }
  return { tree: result, nextActiveId: firstLeaf(result).id };
}

interface AppState {
  serverUrl: string;
  password: string;
  isConfigured: boolean;
  configLoaded: boolean;
  // Set when the user skips BlueBubbles setup (e.g. to run Telegram only), so
  // the first-run wizard stops gating the app. Persisted.
  onboardingDismissed: boolean;
  dismissOnboarding: () => void;
  launchOnLogin: boolean;
  networkOnline: boolean;
  connectionNotice: string | null;
  superlightMode: boolean;
  showTimestamps: boolean;
  // Show contact/Telegram profile photos; off = initials only.
  showAvatars: boolean;
  // AI auto-reply: an OpenAI-compatible endpoint answers on the user's behalf
  // in explicitly enabled chats.
  aiReply: {
    endpoint: string;
    apiKey: string;
    model: string;
    systemPrompt: string;
    /** Min seconds between auto-replies per chat; 0 = no limit. */
    cooldownSeconds: number;
    /** Auto-replies in a row before going quiet until a manual message; 0 = no limit. */
    maxConsecutive: number;
    /** Score each draft and rewrite once if it doesn't sound like the user (§6). */
    selfCritique: boolean;
    /**
     * Delivery dials (§10), as offsets from the distilled profile rather than
     * absolute levels — 0 means "however I normally am", so turning one up
     * adapts the delivery without overwriting the personality.
     */
    /** OTLP/HTTP collector for pipeline traces (§17); empty disables tracing. */
    otlpEndpoint: string;
    /** "auto" matches the measured rate; "never" forbids emoji outright. */
    emojiMode: "auto" | "never";
    tone: {
      humor: number;
      sarcasm: number;
      warmth: number;
      energy: number;
      formality: number;
    };
  };
  // Per-chat AI mode: "draft" (suggestion lands in the composer, default) or
  // "auto" (sends by itself). Legacy persisted `true` means "draft".
  aiReplyChats: Record<string, "draft" | "auto" | true>;
  // Transient AI suggestions per chat (not persisted). Metadata rides along so
  // accept/edit/reject telemetry can attribute the outcome.
  aiDrafts: Record<string, AiDraft>;
  sidebarHidden: boolean;
  appearance: AppearanceSettings;
  linkPreviewsEnabled: boolean;

  chats: Chat[];
  paneTree: PaneNode;
  activePaneId: string;
  paneLayouts: Record<string, number[]>;

  messages: Record<string, Message[]>;
  messageOrder: string[];
  replyTarget: Record<string, Message | null>;
  messageFetchedAt: Record<string, number>;
  linkPreviewCache: Record<string, LinkPreview>;

  loadingChats: boolean;
  loadingMessages: boolean;
  wsConnected: boolean;
  pollingFallback: boolean;
  hydrated: boolean;
  error: string | null;
  typingChats: Record<string, number>;
  setTyping: (chatGUID: string, display: boolean) => void;

  // Unified inbox: Telegram availability + its slice of the chat list.
  telegramAvailable: boolean;
  /** Slack is configured with at least one workspace. */
  slackAvailable: boolean;
  setSlackAvailable: (v: boolean) => void;
  setSlackChats: (chats: Chat[]) => void;
  slackReloadNonce: number;
  reloadSlack: () => void;
  /** workspace id -> our own Slack user id, for marking history as ours. */
  slackSelfUserIds: Record<string, string>;
  setSlackSelfUserId: (workspaceId: string, userId: string) => void;
  /** workspace id -> (user id -> display name), for `<@U123>` mentions. */
  slackUserNames: Record<string, Record<string, string>>;
  setSlackUserNames: (workspaceId: string, names: Record<string, string>) => void;
  setTelegramAvailable: (v: boolean) => void;

  // Account grouping in the chat list. Labels come from whichever backend owns
  // the account; collapse state is the user's and persists across restarts.
  /** account key (see lib/accounts) -> human name, e.g. "slack:work" -> "Work". */
  accountLabels: Record<string, string>;
  setAccountLabel: (key: string, label: string) => void;
  collapsedAccounts: string[];
  toggleAccountCollapsed: (key: string) => void;
  /** Pinned chat guids, any source — shown in the Starred section on top. */
  starredChats: string[];
  toggleStarred: (guid: string) => void;
  setTelegramChats: (chats: Chat[]) => void;
  upsertChat: (chat: Chat) => void;
  /** upsertChat for a batch, applied in order with one sort and one commit. */
  upsertChats: (chats: Chat[]) => void;
  // Bumped to re-run the Telegram chat loader (e.g. after adding an account).
  telegramReloadNonce: number;
  reloadTelegram: () => void;
  // Presence keyed by the private-chat GUID (tg:<account>:<userId>).
  telegramPresence: Record<string, { online: boolean; lastSeen: number | null }>;
  setTelegramPresence: (
    guid: string,
    presence: { online: boolean; lastSeen: number | null },
  ) => void;

  setConfig: (serverUrl: string, password: string) => void;
  clearConfig: () => void;
  setConfigLoaded: (v: boolean) => void;
  setLaunchOnLogin: (v: boolean) => void;
  setNetworkOnline: (v: boolean) => void;
  setConnectionNotice: (v: string | null) => void;
  setSuperlightMode: (v: boolean) => void;
  setShowTimestamps: (v: boolean) => void;
  setShowAvatars: (v: boolean) => void;
  setAiReplyConfig: (patch: Partial<AppState["aiReply"]>) => void;
  cycleAiReplyChat: (guid: string) => void;
  setAiDraft: (guid: string, draft: AiDraft) => void;
  /** Marks a draft as taken into the composer; starts the edit timer. */
  markAiDraftUsed: (guid: string) => void;
  clearAiDraft: (guid: string) => void;
  setSidebarHidden: (v: boolean) => void;
  toggleSidebarHidden: () => void;
  setFontScale: (value: number) => void;
  increaseFontScale: () => void;
  decreaseFontScale: () => void;
  resetFontScale: () => void;
  setFontFamily: (value: string) => void;
  setThemeToken: (mode: ThemeMode, token: ThemeTokenKey, value: string) => void;
  resetThemeOverrides: (mode?: ThemeMode) => void;
  setLinkPreviewsEnabled: (value: boolean) => void;
  setLinkPreview: (url: string, preview: LinkPreview) => void;
  clearLinkPreviewCache: () => void;
  selectedChatGUID: string | null;
  selectChat: (guid: string | null) => void;

  openChatInActivePane: (guid: string) => void;
  setPaneChat: (paneId: string, guid: string | null) => void;
  setActivePane: (paneId: string) => void;
  splitPane: (paneId: string, direction: "horizontal" | "vertical", chatGUID?: string | null) => void;
  /** Add a new column at the right edge of the board (the empty drop slot). */
  appendPane: (chatGUID?: string | null) => void;
  /** Focus mode: show only this pane until cleared (Esc / Maximize again). */
  focusedPaneId: string | null;
  setFocusedPane: (paneId: string | null) => void;
  /** Command-bar query; filters the sidebar. Not persisted. */
  chatQuery: string;
  setChatQuery: (q: string) => void;
  closePane: (paneId: string) => void;
  setPaneLayout: (groupId: string, sizes: number[]) => void;
  repairPaneState: () => void;

  /** Replace one source's chats, keeping every other source's untouched. */
  setChatsForSource: (source: ChatSource, chats: Chat[]) => void;
  setChats: (chats: Chat[]) => void;
  setMessages: (chatGUID: string, messages: Message[]) => void;
  mergeMessages: (chatGUID: string, newMessages: Message[]) => void;
  upsertMessage: (message: Message) => void;
  removeMessage: (chatGUID: string, guid: string) => void;
  replaceMessage: (chatGUID: string, oldGuid: string, message: Message) => void;
  markChatHasNewMessage: (chatGUID: string) => void;
  /** Zero a chat's unread count (the pane showing it gained focus). */
  markChatViewed: (chatGUID: string) => void;
  updateChatPreview: (chatGUID: string, text: string) => void;
  setReplyTarget: (chatGUID: string, message: Message | null) => void;
  setLoadingChats: (v: boolean) => void;
  setLoadingMessages: (v: boolean) => void;
  setWsConnected: (v: boolean) => void;
  setPollingFallback: (v: boolean) => void;
  setHydrated: (v: boolean) => void;
  setError: (e: string | null) => void;
}

function deriveSelectedChat(tree: PaneNode, activePaneId: string): string | null {
  const leaf = findLeaf(tree, activePaneId);
  if (leaf && leaf.type === "leaf") return leaf.chatGUID;
  const fallbackLeaf = firstLeaf(tree);
  return fallbackLeaf.type === "leaf" ? fallbackLeaf.chatGUID : null;
}

// Unified inbox: every source's chats live in the same `chats` array,
// distinguished by the GUID prefix (see lib/source.ts). Each source replaces
// only its own slice so sources never clobber each other, and the merged list
// is sorted by most-recent activity so conversations interleave by time.
function chatActivity(chat: Chat): number {
  return chat.activityAt ?? chat.lastMessage?.dateCreated ?? 0;
}
// Tie-break for chats with equal/unknown activity (e.g. before iMessage
// enrichment fills activityAt). Without it the order would depend on which
// source happened to refresh last; this keeps it deterministic.
const SOURCE_ORDER: Record<ChatSource, number> = { imessage: 0, telegram: 1, slack: 2 };

function sortChatsByRecency(list: Chat[]): Chat[] {
  return [...list].sort(
    (a, b) =>
      chatActivity(b) - chatActivity(a) ||
      SOURCE_ORDER[sourceOfGuid(a.guid)] - SOURCE_ORDER[sourceOfGuid(b.guid)]
  );
}

// Every source reloads by building fresh chat objects (the iMessage fetch, the
// Telegram and Slack adapters), and Telegram re-announces each dialog on every
// sync. Storing those as-is gave every row a new object on each load, so
// memo(ChatItem) missed for the whole list even when nothing had changed.
// These compare by VALUE on every field the UI reads (the same fields slimChat
// persists) and keep the stored object when they match.
function sameParticipants(a: Handle[] | undefined, b: Handle[] | undefined): boolean {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every(
    (p, i) =>
      p === b[i] ||
      (!!p && !!b[i] && p.address === b[i].address && p.firstName === b[i].firstName)
  );
}

function sameChat(a: Chat, b: Chat): boolean {
  const am = a.lastMessage;
  const bm = b.lastMessage;
  return (
    a.guid === b.guid &&
    a.displayName === b.displayName &&
    a.chatIdentifier === b.chatIdentifier &&
    Object.is(a.unreadCount, b.unreadCount) &&
    a.lastMessageText === b.lastMessageText &&
    Object.is(a.activityAt, b.activityAt) &&
    a.avatarUrl === b.avatarUrl &&
    a.slackSection === b.slackSection &&
    sameParticipants(a.participants, b.participants) &&
    // Readers only ever look at lastMessage?.dateCreated / ?.text.
    (am === bm ||
      (am == null && bm == null) ||
      (am != null &&
        bm != null &&
        Object.is(am.dateCreated, bm.dateCreated) &&
        am.text === bm.text))
  );
}

/**
 * Chats whose on-screen text also depends on the clock: an unread chat's card
 * shows a relative time ("14:02", later "Mon"), and an open chat's pane shows
 * relative times ("last seen …", date chips). Nothing re-renders those on a
 * timer; a fresh chat object from a reload or an event is what refreshes them.
 * So these chats keep getting a fresh object wherever they got one before.
 */
function showsRelativeTime(chat: Chat, openChats: ReadonlySet<string>): boolean {
  return (chat.unreadCount ?? 0) > 0 || openChats.has(chat.guid);
}

/**
 * The object to store for `next`: the stored `prev` when it renders the same,
 * else `next`. A chat without activityAt is left as `next`: enrichChatActivity
 * fills exactly those in place after the list is stored, and must keep
 * updating the stored object as it did.
 */
function reuseChat(prev: Chat | undefined, next: Chat, openChats: ReadonlySet<string>): Chat {
  return prev !== undefined &&
    prev !== next &&
    next.activityAt !== undefined &&
    !showsRelativeTime(next, openChats) &&
    sameChat(prev, next)
    ? prev
    : next;
}

function sameChatList(a: Chat[], b: Chat[]): boolean {
  return a.length === b.length && a.every((c, i) => c === b[i]);
}

// localStorage wrapper that can never break app flows: a quota-exceeded write
// evicts the secondary caches (avatars, contacts — both rebuildable) and
// retries once; if it still fails the write is dropped and the app runs on.
//
// Writes are also DEBOUNCED. zustand's persist middleware serialises the whole
// persisted slice on every store change, and this store changes on every
// websocket message, typing event and preview write — with 600 chats and the
// message cache that is megabytes of JSON.stringify on the main thread, many
// times a second while the app is busy. That stall lands exactly where the
// user feels it: between their click or keystroke and the next paint. One
// trailing write after a quiet half-second keeps the same durability for a
// cold start, and pagehide flushes so a quit never loses the last burst.
// The debounce sits ABOVE the JSON layer on purpose: createJSONStorage would
// stringify before handing over the string, so debouncing under it would skip
// only the (cheap) disk write and still pay the (expensive) serialisation on
// every store change. Holding the state snapshot and stringifying once on
// flush skips both. Snapshots are safe to hold — zustand state is replaced,
// never mutated.
//
// persist also hands over a snapshot on EVERY set(), including no-op sets and
// the many that touch only transient state (typing, presence, the command-bar
// query, loading flags). Those change nothing on disk, so a snapshot whose
// every key is identical to the last one handed over schedules no write of its
// own; it only keeps an already pending write waiting for the quiet period, as
// before. partialize hands over plain references for the same reason: the
// comparison is by identity, and the slimming (chats, messages) happens once,
// at flush time, instead of on every set.
const PERSIST_DEBOUNCE_MS = 500;
let persistTimer: number | undefined;
let pendingWrite: { name: string; value: unknown } | null = null;

interface PersistedValue {
  state: Record<string, unknown>;
  version?: number;
}
/** The last snapshot handed to setItem (pending or written); null = none yet. */
let lastHandedOver: { name: string; value: PersistedValue } | null = null;

function samePersistedValue(a: PersistedValue, b: PersistedValue): boolean {
  if (!Object.is(a.version, b.version)) return false;
  const keys = Object.keys(a.state);
  if (keys.length !== Object.keys(b.state).length) return false;
  return keys.every((k) => k in b.state && Object.is(a.state[k], b.state[k]));
}

/** Returns whether the value reached storage. */
function writeThrough(name: string, value: string): boolean {
  try {
    window.localStorage.setItem(name, value);
    return true;
  } catch {
    try {
      for (const key of Object.keys(window.localStorage)) {
        if (key.startsWith("bb-avatar-cache") || key.startsWith("bb-contact-cache")) {
          window.localStorage.removeItem(key);
        }
      }
      window.localStorage.setItem(name, value);
      return true;
    } catch {
      /* still over quota — persist skipped, in-memory state unaffected */
      return false;
    }
  }
}

function flushPendingPersist() {
  if (persistTimer !== undefined) {
    window.clearTimeout(persistTimer);
    persistTimer = undefined;
  }
  if (pendingWrite) {
    const { name, value } = pendingWrite;
    pendingWrite = null;
    let saved = false;
    try {
      saved = writeThrough(name, JSON.stringify(slimPersistedValue(value as PersistedValue)));
    } finally {
      // A write that never landed must be retried by the next set(), as it
      // was before unchanged snapshots were skipped.
      if (!saved) lastHandedOver = null;
    }
  }
}

if (typeof window !== "undefined") {
  // pagehide, not beforeunload: fires reliably on app quit and window close.
  window.addEventListener("pagehide", flushPendingPersist);
}

/** PersistStorage working on parsed values, so serialisation is debounced too. */
const debouncedStorage = {
  getItem: (name: string) => {
    const raw = window.localStorage.getItem(name);
    return raw ? JSON.parse(raw) : null;
  },
  removeItem: (name: string) => {
    pendingWrite = null;
    lastHandedOver = null;
    window.localStorage.removeItem(name);
  },
  setItem: (name: string, value: unknown) => {
    const next = value as PersistedValue;
    const unchanged =
      lastHandedOver !== null &&
      lastHandedOver.name === name &&
      samePersistedValue(lastHandedOver.value, next);
    if (!unchanged) {
      lastHandedOver = { name, value: next };
      pendingWrite = { name, value };
    } else if (!pendingWrite) {
      return;
    }
    if (persistTimer !== undefined) window.clearTimeout(persistTimer);
    persistTimer = window.setTimeout(flushPendingPersist, PERSIST_DEBOUNCE_MS);
  },
};

// Persisted messages keep exactly the fields the Message type declares. The
// iMessage side stores the raw BlueBubbles JSON (about 50 fields each, with
// attributedBody and full handle/attachment records), and nothing reads the
// undeclared ones — so they are the bulk of the blob, stringified on every
// flush and parsed before first paint. Kept fields stay in their original
// order, so an already-slim message (Telegram, Slack, socket) serialises to
// the same bytes as before.
// Built from Record<keyof T, true> so the lists stay exhaustive: a field added
// to Message, Handle or Attachment fails to compile until it is listed here,
// instead of silently vanishing from the cache on the next restart.
const MESSAGE_FIELDS: Record<keyof Message, true> = {
  guid: true,
  text: true,
  isFromMe: true,
  dateCreated: true,
  handle: true,
  attachments: true,
  associatedMessageGuid: true,
  associatedMessageType: true,
  chatGUID: true,
  pending: true,
  failed: true,
  failedReason: true,
  tempGuid: true,
  tgReactions: true,
};
const HANDLE_FIELDS: Record<keyof Handle, true> = { address: true, firstName: true };
const ATTACHMENT_FIELDS: Record<keyof Attachment, true> = {
  guid: true,
  mimeType: true,
  transferName: true,
  url: true,
};
const MESSAGE_KEYS: ReadonlySet<string> = new Set(Object.keys(MESSAGE_FIELDS));
const HANDLE_KEYS: ReadonlySet<string> = new Set(Object.keys(HANDLE_FIELDS));
const ATTACHMENT_KEYS: ReadonlySet<string> = new Set(Object.keys(ATTACHMENT_FIELDS));

/** `obj` with only `keys`, in their original order; `obj` itself if none is dropped. */
function pickKeys<T extends object>(obj: T, keys: ReadonlySet<string>): T {
  const own = Object.keys(obj);
  if (own.every((k) => keys.has(k))) return obj;
  const out: Record<string, unknown> = {};
  for (const k of own) {
    if (keys.has(k)) out[k] = (obj as Record<string, unknown>)[k];
  }
  return out as T;
}

function slimAttachments(list: Attachment[]): Attachment[] {
  let changed = false;
  const out = list.map((a) => {
    const slim = a && typeof a === "object" ? pickKeys(a, ATTACHMENT_KEYS) : a;
    if (slim !== a) changed = true;
    return slim;
  });
  return changed ? out : list;
}

/** A message reduced to its declared fields; never mutates the stored object. */
function slimMessage(m: Message): Message {
  if (!m || typeof m !== "object") return m;
  const top = pickKeys(m, MESSAGE_KEYS);
  const handle = top.handle && typeof top.handle === "object" ? pickKeys(top.handle, HANDLE_KEYS) : top.handle;
  const attachments = Array.isArray(top.attachments) ? slimAttachments(top.attachments) : top.attachments;
  if (handle === top.handle && attachments === top.attachments) return top;
  // Existing keys keep their position when reassigned, so order is unchanged.
  const out = { ...top };
  if (handle !== top.handle) out.handle = handle;
  if (attachments !== top.attachments) out.attachments = attachments;
  return out;
}

// Stored message lists are replaced, never mutated, so a list that survives
// from one flush to the next is slimmed only once.
const slimMessageLists = new WeakMap<Message[], Message[]>();

function slimMessageList(list: Message[]): Message[] {
  const hit = slimMessageLists.get(list);
  if (hit) return hit;
  const capped = list.length > MAX_CACHED_MESSAGES ? list.slice(-MAX_CACHED_MESSAGES) : list;
  let changed = capped !== list;
  const slim = capped.map((m) => {
    const s = slimMessage(m);
    if (s !== m) changed = true;
    return s;
  });
  const out = changed ? slim : list;
  slimMessageLists.set(list, out);
  return out;
}

/**
 * The persisted slice as it goes to disk: chats slimmed for the cold-start
 * list, each chat's messages capped and slimmed. Runs once per flush. Chats are
 * re-slimmed every time (cheap) rather than memoized per object, because
 * enrichChatActivity updates chat objects in place.
 */
function slimPersistedValue(value: PersistedValue): PersistedValue {
  const st = value.state;
  const messages = st.messages as Record<string, Message[]>;
  return {
    ...value,
    state: {
      ...st,
      chats: (st.chats as Chat[]).map(slimChat),
      messages: Object.fromEntries(
        Object.entries(messages).map(([k, v]) => [k, slimMessageList(v)])
      ),
    },
  };
}

/** Slim a chat for persistence — enough to render the list on cold start. */
function slimChat(c: Chat): Chat {
  return {
    guid: c.guid,
    displayName: c.displayName,
    chatIdentifier: c.chatIdentifier,
    participants: (c.participants ?? []).map((p) => ({
      address: p.address,
      firstName: p.firstName,
    })),
    lastMessage: c.lastMessage
      ? ({ dateCreated: c.lastMessage.dateCreated, text: c.lastMessage.text } as Message)
      : null,
    unreadCount: c.unreadCount,
    lastMessageText: c.lastMessageText,
    activityAt: c.activityAt,
    avatarUrl: c.avatarUrl,
    slackSection: c.slackSection,
  } as Chat;
}

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      serverUrl: "",
      password: "",
      isConfigured: false,
      configLoaded: false,
      onboardingDismissed: false,
      launchOnLogin: false,
      networkOnline: true,
      connectionNotice: null,
      superlightMode: false,
      showTimestamps: true,
      showAvatars: true,
      aiReply: {
        // Local-dev defaults (own GPU box) — harmless elsewhere: if the
        // endpoint isn't reachable the AI features just stay silent.
        endpoint: "http://gpulab:11434/v1",
        apiKey: "",
        model: "gemma3:12b",
        systemPrompt:
          "You are replying as me in a personal chat. Match my tone and language, keep replies short and natural, never mention being an AI.",
        cooldownSeconds: 10,
        maxConsecutive: 10,
        selfCritique: true,
        otlpEndpoint: "",
        emojiMode: "auto",
        tone: { humor: 0, sarcasm: 0, warmth: 0, energy: 0, formality: 0 },
      },
      aiReplyChats: {},
      aiDrafts: {},
      sidebarHidden: false,
      appearance: DEFAULT_APPEARANCE,
      linkPreviewsEnabled: true,

      chats: [],
      telegramAvailable: false,
      slackAvailable: false,
      accountLabels: {},
      collapsedAccounts: [],
      starredChats: [],
      slackReloadNonce: 0,
      slackSelfUserIds: {},
      slackUserNames: {},
      telegramPresence: {},
      telegramReloadNonce: 0,
      paneTree: EMPTY_LEAF,
      activePaneId: EMPTY_LEAF.id,
      paneLayouts: {},

      selectedChatGUID: null,
      focusedPaneId: null,
      chatQuery: "",
      messages: {},
      messageOrder: [],
      replyTarget: {},
      messageFetchedAt: {},
      linkPreviewCache: {},

      loadingChats: false,
      loadingMessages: false,
      wsConnected: false,
      pollingFallback: false,
      hydrated: false,
      error: null,
      typingChats: {},

      setTyping: (chatGUID, display) =>
        set((s) => {
          // Every incoming socket message clears typing for its chat; most had
          // none, and a no-op set still costs a full listener pass.
          if (!display && !(chatGUID in s.typingChats)) return s;
          const next = { ...s.typingChats };
          if (display) {
            next[chatGUID] = Date.now() + 8000;
          } else {
            delete next[chatGUID];
          }
          return { typingChats: next };
        }),

      setConfig: (serverUrl, password) =>
        set({ serverUrl, password, isConfigured: !!(serverUrl && password) }),

      clearConfig: () =>
        set({
          serverUrl: "",
          password: "",
          isConfigured: false,
          chats: [],
          messages: {},
          messageOrder: [],
          messageFetchedAt: {},
          paneTree: EMPTY_LEAF,
          activePaneId: EMPTY_LEAF.id,
          paneLayouts: {},
          selectedChatGUID: null,
        }),

      dismissOnboarding: () => set({ onboardingDismissed: true }),

      setConfigLoaded: (v) => set({ configLoaded: v }),
      setLaunchOnLogin: (v) => set({ launchOnLogin: v }),
      setNetworkOnline: (v) => set({ networkOnline: v }),
      setConnectionNotice: (v) => set({ connectionNotice: v }),
      setSuperlightMode: (v) => set({ superlightMode: v }),
      setShowTimestamps: (v) => set({ showTimestamps: v }),
      setShowAvatars: (v) => set({ showAvatars: v }),
      setAiReplyConfig: (patch) => set((s) => ({ aiReply: { ...s.aiReply, ...patch } })),
      // off -> draft -> auto -> off (legacy `true` counts as draft)
      cycleAiReplyChat: (guid) =>
        set((s) => {
          const next = { ...s.aiReplyChats };
          const cur = next[guid] === true ? "draft" : next[guid];
          if (!cur) next[guid] = "draft";
          else if (cur === "draft") next[guid] = "auto";
          else delete next[guid];
          return { aiReplyChats: next };
        }),
      setAiDraft: (guid, draft) =>
        set((s) => ({ aiDrafts: { ...s.aiDrafts, [guid]: draft } })),
      markAiDraftUsed: (guid) =>
        set((s) => {
          const cur = s.aiDrafts[guid];
          if (!cur) return {};
          return { aiDrafts: { ...s.aiDrafts, [guid]: { ...cur, usedAt: Date.now() } } };
        }),
      clearAiDraft: (guid) =>
        set((s) => {
          if (!(guid in s.aiDrafts)) return {};
          const next = { ...s.aiDrafts };
          delete next[guid];
          return { aiDrafts: next };
        }),
      setSidebarHidden: (v) => set({ sidebarHidden: v }),
      toggleSidebarHidden: () => set((s) => ({ sidebarHidden: !s.sidebarHidden })),
      setFontScale: (value) =>
        set((s) => ({
          appearance: { ...s.appearance, fontScale: clampFontScale(value) },
        })),
      increaseFontScale: () =>
        set((s) => ({
          appearance: {
            ...s.appearance,
            fontScale: clampFontScale(s.appearance.fontScale + FONT_SCALE_STEP),
          },
        })),
      decreaseFontScale: () =>
        set((s) => ({
          appearance: {
            ...s.appearance,
            fontScale: clampFontScale(s.appearance.fontScale - FONT_SCALE_STEP),
          },
        })),
      resetFontScale: () =>
        set((s) => ({
          appearance: { ...s.appearance, fontScale: DEFAULT_APPEARANCE.fontScale },
        })),
      setFontFamily: (value) =>
        set((s) => ({
          appearance: {
            ...s.appearance,
            fontFamily: value,
          },
        })),
      setThemeToken: (mode, token, value) =>
        set((s) => ({
          appearance: {
            ...s.appearance,
            themeOverrides: {
              ...s.appearance.themeOverrides,
              [mode]: {
                ...s.appearance.themeOverrides[mode],
                [token]: value,
              },
            },
          },
        })),
      resetThemeOverrides: (mode) =>
        set((s) => {
          if (!mode) {
            return {
              appearance: {
                ...s.appearance,
                fontFamily: DEFAULT_APPEARANCE.fontFamily,
                themeOverrides: {},
              },
            };
          }
          const rest = { ...s.appearance.themeOverrides };
          delete rest[mode];
          return {
            appearance: {
              ...s.appearance,
              themeOverrides: rest,
            },
          };
        }),
      setLinkPreviewsEnabled: (value) => set({ linkPreviewsEnabled: value }),
      setLinkPreview: (url, preview) =>
        set((s) => {
          const entries = Object.entries({
            ...s.linkPreviewCache,
            [url]: preview,
          })
            .sort(([, a], [, b]) => b.fetchedAt - a.fetchedAt)
            .slice(0, MAX_CACHED_LINK_PREVIEWS);

          return { linkPreviewCache: Object.fromEntries(entries) };
        }),
      clearLinkPreviewCache: () => set({ linkPreviewCache: {} }),

      selectChat: (guid) => {
        if (guid === null) {
          const { paneTree, activePaneId } = get();
          const tree = setLeafChat(paneTree, activePaneId, null);
          set({ paneTree: tree, selectedChatGUID: null });
          return;
        }
        get().openChatInActivePane(guid);
      },

      openChatInActivePane: (guid) => {
        const { paneTree, activePaneId, chats } = get();
        // Keep the list itself when nothing was unread, so opening a chat
        // doesn't hand the sidebar a new array.
        const nextChats = chats.some((c) => c.guid === guid && c.unreadCount > 0)
          ? chats.map((c) =>
              c.guid === guid && c.unreadCount > 0 ? { ...c, unreadCount: 0 } : c
            )
          : chats;
        const existing = findLeafByChat(paneTree, guid);
        if (existing && existing.type === "leaf") {
          set((s) => ({
            activePaneId: existing.id,
            selectedChatGUID: guid,
            chats: nextChats,
            // In focus mode, follow the chat to the pane that already shows it.
            focusedPaneId: s.focusedPaneId ? existing.id : null,
          }));
          return;
        }
        const tree = setLeafChat(paneTree, activePaneId, guid);
        set({ paneTree: tree, selectedChatGUID: guid, chats: nextChats });
      },

      setPaneChat: (paneId, guid) => {
        const { paneTree } = get();
        const leaf = findLeaf(paneTree, paneId);
        if (!leaf || leaf.type !== "leaf") return;
        const tree = setLeafChat(paneTree, paneId, guid);
        set({
          paneTree: tree,
          activePaneId: paneId,
          selectedChatGUID: deriveSelectedChat(tree, paneId),
        });
      },

      setActivePane: (paneId) => {
        const { paneTree, activePaneId } = get();
        if (paneId === activePaneId) return;
        const leaf = findLeaf(paneTree, paneId);
        if (!leaf || leaf.type !== "leaf") return;
        set({ activePaneId: paneId, selectedChatGUID: deriveSelectedChat(paneTree, paneId) });
      },

      splitPane: (paneId, direction, chatGUID = null) => {
        const base = ensurePaneState(get().paneTree, get().activePaneId);
        const target = findLeaf(base.tree, paneId);
        if (!target || target.type !== "leaf") return;
        const stats = paneTreeStats(base.tree);
        if (stats.leaves >= MAX_PANE_LEAVES || stats.depth >= MAX_PANE_DEPTH) return;
        const { tree, newLeafId } = splitLeaf(base.tree, paneId, direction, chatGUID);
        set({
          paneTree: tree,
          activePaneId: newLeafId,
          focusedPaneId: null,
          selectedChatGUID: deriveSelectedChat(tree, newLeafId),
        });
      },

      appendPane: (chatGUID = null) => {
        const base = ensurePaneState(get().paneTree, get().activePaneId);
        const stats = paneTreeStats(base.tree);
        if (stats.leaves >= MAX_PANE_LEAVES || stats.depth >= MAX_PANE_DEPTH) return;
        const newLeafId = uid("pane");
        const splitId = uid("split");
        const tree: PaneNode = {
          type: "split",
          id: splitId,
          direction: "horizontal",
          children: [base.tree, { type: "leaf", id: newLeafId, chatGUID }],
        };
        // Give the new column an equal share instead of half the board.
        const cols = countColumns(base.tree);
        set((s) => ({
          paneTree: tree,
          activePaneId: newLeafId,
          focusedPaneId: null,
          selectedChatGUID: deriveSelectedChat(tree, newLeafId),
          paneLayouts: {
            ...s.paneLayouts,
            [splitId]: sanitizeLayoutPair([cols * 100, 100]),
          },
        }));
      },

      setFocusedPane: (paneId) => {
        if (paneId !== null && !findLeaf(get().paneTree, paneId)) return;
        set({ focusedPaneId: paneId });
        if (paneId) get().setActivePane(paneId);
      },

      setChatQuery: (q) => set({ chatQuery: q }),

      closePane: (paneId) => {
        const { paneTree, activePaneId, paneLayouts } = get();
        if (!findLeaf(paneTree, paneId)) return;
        const { tree, nextActiveId } = removeLeaf(paneTree, paneId);
        const closedActive = paneId === activePaneId;
        const activeStillExists = !closedActive && !!findLeaf(tree, activePaneId);
        const newActive = activeStillExists ? activePaneId : nextActiveId;
        set((s) => ({
          paneTree: tree,
          activePaneId: newActive,
          selectedChatGUID: deriveSelectedChat(tree, newActive),
          paneLayouts: pruneLayouts(paneLayouts, tree),
          focusedPaneId: s.focusedPaneId === paneId ? null : s.focusedPaneId,
        }));
      },

      // Each resizable group reports its layout from a layout effect when it
      // mounts, i.e. the sizes it was just given. Writing those back rendered
      // the board once more before first paint, so an unchanged layout (to
      // the panels library's own 0.001 precision) is not written.
      setPaneLayout: (groupId, sizes) =>
        set((s) => {
          const next = sanitizeLayoutPair(sizes);
          const prev = s.paneLayouts[groupId];
          if (
            prev &&
            Math.abs(prev[0] - next[0]) < PANE_LAYOUT_EPSILON &&
            Math.abs(prev[1] - next[1]) < PANE_LAYOUT_EPSILON
          ) {
            return s;
          }
          return { paneLayouts: { ...s.paneLayouts, [groupId]: next } };
        }),

      repairPaneState: () => {
        const base = ensurePaneState(get().paneTree, get().activePaneId);
        const cleanedLayouts = pruneLayouts(
          sanitizePaneLayouts(get().paneLayouts),
          base.tree
        );
        set({
          paneTree: base.tree,
          activePaneId: base.activePaneId,
          selectedChatGUID: deriveSelectedChat(base.tree, base.activePaneId),
          paneLayouts: cleanedLayouts,
        });
      },

      // Replace one source's slice of the unified list, leaving every other
      // source untouched. Scales to any number of sources — adding one needs no
      // change here (unlike per-source setters, which each had to know about
      // every other source).
      //
      // A reloaded chat that renders the same keeps its stored object, and a
      // reload that changes nothing keeps the list itself. When the caller
      // hands back objects that are already stored (enrichChatActivity, which
      // updated them in place), the list is always replaced, as before.
      setChatsForSource: (source, sourceChats) =>
        set((s) => {
          const stored = new Map(s.chats.map((c) => [c.guid, c]));
          const openChats = collectOpenChatGuids(s.paneTree);
          let alreadyStored = false;
          const incoming = sourceChats.map((chat) => {
            const prev = stored.get(chat.guid);
            if (prev === chat) alreadyStored = true;
            return reuseChat(prev, chat, openChats);
          });
          const next = sortChatsByRecency([
            ...s.chats.filter((c) => sourceOfGuid(c.guid) !== source),
            ...incoming,
          ]);
          return !alreadyStored && sameChatList(next, s.chats) ? s : { chats: next };
        }),

      setChats: (chats) => get().setChatsForSource("imessage", chats),
      setTelegramChats: (tgChats) => get().setChatsForSource("telegram", tgChats),

      setTelegramAvailable: (v) => set({ telegramAvailable: v }),
      setSlackChats: (slChats) => get().setChatsForSource("slack", slChats),
      setSlackAvailable: (v) => set({ slackAvailable: v }),
      reloadSlack: () => set((s) => ({ slackReloadNonce: s.slackReloadNonce + 1 })),
      setSlackSelfUserId: (workspaceId, userId) =>
        set((s) => ({ slackSelfUserIds: { ...s.slackSelfUserIds, [workspaceId]: userId } })),

      setSlackUserNames: (workspaceId, names) =>
        set((s) => ({
          slackUserNames: {
            ...s.slackUserNames,
            [workspaceId]: { ...s.slackUserNames[workspaceId], ...names },
          },
        })),

      setAccountLabel: (key, label) =>
        set((s) =>
          s.accountLabels[key] === label
            ? s
            : { accountLabels: { ...s.accountLabels, [key]: label } }
        ),
      toggleAccountCollapsed: (key) =>
        set((s) => ({
          collapsedAccounts: s.collapsedAccounts.includes(key)
            ? s.collapsedAccounts.filter((k) => k !== key)
            : [...s.collapsedAccounts, key],
        })),
      toggleStarred: (guid) =>
        set((s) => ({
          starredChats: s.starredChats.includes(guid)
            ? s.starredChats.filter((g) => g !== guid)
            : [...s.starredChats, guid],
        })),

      reloadTelegram: () =>
        set((s) => ({ telegramReloadNonce: s.telegramReloadNonce + 1 })),

      // Presence ticks often repeat the same state; don't re-render the pane
      // header for those.
      setTelegramPresence: (guid, presence) =>
        set((s) => {
          const prev = s.telegramPresence[guid];
          if (prev && prev.online === presence.online && prev.lastSeen === presence.lastSeen) return s;
          return { telegramPresence: { ...s.telegramPresence, [guid]: presence } };
        }),

      // Replace or insert a single chat (any source), keeping the list sorted.
      upsertChat: (chat) => get().upsertChats([chat]),

      // Replace or insert chats in arrival order, with one sort and one commit
      // for the whole batch. The result is the list that upserting them one by
      // one leaves: the last write per guid wins, and chats that tie on
      // recency end up in the order of their last arrival. A chat that renders
      // the same keeps its stored object, and if nothing changed at all (the
      // usual case when Telegram re-announces what tg.chatList just loaded) the
      // list is left alone.
      upsertChats: (chats) =>
        set((s) => {
          if (chats.length === 0) return s;
          const latest = new Map<string, Chat>();
          for (const chat of chats) {
            latest.delete(chat.guid);
            latest.set(chat.guid, chat);
          }
          const stored = new Map(s.chats.map((c) => [c.guid, c]));
          const openChats = collectOpenChatGuids(s.paneTree);
          let alreadyStored = false;
          const incoming = [...latest.values()].map((chat) => {
            const prev = stored.get(chat.guid);
            if (prev === chat) alreadyStored = true;
            return reuseChat(prev, chat, openChats);
          });
          const next = sortChatsByRecency([
            ...s.chats.filter((c) => !latest.has(c.guid)),
            ...incoming,
          ]);
          return !alreadyStored && sameChatList(next, s.chats) ? s : { chats: next };
        }),

      setMessages: (chatGUID, messages) => {
        const capped = capMessages(messages);
        const newest = capped[capped.length - 1]?.dateCreated ?? 0;
        set((s) =>
          pruneMessageCache(s.paneTree, chatGUID, {
            messages: { ...s.messages, [chatGUID]: capped },
            messageFetchedAt: { ...s.messageFetchedAt, [chatGUID]: newest },
            messageOrder: s.messageOrder,
          })
        );
      },

      mergeMessages: (chatGUID, newMessages) => {
        if (newMessages.length === 0) return;
        const existing = get().messages[chatGUID] ?? [];
        const merged = mergeMessageList(existing, newMessages);
        const newest = merged[merged.length - 1]?.dateCreated ?? 0;
        set((s) =>
          pruneMessageCache(s.paneTree, chatGUID, {
            messages: { ...s.messages, [chatGUID]: merged },
            messageFetchedAt: { ...s.messageFetchedAt, [chatGUID]: newest },
            messageOrder: s.messageOrder,
          })
        );
      },

      upsertMessage: (message) => {
        const chatGUID = message.chatGUID ?? "";
        if (!chatGUID) return;
        const existing = get().messages[chatGUID] ?? [];
        const updated = mergeMessageList(existing, [message]);
        // messageFetchedAt doubles as the polling cursor (`after=`), and it only
        // ever moves forward. Optimistic messages carry the *client* clock, so
        // letting one set the cursor would — on a machine running ahead of the
        // server — permanently hide every message that follows. Only
        // server-acknowledged messages may advance it.
        // Note: not isLocalOptimisticMessage — that counts any tempGuid as
        // local, and the server's echo carries the tempGuid too (that is how it
        // is matched). Only the unsent `local-` placeholder must be skipped.
        const newest = updated.reduce(
          (max, m) => (m.guid.startsWith("local-") ? max : Math.max(max, m.dateCreated)),
          0
        );
        set((s) => {
          const idx = s.chats.findIndex((c) => c.guid === chatGUID);
          let nextChats = s.chats;
          if (idx !== -1) {
            const chat = s.chats[idx];
            const prevLatest = chat.activityAt ?? chat.lastMessage?.dateCreated ?? 0;
            const isNewLatest = !!message.text && message.dateCreated > prevLatest;
            // Receipts, echoes and Telegram's message_added after its
            // chat_updated mostly carry the preview the chat already shows;
            // those keep the chat (and the list) as they are.
            const updatedChat = isNewLatest
              ? {
                  ...chat,
                  lastMessageText: message.text,
                  lastMessage: message,
                  activityAt: message.dateCreated,
                }
              : message.text &&
                (message.text !== chat.lastMessageText ||
                  showsRelativeTime(chat, collectOpenChatGuids(s.paneTree)))
              ? { ...chat, lastMessageText: message.text }
              : chat;
            if (isNewLatest && idx > 0) {
              nextChats = [
                updatedChat,
                ...s.chats.slice(0, idx),
                ...s.chats.slice(idx + 1),
              ];
            } else if (updatedChat !== chat) {
              nextChats = s.chats.map((c) => (c.guid === chatGUID ? updatedChat : c));
            }
          }
          const pruned = pruneMessageCache(s.paneTree, chatGUID, {
            messages: { ...s.messages, [chatGUID]: updated },
            messageFetchedAt: {
              ...s.messageFetchedAt,
              [chatGUID]: Math.max(s.messageFetchedAt[chatGUID] ?? 0, newest),
            },
            messageOrder: s.messageOrder,
          });
          return { ...pruned, chats: nextChats };
        });
      },

      removeMessage: (chatGUID, guid) =>
        set((s) => ({
          messages: {
            ...s.messages,
            [chatGUID]: (s.messages[chatGUID] ?? []).filter((m) => m.guid !== guid),
          },
        })),

      replaceMessage: (chatGUID, oldGuid, message) => {
        const existing = get().messages[chatGUID] ?? [];
        const next = existing.map((m) => (m.guid === oldGuid ? message : m));
        set((s) => ({ messages: { ...s.messages, [chatGUID]: next } }));
      },

      markChatHasNewMessage: (chatGUID) =>
        set((s) => ({
          chats: s.chats.map((c) =>
            c.guid === chatGUID
              ? { ...c, unreadCount: (Number.isFinite(c.unreadCount) ? c.unreadCount : 0) + 1 }
              : c
          ),
        })),

      // Focusing a pane that shows the chat counts as reading it — clearing
      // must not require re-selecting the chat from the sidebar.
      markChatViewed: (chatGUID) =>
        set((s) =>
          s.chats.some((c) => c.guid === chatGUID && c.unreadCount > 0)
            ? {
                chats: s.chats.map((c) =>
                  c.guid === chatGUID ? { ...c, unreadCount: 0 } : c
                ),
              }
            : s
        ),

      // Usually follows an upsertMessage that already set this text.
      updateChatPreview: (chatGUID, text) =>
        set((s) => {
          const openChats = collectOpenChatGuids(s.paneTree);
          const needsWrite = (c: Chat) =>
            c.guid === chatGUID &&
            (c.lastMessageText !== text || showsRelativeTime(c, openChats));
          return s.chats.some(needsWrite)
            ? {
                chats: s.chats.map((c) =>
                  needsWrite(c) ? { ...c, lastMessageText: text } : c
                ),
              }
            : s;
        }),

      // Every send clears the target, which usually was not set. Readers treat
      // a missing entry as null.
      setReplyTarget: (chatGUID, message) =>
        set((s) =>
          (s.replyTarget[chatGUID] ?? null) === message
            ? s
            : { replyTarget: { ...s.replyTarget, [chatGUID]: message } }
        ),

      setLoadingChats: (v) => set({ loadingChats: v }),
      setLoadingMessages: (v) => set((s) => (s.loadingMessages === v ? s : { loadingMessages: v })),
      setWsConnected: (v) => set({ wsConnected: v }),
      setPollingFallback: (v) => set({ pollingFallback: v }),
      setHydrated: (v) => set({ hydrated: v }),
      setError: (e) => set({ error: e }),
    }),
    {
      name: "imessage-cache",
      onRehydrateStorage: () => (state) => {
        state?.repairPaneState();
        state?.setHydrated(true);
      },
      // Shallow merge like the default, but backfill empty AI endpoint/model
      // with the current defaults — stores persisted before those defaults
      // existed would otherwise pin them to "" forever.
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<AppState>;
        const merged = { ...current, ...p } as AppState;
        // Stores saved before the Geist redesign pinned the old system-font
        // default; only a font the user actually picked should survive.
        if (merged.appearance?.fontFamily === LEGACY_DEFAULT_FONT_FAMILY) {
          merged.appearance = { ...merged.appearance, fontFamily: current.appearance.fontFamily };
        }
        merged.aiReply = {
          ...current.aiReply,
          ...(p.aiReply ?? {}),
          endpoint: p.aiReply?.endpoint?.trim() ? p.aiReply.endpoint : current.aiReply.endpoint,
          model: p.aiReply?.model?.trim() ? p.aiReply.model : current.aiReply.model,
        };
        return merged;
      },
      // Cast: our storage debounces above the JSON layer (see debouncedStorage).
      storage: debouncedStorage as PersistStorage<Record<string, unknown>> as never,
      partialize: (s) => ({
        superlightMode: s.superlightMode,
        showTimestamps: s.showTimestamps,
        showAvatars: s.showAvatars,
        aiReply: s.aiReply,
        aiReplyChats: s.aiReplyChats,
        onboardingDismissed: s.onboardingDismissed,
        sidebarHidden: s.sidebarHidden,
        appearance: s.appearance,
        linkPreviewsEnabled: s.linkPreviewsEnabled,
        linkPreviewCache: s.linkPreviewCache,
        // References only: slimming happens once per write, in
        // slimPersistedValue, and unchanged references skip the write.
        chats: s.chats,
        paneTree: s.paneTree,
        activePaneId: s.activePaneId,
        paneLayouts: s.paneLayouts,
        messages: s.messages,
        messageOrder: s.messageOrder,
        messageFetchedAt: s.messageFetchedAt,
        accountLabels: s.accountLabels,
        collapsedAccounts: s.collapsedAccounts,
        starredChats: s.starredChats,
      }),
    }
  )
);

/** Normalized AI mode for a chat ("off" | "draft" | "auto"); legacy `true` = draft. */
export function aiModeFor(
  chats: Record<string, "draft" | "auto" | true>,
  guid: string
): "off" | "draft" | "auto" {
  const v = chats[guid];
  if (!v) return "off";
  return v === true ? "draft" : v;
}
