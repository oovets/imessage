import { useEffect } from "react";
import { ChatList } from "@/components/ChatList";
import { ChatPane } from "@/components/ChatPane";
import { PaneTreeRoot } from "@/components/PaneTree";
import { OnboardingWizard } from "@/components/OnboardingWizard";
import { useWebSocket } from "@/hooks/useWebSocket";
import { usePollingFallback } from "@/hooks/usePollingFallback";
import { useDesktopFeatures } from "@/hooks/useDesktopFeatures";
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

  const selectedChatGUID = useAppStore((s) => s.selectedChatGUID);
  const paneTree = useAppStore((s) => s.paneTree);
  const activePaneId = useAppStore((s) => s.activePaneId);
  const repairPaneState = useAppStore((s) => s.repairPaneState);
  const superlightMode = useAppStore((s) => s.superlightMode);
  const configLoaded = useAppStore((s) => s.configLoaded);
  const isConfigured = useAppStore((s) => s.isConfigured);
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
      <div className="flex h-screen items-center justify-center bg-background text-sm text-muted-foreground">
        Loading app configuration…
      </div>
    );
  }

  // First-run in the desktop app: guide setup (install + configure BlueBubbles,
  // or connect to an existing server) instead of dropping into the empty shell.
  if (isTauriRuntime() && !isConfigured) {
    return <OnboardingWizard />;
  }

  return (
    <div className="app-shell flex h-screen overflow-hidden bg-background">
      {/* Draggable titlebar strip (Tauri only — hidden via CSS in the browser). */}
      <div className="app-titlebar" data-tauri-drag-region />
      <aside
        className={cn(
          "flex flex-col min-h-0 shrink-0 transition-[width]",
          !superlightMode && "md:border-r",
          selectedChatGUID ? "hidden w-0 md:flex" : "flex w-full",
          sidebarHidden
            ? "md:w-16 md:overflow-hidden"
            : "md:w-80"
        )}
      >
        <ChatList />
      </aside>

      <main
        className={cn(
          "flex-1 flex-col min-h-0 overflow-hidden",
          selectedChatGUID ? "flex" : "hidden md:flex"
        )}
      >
        <div className="hidden md:flex flex-1 min-h-0">
          <PaneTreeRoot />
        </div>

        <div className="flex md:hidden flex-1 min-h-0">
          <div className="flex-1 min-h-0">
            <ChatPane
              paneId={active.paneId}
              chatGUID={active.chatGUID}
              isActive
              canClose={false}
              showMobileBack
            />
          </div>
        </div>
      </main>
    </div>
  );
}
