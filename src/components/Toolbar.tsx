import { memo, useEffect, useRef, useState } from "react";
import { PanelLeftClose, PanelLeftOpen, RefreshCw, Search, X } from "lucide-react";
import { AiSimulatorDialog, SettingsDialog, SocialGraphDialog } from "@/components/ToolbarDialogs";
import { ThemeToggle } from "@/components/ThemeToggle";
import { useAppStore } from "@/store/useAppStore";
import { loadIMessageChats } from "@/lib/loadChats";
import { filterChats, triage } from "@/lib/triage";
import { isSource } from "@/lib/source";
import { ghostIconButton } from "@/components/ui/icon-button";
import { cn } from "@/lib/utils";
import { hasTrafficLights } from "@/lib/tauriEnv";
import { modLabel } from "@/lib/shortcuts";
import { openSettings } from "@/lib/openSettings";

type SourceState = "live" | "polling" | "connecting" | "disconnected" | "off";

const STATE_LABEL: Record<SourceState, string> = {
  live: "live",
  polling: "polling",
  connecting: "connecting…",
  disconnected: "disconnected",
  off: "not set up",
};

const STATE_DOT: Record<SourceState, string> = {
  live: "bg-[#22c55e]",
  polling: "bg-[#f59e0b]",
  connecting: "bg-[#f59e0b]",
  disconnected: "bg-signal",
  off: "bg-muted-foreground/40",
};

/** A set-up source with no chats yet is still coming up. */
function chatSourceState(available: boolean, hasChats: boolean): SourceState {
  return !available ? "off" : hasChats ? "live" : "connecting";
}

/**
 * "2 sources live" in the toolbar; a click lists each source's state, with
 * the way to Settings for the ones that are off.
 */
function ConnectionStatus() {
  const isConfigured = useAppStore((s) => s.isConfigured);
  const wsConnected = useAppStore((s) => s.wsConnected);
  const pollingFallback = useAppStore((s) => s.pollingFallback);
  const telegram = useAppStore((s) =>
    chatSourceState(s.telegramAvailable, s.chats.some((c) => isSource(c.guid, "telegram")))
  );
  const slack = useAppStore((s) =>
    chatSourceState(s.slackAvailable, s.chats.some((c) => isSource(c.guid, "slack")))
  );
  const ircState = useAppStore((s) =>
    chatSourceState(s.ircAvailable, s.chats.some((c) => isSource(c.guid, "irc")))
  );
  const imessage: SourceState = !isConfigured
    ? "off"
    : wsConnected
      ? "live"
      : pollingFallback
        ? "polling"
        : "disconnected";
  const sources: Array<[string, SourceState]> = [
    ["iMessage", imessage],
    ["Telegram", telegram],
    ["Slack", slack],
    ["IRC", ircState],
  ];
  const live = sources.filter(([, st]) => st === "live" || st === "polling").length;
  const polling = imessage === "polling";

  const dot = polling ? "bg-[#f59e0b]" : live > 0 ? "bg-[#22c55e]" : "bg-muted-foreground/40";
  const label =
    live === 0
      ? "offline"
      : `${live} ${live === 1 ? "source" : "sources"} ${polling ? "polling" : "live"}`;

  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  // Close on outside click or Escape.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        title="Sources"
        className="flex items-center gap-1.5 whitespace-nowrap rounded-md px-1.5 py-1 font-mono text-cc-meta text-muted-foreground transition-[background-color] duration-120 hover:bg-muted hover:text-foreground"
      >
        <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", dot)} />
        {label}
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Sources"
          className="absolute right-0 top-full z-50 mt-1 w-60 rounded-xl border bg-popover p-1.5 text-popover-foreground shadow-lg"
        >
          <ul>
            {sources.map(([name, st]) => (
              <li key={name} className="flex items-center gap-2 px-2 py-1 text-cc-body">
                <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", STATE_DOT[st])} />
                <span className="flex-1">{name}</span>
                <span className="font-mono text-cc-meta text-muted-foreground">{STATE_LABEL[st]}</span>
              </li>
            ))}
          </ul>
          {polling && (
            <p className="px-2 pb-1 text-cc-meta text-muted-foreground">
              HTTPS blocks ws://, so iMessage polls. Use an https:// server URL for realtime.
            </p>
          )}
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              openSettings();
            }}
            className="mt-1 w-full rounded-md px-2 py-1 text-left text-cc-body transition-[background-color] duration-120 hover:bg-muted"
          >
            Settings…
          </button>
        </div>
      )}
    </div>
  );
}

function CommandBar({ disabled }: { disabled?: boolean }) {
  const query = useAppStore((s) => s.chatQuery);
  const setQuery = useAppStore((s) => s.setChatQuery);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (disabled) return;
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [disabled]);

  // Enter jumps to the first match in sidebar order; ⌥Enter opens it in a new
  // pane beside the active one. Either way the bar clears, like a palette.
  function jump(newPane: boolean) {
    const s = useAppStore.getState();
    const { waiting, starred, recent } = triage(filterChats(s.chats, s.chatQuery), s.starredChats);
    const target = waiting[0] ?? starred[0] ?? recent[0];
    if (!target) return;
    if (newPane) s.splitPane(s.activePaneId, "horizontal", target.guid);
    else s.selectChat(target.guid);
    setQuery("");
    inputRef.current?.blur();
  }

  return (
    <label
      className={cn(
        "flex h-[30px] min-w-0 items-center gap-2 rounded-lg bg-panel px-2.5 text-muted-foreground shadow-[inset_0_0_0_1px_hsl(var(--border))]",
        "focus-within:shadow-[inset_0_0_0_1.5px_hsl(var(--primary))]",
        disabled && "opacity-60"
      )}
    >
      <Search className="h-3.5 w-3.5 shrink-0" />
      <input
        ref={inputRef}
        value={query}
        disabled={disabled}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            setQuery("");
            inputRef.current?.blur();
          } else if (e.key === "Enter") {
            e.preventDefault();
            jump(e.altKey);
          }
        }}
        placeholder="Search, or jump to a chat…"
        aria-label="Search chats"
        className="min-w-0 flex-1 bg-transparent text-cc-body text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-default"
      />
      {query ? (
        <button
          type="button"
          onClick={() => setQuery("")}
          className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground"
          aria-label="Clear search"
        >
          <X className="h-3 w-3" />
        </button>
      ) : (
        <kbd className="shrink-0 rounded bg-muted px-[5px] py-px font-mono text-cc-meta">{modLabel("K")}</kbd>
      )}
    </label>
  );
}

interface ToolbarProps {
  /** Onboarding: command bar disabled, board-only controls hidden. */
  setup?: boolean;
}

/**
 * The 48px window toolbar. It replaces the old 28px titlebar strip: it is the
 * Tauri drag region and reserves room for the macOS traffic lights on the left.
 */
// Memoized: App re-renders on every chat switch, and the toolbar's only prop
// is the onboarding flag.
export const Toolbar = memo(function Toolbar({ setup = false }: ToolbarProps) {
  const sidebarHidden = useAppStore((s) => s.sidebarHidden);
  const toggleSidebarHidden = useAppStore((s) => s.toggleSidebarHidden);
  const loadingChats = useAppStore((s) => s.loadingChats);
  const isConfigured = useAppStore((s) => s.isConfigured);

  return (
    <header
      data-tauri-drag-region
      className="app-toolbar grid h-12 shrink-0 grid-cols-[1fr_minmax(0,440px)_1fr] items-center gap-3 border-b bg-background px-3.5"
    >
      {/* Left: traffic-light space (~70px in the macOS window), then the
          sidebar toggle. Linux runs undecorated, so nothing to make room for. */}
      <div
        data-tauri-drag-region
        className={cn("flex min-w-0 items-center", hasTrafficLights() && "pl-[70px]")}
      >
        {!setup && (
          <button
            type="button"
            className={cn(ghostIconButton, "hidden md:inline-flex")}
            onClick={toggleSidebarHidden}
            aria-label={sidebarHidden ? "Show sidebar" : "Hide sidebar"}
            title={sidebarHidden ? "Show sidebar" : "Hide sidebar"}
          >
            {sidebarHidden ? <PanelLeftOpen /> : <PanelLeftClose />}
          </button>
        )}
      </div>

      <CommandBar disabled={setup} />

      <div data-tauri-drag-region className="flex min-w-0 items-center justify-end gap-1.5">
        <ConnectionStatus />
        <div className="flex items-center">
          {!setup && (
            <>
              {isConfigured && (
                <button
                  type="button"
                  className={ghostIconButton}
                  onClick={() => void loadIMessageChats()}
                  disabled={loadingChats}
                  aria-label="Refresh chats"
                  title="Refresh chats"
                >
                  <RefreshCw className={cn(loadingChats && "animate-spin")} />
                </button>
              )}
              <AiSimulatorDialog />
              <SocialGraphDialog />
            </>
          )}
          <ThemeToggle />
          <SettingsDialog autoOpen={!setup} />
        </div>
      </div>
    </header>
  );
});
