// App-wide right-click menu for images.
//
// WebKit's native items ("Download Image", "Open Image in New Window") point
// at delegates a Tauri app doesn't provide, so they silently did nothing. We
// suppress the native menu on <img> targets and provide the same actions,
// done host-side — which also makes them work for every image source the app
// renders (BlueBubbles http, asset:// temp files, data: URLs).

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Copy, Download, Eye } from "lucide-react";
import { useAppStore } from "@/store/useAppStore";
import { isTauriRuntime } from "@/lib/tauriEnv";
import { cn } from "@/lib/utils";

interface MenuState {
  x: number;
  y: number;
  src: string;
  name: string;
}

const MENU_WIDTH = 208;
const MENU_HEIGHT = 128;

export function ImageContextMenu() {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const setConnectionNotice = useAppStore((s) => s.setConnectionNotice);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isTauriRuntime()) return; // browser dev build keeps WebKit's menu

    function onContextMenu(e: MouseEvent) {
      const img = (e.target as HTMLElement).closest?.("img");
      if (!img?.src) return;
      // Tiny UI imagery (avatars, emoji) has no useful save/open story.
      if (img.closest("[data-no-image-menu]")) return;
      if (img.width < 48 && img.height < 48) return;
      e.preventDefault();
      setMenu({
        x: Math.min(e.clientX, window.innerWidth - MENU_WIDTH - 8),
        y: Math.min(e.clientY, window.innerHeight - MENU_HEIGHT - 8),
        src: img.currentSrc || img.src,
        name: img.alt?.trim() || "image",
      });
    }
    document.addEventListener("contextmenu", onContextMenu);
    return () => document.removeEventListener("contextmenu", onContextMenu);
  }, []);

  const close = useCallback(() => setMenu(null), []);

  useEffect(() => {
    if (!menu) return;
    function onDown(e: PointerEvent) {
      if (!menuRef.current?.contains(e.target as Node)) close();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", close);
    };
  }, [menu, close]);

  if (!menu) return null;

  function run(action: "open" | "save" | "copy") {
    const { src, name } = menu!;
    close();
    const task =
      action === "open"
        ? invoke("img_open", { src, name })
        : action === "save"
          ? invoke<string>("img_save", { src, name })
          : invoke("img_copy", { src });
    void task.catch((err) =>
      setConnectionNotice(
        `Image ${action} failed: ${err instanceof Error ? err.message : String(err)}`
      )
    );
  }

  const item =
    "flex w-full items-center gap-2.5 px-3 py-1.5 text-sm text-left hover:bg-accent focus:bg-accent focus:outline-none";

  return (
    <div
      ref={menuRef}
      role="menu"
      style={{ left: menu.x, top: menu.y, width: MENU_WIDTH }}
      className={cn(
        "fixed z-[100] py-1 rounded-lg border bg-popover text-popover-foreground shadow-lg",
        "animate-in fade-in zoom-in-95 duration-100"
      )}
    >
      <button role="menuitem" className={item} onClick={() => run("open")}>
        <Eye className="h-4 w-4 text-muted-foreground" /> Open Image
      </button>
      <button role="menuitem" className={item} onClick={() => run("save")}>
        <Download className="h-4 w-4 text-muted-foreground" /> Save to Downloads
      </button>
      <button role="menuitem" className={item} onClick={() => run("copy")}>
        <Copy className="h-4 w-4 text-muted-foreground" /> Copy Image
      </button>
    </div>
  );
}
