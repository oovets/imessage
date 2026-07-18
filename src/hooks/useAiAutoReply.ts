// AI auto-reply engine. Watches chats the user has explicitly enabled; when an
// incoming message lands there, waits a beat (so bursts finish), asks the
// configured OpenAI-compatible endpoint for a reply in the user's voice, and
// sends it through the normal send paths (Telegram core / BlueBubbles, with
// merged-thread routing).
//
// Guardrails against runaway loops (e.g. two bots chatting):
//   - per-chat cooldown: at most one auto-reply per COOLDOWN_MS
//   - per-chat cap: after MAX_CONSECUTIVE auto-replies with no manual message
//     from the user, the chat goes quiet until the user writes something

import { useEffect, useRef } from "react";
import { useAppStore, isTelegramChatGuid, aiModeFor } from "@/store/useAppStore";
import { getClient } from "@/api/clientFactory";
import { generateReply } from "@/lib/aiReply";
import { loadAiProfiles } from "@/lib/aiProfiles";
import { log as logAi } from "@/lib/aiTelemetry";
import { preferredSendGuid } from "@/lib/chatThreadMerge";
import { tg } from "@/telegram/api";
import { parseTgChatGuid } from "@/telegram/adapters";
import { getChatDisplayName, type Message } from "@/types";

const DEBOUNCE_MS = 4_000;

interface ChatState {
  lastHandled: string | null;
  cooldownUntil: number;
  consecutive: number;
  timer: ReturnType<typeof setTimeout> | null;
  aiTexts: Set<string>;
}

export function useAiAutoReply() {
  const stateRef = useRef(new Map<string, ChatState>());

  useEffect(() => {
    const chatState = (guid: string): ChatState => {
      let st = stateRef.current.get(guid);
      if (!st) {
        st = { lastHandled: null, cooldownUntil: 0, consecutive: 0, timer: null, aiTexts: new Set() };
        stateRef.current.set(guid, st);
      }
      return st;
    };

    async function reply(guid: string) {
      const s = useAppStore.getState();
      const st = chatState(guid);
      st.timer = null;
      if (!s.aiReplyChats[guid]) return;

      const mode = aiModeFor(s.aiReplyChats, guid);
      const msgs = s.messages[guid] ?? [];
      const newest = msgs[msgs.length - 1];
      if (!newest || newest.isFromMe || newest.guid === st.lastHandled) return;
      st.lastHandled = newest.guid;

      // Guardrails apply to auto-send only — a draft sends nothing, so a fresh
      // suggestion per incoming message is exactly what we want.
      const cooldownMs = Math.max(0, s.aiReply.cooldownSeconds ?? 10) * 1000;
      const maxConsecutive = Math.max(0, s.aiReply.maxConsecutive ?? 10);
      if (mode === "auto") {
        if (cooldownMs > 0 && Date.now() < st.cooldownUntil) return;
        if (maxConsecutive > 0 && st.consecutive >= maxConsecutive) return;
      }

      const chat = s.chats.find((c) => c.guid === guid);
      const name = chat ? getChatDisplayName(chat) : "chat";
      // Layered personality prompt: global style + this relationship (cached).
      const profiles = await loadAiProfiles(guid).catch(() => null);
      const profileName = profiles?.relationship?.name ?? null;
      const t0 = performance.now();
      let text: string | null;
      try {
        text = await generateReply(s.aiReply, msgs, name, profiles);
      } catch (e) {
        s.setConnectionNotice(
          `AI auto-reply failed: ${e instanceof Error ? e.message : String(e)}`
        );
        return;
      }
      if (!text) return;
      const latencyMs = Math.round(performance.now() - t0);
      logAi({
        kind: "generated",
        chatGuid: guid,
        model: s.aiReply.model,
        profile: profileName,
        latencyMs,
        draftChars: text.length,
      });

      // Re-check the toggle — it may have been turned off while generating.
      const now = useAppStore.getState();
      const nowMode = aiModeFor(now.aiReplyChats, guid);
      if (nowMode === "off") return;

      // Draft mode (the default): put the suggestion in the composer and stop.
      if (nowMode === "draft") {
        now.setAiDraft(guid, {
          text,
          at: Date.now(),
          latencyMs,
          profile: profileName,
          model: s.aiReply.model,
        });
        return;
      }

      st.cooldownUntil = Date.now() + cooldownMs;
      st.consecutive += 1;
      st.aiTexts.add(text);
      if (st.aiTexts.size > 20) st.aiTexts.delete(st.aiTexts.values().next().value as string);

      logAi({
        kind: "auto_sent",
        chatGuid: guid,
        model: s.aiReply.model,
        profile: profileName,
        draftChars: text.length,
      });

      try {
        if (isTelegramChatGuid(guid)) {
          const { accountId, chatId } = parseTgChatGuid(guid);
          await tg.sendMessage(accountId, chatId, text, undefined);
        } else {
          const optimistic: Message = {
            guid: `local-${crypto.randomUUID()}`,
            tempGuid: crypto.randomUUID(),
            text,
            isFromMe: true,
            dateCreated: Date.now(),
            handle: null,
            attachments: [],
            associatedMessageGuid: "",
            associatedMessageType: "",
            chatGUID: guid,
          };
          now.upsertMessage(optimistic);
          now.updateChatPreview(guid, text);
          await getClient(now.serverUrl, now.password).sendMessage(
            preferredSendGuid(guid),
            text,
            "",
            optimistic.tempGuid
          );
        }
      } catch (e) {
        now.setConnectionNotice(
          `AI auto-reply could not send: ${e instanceof Error ? e.message : String(e)}`
        );
      }
    }

    // Zustand subscription fires on any state change; we do cheap diffing per
    // enabled chat and debounce the actual work.
    const unsubscribe = useAppStore.subscribe((s) => {
      const enabled = Object.keys(s.aiReplyChats);
      if (enabled.length === 0) return;
      if (!s.aiReply.endpoint.trim() || !s.aiReply.model.trim()) return;

      for (const guid of enabled) {
        const msgs = s.messages[guid];
        if (!msgs || msgs.length === 0) continue;
        const newest = msgs[msgs.length - 1];
        const st = chatState(guid);

        if (newest.isFromMe) {
          // A manual message from the user resets the consecutive-replies cap
          // (our own AI sends are recognized by text and don't reset it).
          if (newest.text && !st.aiTexts.has(newest.text)) st.consecutive = 0;
          continue;
        }
        if (newest.guid === st.lastHandled) continue;

        // New incoming message: (re)schedule a debounced reply.
        if (st.timer) clearTimeout(st.timer);
        st.timer = setTimeout(() => void reply(guid), DEBOUNCE_MS);
      }
    });

    const chatStates = stateRef.current;
    return () => {
      unsubscribe();
      for (const st of chatStates.values()) {
        if (st.timer) clearTimeout(st.timer);
      }
    };
  }, []);
}
