import { useEffect } from "react";
import { ChatList } from "@/components/ChatList";
import { ChatPane } from "@/components/ChatPane";
import { PaneTreeRoot } from "@/components/PaneTree";
import { ImageContextMenu } from "@/components/ImageContextMenu";
import { OnboardingWizard } from "@/components/OnboardingWizard";
import { Toolbar } from "@/components/Toolbar";
import { useWebSocket } from "@/hooks/useWebSocket";
import { usePollingFallback } from "@/hooks/usePollingFallback";
import { useDesktopFeatures } from "@/hooks/useDesktopFeatures";
import { useTelegramInbox } from "@/hooks/useTelegramInbox";
import { useTelegramEvents } from "@/hooks/useTelegramEvents";
import { useSlackInbox } from "@/hooks/useSlackInbox";
import { useSlackEvents } from "@/hooks/useSlackEvents";
import { useAiAutoReply } from "@/hooks/useAiAutoReply";
import { configureTracing } from "@/lib/aiTracing";
import { isTauriRuntime } from "@/lib/tauriEnv";
import { useAppStore, type PaneNode } from "@/store/useAppStore";
import { useTheme } from "@/components/ThemeProvider";
import { applyAppearance } from "@/lib/appearance";
import { cn } from "@/lib/utils";

function findActiveLeaf(
  tree: PaneNode,
  activePaneId: string
): { paneId: string; chatGUID: string | null } {
  function walk(n: PaneNode): { paneId: string; chatGUID: string | null } | null {
    if (n.type === "leaf") {
      return n.id === activePaneId ? { paneId: n.id, chatGUID: n.chatGUID } : null;
    }
    return walk(n.children[0]) ?? walk(n.children[1]);
  }
  return walk(tree) ?? { paneId: activePaneId, chatGUID: null };
}

export default function App() {
  useDesktopFeatures();
  useWebSocket();
  usePollingFallback();
  useTelegramInbox();
  useTelegramEvents();
  useSlackInbox();
  useSlackEvents();
  useAiAutoReply();

  // §17: (re)point tracing whenever the collector setting changes.
  const otlpEndpoint = useAppStore((s) => s.aiReply.otlpEndpoint);
  useEffect(() => {
    configureTracing(otlpEndpoint ?? "");
  }, [otlpEndpoint]);

  const selectedChatGUID = useAppStore((s) => s.selectedChatGUID);
  const paneTree = useAppStore((s) => s.paneTree);
  const activePaneId = useAppStore((s) => s.activePaneId);
  const repairPaneState = useAppStore((s) => s.repairPaneState);
  const superlightMode = useAppStore((s) => s.superlightMode);
  const configLoaded = useAppStore((s) => s.configLoaded);
  const isConfigured = useAppStore((s) => s.isConfigured);
  const onboardingDismissed = useAppStore((s) => s.onboardingDismissed);
  const active = findActiveLeaf(paneTree, activePaneId);
  const sidebarHidden = useAppStore((s) => s.sidebarHidden);
  const appearance = useAppStore((s) => s.appearance);
  const increaseFontScale = useAppStore((s) => s.increaseFontScale);
  const decreaseFontScale = useAppStore((s) => s.decreaseFontScale);
  const resetFontScale = useAppStore((s) => s.resetFontScale);
  const { resolved } = useTheme();

  useEffect(() => {
    document.documentElement.classList.toggle("superlight-ui", superlightMode);
  }, [superlightMode]);

  useEffect(() => {
    applyAppearance(appearance, resolved);
    if (superlightMode) {
      const root = document.documentElement;
      const background = root.style.getPropertyValue("--background");
      const foreground = root.style.getPropertyValue("--foreground");
      const border = root.style.getPropertyValue("--border");
      root.style.setProperty("--primary", foreground);
      root.style.setProperty("--primary-foreground", background);
      root.style.setProperty("--secondary", background);
      root.style.setProperty("--secondary-foreground", foreground);
      root.style.setProperty("--muted", background);
      root.style.setProperty("--muted-foreground", foreground);
      root.style.setProperty("--accent", background);
      root.style.setProperty("--accent-foreground", foreground);
      root.style.setProperty("--ring", border);
    }
  }, [appearance, resolved, superlightMode]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!event.metaKey || event.altKey || event.ctrlKey) return;
      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        increaseFontScale();
        return;
      }
      if (event.key === "-" || event.key === "_") {
        event.preventDefault();
        decreaseFontScale();
        return;
      }
      if (event.key === "0") {
        event.preventDefault();
        resetFontScale();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [decreaseFontScale, increaseFontScale, resetFontScale]);

  useEffect(() => {
    repairPaneState();
  }, [repairPaneState]);

  if (!configLoaded) {
    return (
      <div className="flex h-screen items-center justify-center bg-background text-cc-body text-muted-foreground">
        Loading app configuration…
      </div>
    );
  }

  // First-run in the desktop app: a checklist of sources to connect instead of
  // dropping into the empty shell. Skipped once the user dismisses it (e.g.
  // after connecting only Telegram).
  const onboarding = isTauriRuntime() && !isConfigured && !onboardingDismissed;

  return (
    <div className="app-shell flex h-screen flex-col overflow-hidden bg-background font-sans text-cc-body text-foreground">
      <Toolbar setup={onboarding} />
      {onboarding ? (
        <OnboardingWizard />
      ) : (
        <div className="flex min-h-0 flex-1">
          <ImageContextMenu />
          <aside
            className={cn(
              "min-h-0 shrink-0 flex-col md:border-r",
              selectedChatGUID ? "hidden w-0 md:flex" : "flex w-full",
              sidebarHidden ? "md:w-[52px] md:overflow-hidden" : "md:w-[296px]"
            )}
          >
            <ChatList />
          </aside>

          <main
            className={cn(
              "min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
              selectedChatGUID ? "flex" : "hidden md:flex"
            )}
          >
            <div className="hidden min-h-0 flex-1 md:flex">
              <PaneTreeRoot />
            </div>

            <div className="app-board flex min-h-0 flex-1 p-2.5 md:hidden">
              <ChatPane
                paneId={active.paneId}
                chatGUID={active.chatGUID}
                isActive
                canClose={false}
                showMobileBack
              />
            </div>
          </main>
        </div>
      )}
    </div>
  );
}
