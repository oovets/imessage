import { lazy, Suspense, useEffect, useState } from "react";
import { ChatList } from "@/components/ChatList";
import { ChatPane } from "@/components/ChatPane";
import { PaneTreeRoot } from "@/components/PaneTree";
import { ImageContextMenu } from "@/components/ImageContextMenu";
import { Toolbar } from "@/components/Toolbar";
import { useWebSocket } from "@/hooks/useWebSocket";
import { usePollingFallback } from "@/hooks/usePollingFallback";
import { useDesktopFeatures } from "@/hooks/useDesktopFeatures";
import { useTelegramInbox } from "@/hooks/useTelegramInbox";
import { useTelegramEvents } from "@/hooks/useTelegramEvents";
import { useSlackInbox } from "@/hooks/useSlackInbox";
import { useSlackEvents } from "@/hooks/useSlackEvents";
import { useAiAutoReply } from "@/hooks/useAiAutoReply";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { configureTracing } from "@/lib/aiTracing";
import { isTauriRuntime } from "@/lib/tauriEnv";
import { useAppStore, type PaneNode } from "@/store/useAppStore";
import { useTheme } from "@/components/ThemeProvider";
import { applyAppearance } from "@/lib/appearance";
import { cn } from "@/lib/utils";

// First run only — keep the checklist (and its Telegram QR / Slack token
// setup) out of the startup bundle for everyone who is already set up.
const OnboardingWizard = lazy(() =>
  import("@/components/OnboardingWizard").then((m) => ({ default: m.OnboardingWizard }))
);

/** Tailwind's `md` breakpoint (the default 768px; tailwind.config keeps it). */
const MD_UP = "(min-width: 768px)";

/** The chat shown in the active pane, or null when that pane is empty or gone. */
function findActiveChat(tree: PaneNode, activePaneId: string): string | null {
  function walk(n: PaneNode): { chatGUID: string | null } | null {
    if (n.type === "leaf") {
      return n.id === activePaneId ? { chatGUID: n.chatGUID } : null;
    }
    return walk(n.children[0]) ?? walk(n.children[1]);
  }
  return walk(tree)?.chatGUID ?? null;
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
  // md and up shows the pane board; below it, a single mobile pane. The
  // mobile pane isn't mounted until the window is first narrow: a
  // display:none ChatPane still fetches, renders and downloads media for the
  // active chat, doubling every chat view. The Tauri window's 900px minWidth
  // keeps the app on the board, so there it never mounts.
  const isDesktop = useMediaQuery(MD_UP);
  // Once shown it stays mounted (md:hidden hides it when wide again), so a
  // resize round trip keeps its unsent composer draft (local state), as before.
  const [mobileShown, setMobileShown] = useState(() => !isDesktop);
  useEffect(() => {
    if (!isDesktop) setMobileShown(true);
  }, [isDesktop]);
  const mountMobile = mobileShown || !isDesktop;
  // Primitive selectors, and constant while the mobile pane isn't mounted,
  // so a pane-tree change that keeps the selected chat (closing or filling
  // another pane) doesn't re-render the whole shell.
  const mobilePaneId = useAppStore((s) => (mountMobile ? s.activePaneId : null));
  const mobileChatGUID = useAppStore((s) =>
    mountMobile ? findActiveChat(s.paneTree, s.activePaneId) : null
  );
  const repairPaneState = useAppStore((s) => s.repairPaneState);
  const superlightMode = useAppStore((s) => s.superlightMode);
  const configLoaded = useAppStore((s) => s.configLoaded);
  const isConfigured = useAppStore((s) => s.isConfigured);
  const onboardingDismissed = useAppStore((s) => s.onboardingDismissed);
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
        <Suspense fallback={<div className="flex-1" />}>
          <OnboardingWizard />
        </Suspense>
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
            {/* Always mounted, even when narrow: it owns the board
                shortcuts (⌘1–9, ⌘D, Esc). */}
            <div className="hidden min-h-0 flex-1 md:flex">
              <PaneTreeRoot />
            </div>

            {mountMobile && mobilePaneId !== null && (
              <div className="app-board flex min-h-0 flex-1 p-2.5 md:hidden">
                <ChatPane
                  paneId={mobilePaneId}
                  chatGUID={mobileChatGUID}
                  isActive
                  canClose={false}
                  showMobileBack
                />
              </div>
            )}
          </main>
        </div>
      )}
    </div>
  );
}
