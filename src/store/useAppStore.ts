import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  DEFAULT_APPEARANCE,
  FONT_SCALE_STEP,
  clampFontScale,
  type AppearanceSettings,
  type ThemeMode,
  type ThemeTokenKey,
} from "@/lib/appearance";
import type { Chat, LinkPreview, Message } from "@/types";
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
  };
  // Per-chat AI mode: "draft" (suggestion lands in the composer, default) or
  // "auto" (sends by itself). Legacy persisted `true` means "draft".
  aiReplyChats: Record<string, "draft" | "auto" | true>;
  // Transient AI suggestions per chat (not persisted).
  aiDrafts: Record<string, string>;
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
  setTelegramAvailable: (v: boolean) => void;
  setTelegramChats: (chats: Chat[]) => void;
  upsertChat: (chat: Chat) => void;
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
  setAiDraft: (guid: string, text: string) => void;
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
  closePane: (paneId: string) => void;
  setPaneLayout: (groupId: string, sizes: number[]) => void;
  repairPaneState: () => void;

  setChats: (chats: Chat[]) => void;
  setMessages: (chatGUID: string, messages: Message[]) => void;
  mergeMessages: (chatGUID: string, newMessages: Message[]) => void;
  upsertMessage: (message: Message) => void;
  removeMessage: (chatGUID: string, guid: string) => void;
  replaceMessage: (chatGUID: string, oldGuid: string, message: Message) => void;
  markChatHasNewMessage: (chatGUID: string) => void;
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

// Unified inbox: Telegram chats live in the same `chats` array as iMessage
// chats, distinguished by a `tg:` GUID prefix. Each source updates only its
// own slice so the two never clobber each other, and the merged list is
// sorted by most-recent activity so conversations interleave by time.
const TG_GUID_PREFIX = "tg:";
export function isTelegramChatGuid(guid: string): boolean {
  return guid.startsWith(TG_GUID_PREFIX);
}
function chatActivity(chat: Chat): number {
  return chat.activityAt ?? chat.lastMessage?.dateCreated ?? 0;
}
function sortChatsByRecency(list: Chat[]): Chat[] {
  // Stable sort keeps each source's incoming order among equal/unknown times.
  return [...list].sort((a, b) => chatActivity(b) - chatActivity(a));
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
      },
      aiReplyChats: {},
      aiDrafts: {},
      sidebarHidden: false,
      appearance: DEFAULT_APPEARANCE,
      linkPreviewsEnabled: true,

      chats: [],
      telegramAvailable: false,
      telegramPresence: {},
      telegramReloadNonce: 0,
      paneTree: EMPTY_LEAF,
      activePaneId: EMPTY_LEAF.id,
      paneLayouts: {},

      selectedChatGUID: null,
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
      setAiDraft: (guid, text) =>
        set((s) => ({ aiDrafts: { ...s.aiDrafts, [guid]: text } })),
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
        const nextChats = chats.map((c) =>
          c.guid === guid && c.unreadCount > 0 ? { ...c, unreadCount: 0 } : c
        );
        const existing = findLeafByChat(paneTree, guid);
        if (existing && existing.type === "leaf") {
          set({ activePaneId: existing.id, selectedChatGUID: guid, chats: nextChats });
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
          selectedChatGUID: deriveSelectedChat(tree, newLeafId),
        });
      },

      closePane: (paneId) => {
        const { paneTree, activePaneId, paneLayouts } = get();
        if (!findLeaf(paneTree, paneId)) return;
        const { tree, nextActiveId } = removeLeaf(paneTree, paneId);
        const closedActive = paneId === activePaneId;
        const activeStillExists = !closedActive && !!findLeaf(tree, activePaneId);
        const newActive = activeStillExists ? activePaneId : nextActiveId;
        set({
          paneTree: tree,
          activePaneId: newActive,
          selectedChatGUID: deriveSelectedChat(tree, newActive),
          paneLayouts: pruneLayouts(paneLayouts, tree),
        });
      },

      setPaneLayout: (groupId, sizes) =>
        set((s) => ({ paneLayouts: { ...s.paneLayouts, [groupId]: sanitizeLayoutPair(sizes) } })),

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

      // iMessage source: replace all non-Telegram chats, keep Telegram ones.
      setChats: (chats) =>
        set((s) => ({
          chats: sortChatsByRecency([
            ...chats,
            ...s.chats.filter((c) => isTelegramChatGuid(c.guid)),
          ]),
        })),

      // Telegram source: replace all Telegram chats, keep iMessage ones.
      setTelegramChats: (tgChats) =>
        set((s) => ({
          chats: sortChatsByRecency([
            ...s.chats.filter((c) => !isTelegramChatGuid(c.guid)),
            ...tgChats,
          ]),
        })),

      setTelegramAvailable: (v) => set({ telegramAvailable: v }),

      reloadTelegram: () =>
        set((s) => ({ telegramReloadNonce: s.telegramReloadNonce + 1 })),

      setTelegramPresence: (guid, presence) =>
        set((s) => ({
          telegramPresence: { ...s.telegramPresence, [guid]: presence },
        })),

      // Replace or insert a single chat (any source), keeping the list sorted.
      upsertChat: (chat) =>
        set((s) => ({
          chats: sortChatsByRecency([
            ...s.chats.filter((c) => c.guid !== chat.guid),
            chat,
          ]),
        })),

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
        const newest = updated[updated.length - 1]?.dateCreated ?? 0;
        set((s) => {
          const idx = s.chats.findIndex((c) => c.guid === chatGUID);
          let nextChats = s.chats;
          if (idx !== -1) {
            const chat = s.chats[idx];
            const prevLatest = chat.activityAt ?? chat.lastMessage?.dateCreated ?? 0;
            const isNewLatest = !!message.text && message.dateCreated > prevLatest;
            const updatedChat = isNewLatest
              ? {
                  ...chat,
                  lastMessageText: message.text,
                  lastMessage: message,
                  activityAt: message.dateCreated,
                }
              : message.text
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
            c.guid === chatGUID ? { ...c, unreadCount: c.unreadCount + 1 } : c
          ),
        })),

      updateChatPreview: (chatGUID, text) =>
        set((s) => ({
          chats: s.chats.map((c) =>
            c.guid === chatGUID ? { ...c, lastMessageText: text } : c
          ),
        })),

      setReplyTarget: (chatGUID, message) =>
        set((s) => ({ replyTarget: { ...s.replyTarget, [chatGUID]: message } })),

      setLoadingChats: (v) => set({ loadingChats: v }),
      setLoadingMessages: (v) => set({ loadingMessages: v }),
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
        merged.aiReply = {
          ...current.aiReply,
          ...(p.aiReply ?? {}),
          endpoint: p.aiReply?.endpoint?.trim() ? p.aiReply.endpoint : current.aiReply.endpoint,
          model: p.aiReply?.model?.trim() ? p.aiReply.model : current.aiReply.model,
        };
        return merged;
      },
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
        chats: s.chats,
        paneTree: s.paneTree,
        activePaneId: s.activePaneId,
        paneLayouts: s.paneLayouts,
        messages: Object.fromEntries(
          Object.entries(s.messages).map(([k, v]) => [k, (v as Message[]).slice(-MAX_CACHED_MESSAGES)])
        ),
        messageOrder: s.messageOrder,
        messageFetchedAt: s.messageFetchedAt,
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
