// AI simulator — a sandboxed chat with your own autopilot. You play the
// contact (your messages arrive as "incoming"), the personality engine replies
// as you, using the same layered prompt as real chats — but nothing is ever
// sent anywhere. Doubles as an analysis bench: per-reply latency and a prompt
// inspector showing exactly what the model was given.

import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { FlaskConical, Trash2, ArrowUp, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useAppStore } from "@/store/useAppStore";
import { generateReply, buildSystemPrompt, critiqueReply, critiqueFails, type Critique } from "@/lib/aiReply";
import { loadAiProfiles, type AiProfiles } from "@/lib/aiProfiles";
import { loadSummary, type AiSummary } from "@/lib/aiTelemetry";
import { cn } from "@/lib/utils";
import type { Message } from "@/types";

interface IndexEntry {
  guid: string;
  name: string;
  sentCount: number;
}

interface SimMessage {
  fromMe: boolean; // true = the autopilot ("you"), false = you playing the contact
  text: string;
  at: number;
  latencyMs?: number;
  critique?: Critique | null;
  rewritten?: boolean;
}

export function AiSimulatorDialog() {
  const aiReply = useAppStore((s) => s.aiReply);
  const configured = aiReply.endpoint.trim().length > 0 && aiReply.model.trim().length > 0;

  const [open, setOpen] = useState(false);
  const [profiles, setProfiles] = useState<IndexEntry[]>([]);
  const [selected, setSelected] = useState<string>("global");
  const [msgs, setMsgs] = useState<SimMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [lastPrompt, setLastPrompt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<AiSummary | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    void loadSummary().then(setSummary).catch(() => setSummary(null));
    invoke<string | null>("ai_relationship_index")
      .then((raw) => {
        const parsed = raw ? (JSON.parse(raw) as { relationships?: IndexEntry[] }) : null;
        setProfiles(parsed?.relationships ?? []);
      })
      .catch(() => setProfiles([]));
  }, [open]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [msgs, busy]);

  const selectedEntry = profiles.find((p) => p.guid === selected);
  const contactName = selectedEntry?.name ?? "Simulated contact";

  function reset() {
    setMsgs([]);
    setLastPrompt(null);
    setError(null);
  }

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setError(null);
    const next = [...msgs, { fromMe: false, text, at: Date.now() }];
    setMsgs(next);
    setBusy(true);

    try {
      const aiProfiles: AiProfiles = await loadAiProfiles(
        selected === "global" ? "sim:none" : selected
      );
      // The engine sees the sim thread exactly like a real conversation.
      const history: Message[] = next.map((m, i) => ({
        guid: `sim-${i}`,
        text: m.text,
        isFromMe: m.fromMe,
        dateCreated: m.at,
        handle: null,
        attachments: [],
        associatedMessageGuid: "",
        associatedMessageType: "",
        chatGUID: "sim",
      }));
      setLastPrompt(buildSystemPrompt(aiReply.systemPrompt, contactName, aiProfiles));
      const t0 = performance.now();
      const first = await generateReply(aiReply, history, contactName, aiProfiles);
      if (!first) {
        setError("The model returned nothing usable.");
        return;
      }
      // Show what the critic thought — the simulator is where you tune it.
      let final = first.text;
      let critique: Critique | null = null;
      let rewritten = false;
      if (aiReply.selfCritique) {
        critique = await critiqueReply(aiReply, first.systemPrompt, history, first.text);
        if (critique && critiqueFails(critique)) {
          const second = await generateReply(
            aiReply, history, contactName, aiProfiles, critique.notes
          );
          if (second) {
            final = second.text;
            rewritten = true;
          }
        }
      }
      const latencyMs = Math.round(performance.now() - t0);
      setMsgs((cur) => [
        ...cur,
        { fromMe: true, text: final, at: Date.now(), latencyMs, critique, rewritten },
      ]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!configured) return null;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-muted-foreground"
          aria-label="AI simulator"
          title="AI simulator — chat with your autopilot, nothing is sent"
        >
          <FlaskConical className="h-4 w-4" />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg gap-3">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <FlaskConical className="h-4 w-4 text-primary" /> AI simulator
          </DialogTitle>
        </DialogHeader>
        <p className="text-xs text-muted-foreground -mt-2">
          You write as the contact — the autopilot answers as you. Nothing leaves this window.
        </p>

        <div className="flex items-center gap-2">
          <select
            className="h-8 flex-1 rounded-md border bg-transparent px-2 text-sm"
            value={selected}
            onChange={(e) => {
              setSelected(e.target.value);
              reset();
            }}
          >
            <option value="global">Global style (no relationship)</option>
            {profiles.map((p) => (
              <option key={p.guid} value={p.guid}>
                {p.name} ({p.sentCount} sent)
              </option>
            ))}
          </select>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-muted-foreground"
            onClick={reset}
            aria-label="Clear conversation"
            title="Clear conversation"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>

        <div
          ref={scrollRef}
          className="h-72 overflow-y-auto rounded-lg border bg-muted/20 p-3 space-y-2"
        >
          {msgs.length === 0 && (
            <p className="text-xs text-muted-foreground text-center pt-24">
              Write something as {contactName} to see how your autopilot answers.
            </p>
          )}
          {msgs.map((m, i) => (
            <div key={i} className={cn("flex flex-col", m.fromMe ? "items-end" : "items-start")}>
              <div
                className={cn(
                  "max-w-[80%] rounded-2xl px-3 py-1.5 text-sm whitespace-pre-wrap",
                  m.fromMe ? "bg-primary text-primary-foreground" : "bg-muted"
                )}
              >
                {m.text}
              </div>
              {m.latencyMs !== undefined && (
                <span className="mt-0.5 text-[10px] text-muted-foreground">
                  {m.latencyMs} ms
                  {m.critique && (
                    <>
                      {" · "}me {m.critique.soundsLikeMe}/10 · fit {m.critique.fitsRecipient}/10
                      {m.rewritten && " · rewritten"}
                    </>
                  )}
                </span>
              )}
            </div>
          ))}
          {busy && (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" /> autopilot is typing…
            </div>
          )}
        </div>

        {error && <p className="text-xs text-destructive">{error}</p>}

        <div className="flex items-end gap-2">
          <textarea
            rows={1}
            className="flex-1 resize-none rounded-md border bg-transparent px-3 py-2 text-sm"
            placeholder={`Write as ${contactName}…`}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <Button
            size="icon"
            className="h-9 w-9 shrink-0"
            disabled={busy || !input.trim()}
            onClick={() => void send()}
            aria-label="Send"
          >
            <ArrowUp className="h-4 w-4" />
          </Button>
        </div>

        {summary && summary.generated > 0 && (
          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground">
              Reply stats — {summary.generated} drafts, {Math.round(summary.acceptRate * 100)}% sent
              unedited
            </summary>
            <div className="mt-2 space-y-1.5 rounded-md border bg-muted/30 p-2 text-[11px]">
              <div className="grid grid-cols-4 gap-2 text-center">
                {[
                  ["accepted", summary.accepted],
                  ["edited", summary.edited],
                  ["rejected", summary.rejected],
                  ["auto-sent", summary.autoSent],
                ].map(([label, n]) => (
                  <div key={label as string}>
                    <div className="font-semibold text-foreground">{n as number}</div>
                    <div className="text-muted-foreground">{label as string}</div>
                  </div>
                ))}
              </div>
              <p className="text-muted-foreground">
                median latency {summary.medianLatencyMs} ms
                {summary.edited > 0 && (
                  <>
                    {" · "}edits change ~{summary.medianWordDiff} words
                    {summary.medianEditSeconds > 0 && <> in ~{summary.medianEditSeconds}s</>}
                  </>
                )}
              </p>
              {summary.rewriteEffect && (
                <p className="text-muted-foreground">
                  self-critique: {Math.round(summary.rewriteEffect.plain.acceptRate * 100)}% accepted
                  when it passed ({summary.rewriteEffect.plain.n}) vs{" "}
                  {Math.round(summary.rewriteEffect.rewritten.acceptRate * 100)}% after a rewrite (
                  {summary.rewriteEffect.rewritten.n})
                </p>
              )}
              {summary.byProfile.length > 0 && (
                <div className="space-y-0.5">
                  {summary.byProfile.map((p) => (
                    <div key={p.profile} className="flex justify-between gap-2">
                      <span className="truncate text-muted-foreground">{p.profile}</span>
                      <span className="shrink-0">
                        {Math.round(p.acceptRate * 100)}% of {p.reviewed}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </details>
        )}

        {lastPrompt && (
          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground">
              Prompt inspector — what the model was given
            </summary>
            <pre className="mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap rounded-md border bg-muted/30 p-2 text-[10px] leading-relaxed">
              {lastPrompt}
            </pre>
          </details>
        )}
      </DialogContent>
    </Dialog>
  );
}
