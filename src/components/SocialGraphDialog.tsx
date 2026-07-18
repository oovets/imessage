// Communication patterns per relationship (scripts/social-graph.mjs).
//
// Everything here is measured from both sides of real conversations, never
// inferred: who breaks silences, who answers faster, whose emoji rate is
// whose. Clusters come from embedding centroids — the model only named the
// groups, it didn't choose them.

import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Network, ArrowLeft } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface GraphNode {
  guid: string;
  name: string;
  source: "imessage" | "telegram" | "slack";
  messages: number;
  firstAt: number;
  lastAt: number;
  /** Share of messages that are mine; 0.5 is an even exchange. */
  balance: number;
  response: { mineSec: number | null; theirsSec: number | null };
  emoji: { mine: number; theirs: number };
  medianWords: { mine: number | null; theirs: number | null };
  language: { sv: number; en: number } | null;
  initiative: { openings: number; mineShare: number } | null;
  hours: number[];
  cluster: number | null;
}

interface Graph {
  generatedAt: number;
  clusters: { label: string; size: number }[];
  nodes: GraphNode[];
}

function duration(sec: number | null): string {
  if (sec === null) return "—";
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  return `${(sec / 3600).toFixed(1)}h`;
}

const SOURCE_DOT: Record<GraphNode["source"], string> = {
  imessage: "bg-green-500",
  telegram: "bg-sky-500",
  slack: "bg-violet-500",
};

/** A 0..1 share as a bar that reads left-to-right as "them ← → me". */
function SplitBar({ mine, label }: { mine: number; label: string }) {
  const pct = Math.round(mine * 100);
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-[10px] text-muted-foreground">
        <span>{label}</span>
        <span className="tabular-nums">
          {pct}% / {100 - pct}%
        </span>
      </div>
      <div className="flex h-1.5 overflow-hidden rounded-full bg-muted">
        <div className="bg-primary" style={{ width: `${pct}%` }} />
        <div className="bg-muted-foreground/30" style={{ width: `${100 - pct}%` }} />
      </div>
    </div>
  );
}

function HourBars({ hours }: { hours: number[] }) {
  const max = Math.max(...hours, 0.001);
  return (
    <div className="space-y-1">
      <div className="text-[10px] text-muted-foreground">Time of day</div>
      <div className="flex h-10 items-end gap-px">
        {hours.map((h, i) => (
          <div
            key={i}
            title={`${i}:00 — ${Math.round(h * 100)}%`}
            className="flex-1 rounded-sm bg-primary/70"
            style={{ height: `${Math.max(4, (h / max) * 100)}%` }}
          />
        ))}
      </div>
      <div className="flex justify-between text-[9px] text-muted-foreground">
        <span>00</span>
        <span>06</span>
        <span>12</span>
        <span>18</span>
        <span>23</span>
      </div>
    </div>
  );
}

function Detail({ node, onBack }: { node: GraphNode; onBack: () => void }) {
  const stat = (label: string, value: string, hint?: string) => (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="text-sm font-medium tabular-nums">{value}</div>
      {hint && <div className="text-[10px] text-muted-foreground">{hint}</div>}
    </div>
  );
  return (
    <div className="space-y-4">
      <button
        onClick={onBack}
        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3 w-3" /> All relationships
      </button>

      <div className="flex items-center gap-2">
        <span className={cn("h-2 w-2 shrink-0 rounded-full", SOURCE_DOT[node.source])} />
        <h3 className="truncate text-base font-semibold">{node.name}</h3>
        <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">
          {node.messages.toLocaleString("sv-SE")} messages
        </span>
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {stat("My reply", duration(node.response.mineSec), "median")}
        {stat("Their reply", duration(node.response.theirsSec), "median")}
        {stat("My emoji", node.emoji.mine.toFixed(2), "per message")}
        {stat("Their emoji", node.emoji.theirs.toFixed(2), "per message")}
        {stat("My length", node.medianWords.mine ? `${node.medianWords.mine} w` : "—", "median")}
        {stat("Their length", node.medianWords.theirs ? `${node.medianWords.theirs} w` : "—", "median")}
        {stat(
          "Language",
          node.language ? (node.language.sv >= 0.5 ? "Swedish" : "English") : "—",
          node.language ? `${Math.round(node.language.sv * 100)}% sv` : undefined
        )}
        {stat(
          "Span",
          `${new Date(node.firstAt).getFullYear()}–${new Date(node.lastAt).getFullYear()}`
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <SplitBar mine={node.balance} label="Messages — me / them" />
        {node.initiative && (
          <SplitBar mine={node.initiative.mineShare} label="Who breaks the silence" />
        )}
      </div>

      <HourBars hours={node.hours} />

      {node.initiative && node.initiative.mineShare <= 0.25 && (
        <p className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
          They start {Math.round((1 - node.initiative.mineShare) * 100)}% of your{" "}
          {node.initiative.openings} conversations.
        </p>
      )}
      {node.initiative && node.initiative.mineShare >= 0.75 && (
        <p className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
          You start {Math.round(node.initiative.mineShare * 100)}% of your{" "}
          {node.initiative.openings} conversations.
        </p>
      )}
    </div>
  );
}

export function SocialGraphDialog() {
  const [open, setOpen] = useState(false);
  const [graph, setGraph] = useState<Graph | null>(null);
  const [selected, setSelected] = useState<GraphNode | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!open || loaded) return;
    void invoke<string | null>("ai_social_graph")
      .then((raw) => setGraph(raw ? (JSON.parse(raw) as Graph) : null))
      .catch(() => setGraph(null))
      .finally(() => setLoaded(true));
  }, [open, loaded]);

  const grouped = useMemo(() => {
    if (!graph) return [];
    const groups = graph.clusters.map((c, i) => ({
      label: c.label,
      nodes: graph.nodes.filter((n) => n.cluster === i),
    }));
    const rest = graph.nodes.filter((n) => n.cluster === null);
    if (rest.length) groups.push({ label: "Unclustered", nodes: rest });
    return groups.filter((g) => g.nodes.length > 0);
  }, [graph]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-muted-foreground"
          aria-label="Social graph"
          title="Communication patterns"
        >
          <Network className="h-4 w-4" />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
        <DialogTitle>Communication patterns</DialogTitle>
        <DialogDescription className="sr-only">
          Measured patterns per relationship, grouped into circles.
        </DialogDescription>

        {!loaded ? (
          <p className="py-8 text-center text-sm text-muted-foreground">Loading…</p>
        ) : !graph ? (
          <div className="space-y-2 py-8 text-center text-sm text-muted-foreground">
            <p>No graph yet.</p>
            <p className="font-mono text-xs">node scripts/social-graph.mjs</p>
          </div>
        ) : selected ? (
          <Detail node={selected} onBack={() => setSelected(null)} />
        ) : (
          <div className="space-y-5">
            {grouped.map((group) => (
              <div key={group.label}>
                <div className="mb-2 flex items-baseline gap-2">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    {group.label}
                  </h3>
                  <span className="text-xs text-muted-foreground/60 tabular-nums">
                    {group.nodes.length}
                  </span>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  {group.nodes.map((node) => (
                    <button
                      key={node.guid}
                      onClick={() => setSelected(node)}
                      className="rounded-lg border px-3 py-2 text-left transition-colors hover:bg-accent"
                    >
                      <div className="flex items-center gap-2">
                        <span
                          className={cn("h-1.5 w-1.5 shrink-0 rounded-full", SOURCE_DOT[node.source])}
                        />
                        <span className="truncate text-sm font-medium">{node.name}</span>
                        <span className="ml-auto shrink-0 text-[10px] text-muted-foreground tabular-nums">
                          {node.messages.toLocaleString("sv-SE")}
                        </span>
                      </div>
                      <div className="mt-1 flex gap-3 text-[10px] text-muted-foreground tabular-nums">
                        <span>reply {duration(node.response.mineSec)}</span>
                        <span>emoji {node.emoji.mine.toFixed(2)}</span>
                        {node.initiative && (
                          <span>starts {Math.round(node.initiative.mineShare * 100)}%</span>
                        )}
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            ))}
            <p className="pt-1 text-[10px] text-muted-foreground">
              Measured from both sides of {graph.nodes.length} conversations ·{" "}
              {new Date(graph.generatedAt).toLocaleDateString("sv-SE")}
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
