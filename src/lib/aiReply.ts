// AI auto-reply: generate a reply to a conversation via an OpenAI-compatible
// chat-completions endpoint (vLLM, Ollama, llama.cpp server, …). Requests go
// through the Tauri HTTP plugin so a plain-HTTP LAN GPU box works from the
// desktop shell without webview ATS/CORS blocks.

import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { isTauriRuntime } from "@/lib/tauriEnv";
import type { Message } from "@/types";

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

/**
 * Ask the model for a reply to the conversation. Returns null when the model
 * has nothing usable to say (empty response) — the caller just skips replying.
 */
export async function generateReply(
  cfg: AiReplyConfig,
  history: Message[],
  chatName: string
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
          {
            role: "system",
            content: `${cfg.systemPrompt.trim()}\n\nConversation: "${chatName}".`,
          },
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
