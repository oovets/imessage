import { lazy, Suspense, useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import { FlaskConical, Network, Settings } from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { Dialog, DialogTrigger } from "@/components/ui/dialog";
import { ghostIconButton } from "@/components/ui/icon-button";
import { useAppStore } from "@/store/useAppStore";
import { isTauriRuntime } from "@/lib/tauriEnv";
import { cn } from "@/lib/utils";

/**
 * The toolbar's dialogs, split so first paint doesn't pay for them: this file
 * (eager) owns each Dialog root, its trigger button and the open state; the
 * content — settings with Telegram/Slack setup and QR codes, the AI simulator,
 * the social graph — is a lazy chunk, warmed while idle and on hover so the
 * first open is as instant as before. Content stays mounted after the first
 * open, so its state (selected tab, simulator transcript) persists as it did.
 */

interface ContentProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const loadSettings = () => import("@/components/SettingsDialog");
const loadAiSimulator = () => import("@/components/AiSimulatorDialog");
const loadSocialGraph = () => import("@/components/SocialGraphDialog");

const SettingsContent = lazy(loadSettings);
const AiSimulatorContent = lazy(loadAiSimulator);
const SocialGraphContent = lazy(loadSocialGraph);

function preloadWhenIdle(load: () => Promise<unknown>): () => void {
  const w = window as Window & {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
    cancelIdleCallback?: (id: number) => void;
  };
  const run = () => void load().catch(() => {});
  if (w.requestIdleCallback) {
    const id = w.requestIdleCallback(run, { timeout: 3000 });
    return () => w.cancelIdleCallback?.(id);
  }
  const id = window.setTimeout(run, 1500);
  return () => window.clearTimeout(id);
}

function LazyDialog({
  open,
  onOpenChange,
  load,
  Content,
  trigger,
}: ContentProps & {
  load: () => Promise<unknown>;
  Content: ComponentType<ContentProps>;
  trigger: ReactNode;
}) {
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) setMounted(true);
  }, [open]);
  useEffect(() => preloadWhenIdle(load), [load]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild onPointerEnter={() => void load().catch(() => {})}>
        {trigger}
      </DialogTrigger>
      {(mounted || open) && (
        <Suspense fallback={null}>
          <Content open={open} onOpenChange={onOpenChange} />
        </Suspense>
      )}
    </Dialog>
  );
}

interface SettingsDialogProps {
  /** Open once on its own while nothing is configured. Off during onboarding,
   *  whose checklist is the setup surface. */
  autoOpen?: boolean;
}

export function SettingsDialog({ autoOpen = true }: SettingsDialogProps) {
  const isConfigured = useAppStore((s) => s.isConfigured);
  const configLoaded = useAppStore((s) => s.configLoaded);
  const [open, setOpen] = useState(false);
  const autoOpenedRef = useRef(false);

  // The tray / app menu's "Settings…" item.
  useEffect(() => {
    if (!isTauriRuntime()) return;

    let unlisten: (() => void) | null = null;
    listen("app://open-settings", () => {
      setOpen(true);
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {});

    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  useEffect(() => {
    if (!autoOpen || !configLoaded || isConfigured || autoOpenedRef.current) return;
    autoOpenedRef.current = true;
    setOpen(true);
  }, [autoOpen, configLoaded, isConfigured]);

  return (
    <LazyDialog
      open={open}
      onOpenChange={setOpen}
      load={loadSettings}
      Content={SettingsContent}
      trigger={
        <button type="button" className={ghostIconButton} aria-label="Settings" title="Settings">
          <Settings />
        </button>
      }
    />
  );
}

export function AiSimulatorDialog() {
  const configured = useAppStore(
    (s) => s.aiReply.endpoint.trim().length > 0 && s.aiReply.model.trim().length > 0
  );
  const [open, setOpen] = useState(false);
  // Once configured, stay mounted: Settings writes the endpoint/model on every
  // keystroke, and briefly emptying a field must not wipe the simulator's
  // transcript and draft. Unconfigured just hides the trigger and the dialog.
  const [everConfigured, setEverConfigured] = useState(configured);
  if (configured && !everConfigured) setEverConfigured(true);
  if (!everConfigured) return null;
  return (
    <LazyDialog
      open={open && configured}
      onOpenChange={setOpen}
      load={loadAiSimulator}
      Content={AiSimulatorContent}
      trigger={
        <button
          type="button"
          className={cn(ghostIconButton, !configured && "hidden")}
          aria-label="AI simulator"
          title="AI simulator — chat with your autopilot, nothing is sent"
        >
          <FlaskConical />
        </button>
      }
    />
  );
}

export function SocialGraphDialog() {
  const [open, setOpen] = useState(false);
  return (
    <LazyDialog
      open={open}
      onOpenChange={setOpen}
      load={loadSocialGraph}
      Content={SocialGraphContent}
      trigger={
        <button type="button" className={ghostIconButton} aria-label="Social graph" title="Communication patterns">
          <Network />
        </button>
      }
    />
  );
}
