import { useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { EMOJIS, searchEmojis } from "@/lib/emoji";

interface EmojiPickerProps {
  superlight?: boolean;
  onSelect: (char: string) => void;
  onClose: () => void;
}

export function EmojiPicker({ superlight, onSelect, onClose }: EmojiPickerProps) {
  const [query, setQuery] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const emojis = useMemo(
    () => (query.trim() ? searchEmojis(query.trim(), 64) : EMOJIS),
    [query]
  );

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  // Close on outside click or Escape.
  useEffect(() => {
    function onPointerDown(e: PointerEvent) {
      if (!containerRef.current?.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div
      ref={containerRef}
      role="dialog"
      aria-label="Emoji picker"
      className={cn(
        "absolute bottom-full left-0 mb-2 z-50 w-72 bg-popover text-popover-foreground shadow-lg",
        superlight ? "border" : "border rounded-xl backdrop-blur-xl",
        "animate-in fade-in slide-in-from-bottom-1 duration-100"
      )}
    >
      <div className="p-2 border-b">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search emoji"
            className={cn(
              "w-full h-8 text-sm pl-8 pr-2 placeholder:text-muted-foreground focus:outline-none",
              superlight ? "bg-transparent" : "rounded-lg bg-muted/60 focus:ring-2 focus:ring-ring"
            )}
          />
        </div>
      </div>

      <div className="max-h-56 overflow-y-auto scrollbar-autohide p-1.5">
        {emojis.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs text-muted-foreground">
            No emoji for “{query}”.
          </p>
        ) : (
          <div className="grid grid-cols-8 gap-0.5">
            {emojis.map((emoji) => (
              <button
                key={emoji.name}
                type="button"
                title={`:${emoji.name}:`}
                aria-label={emoji.name}
                onMouseDown={(e) => {
                  e.preventDefault(); // keep focus context for caret insertion
                  onSelect(emoji.char);
                }}
                className={cn(
                  "h-8 w-8 flex items-center justify-center text-xl leading-none transition-transform",
                  "hover:bg-accent active:scale-90",
                  superlight ? "" : "rounded-md"
                )}
              >
                {emoji.char}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
