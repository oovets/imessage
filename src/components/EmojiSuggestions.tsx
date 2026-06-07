import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import type { Emoji } from "@/lib/emoji";

interface EmojiSuggestionsProps {
  suggestions: Emoji[];
  activeIndex: number;
  superlight?: boolean;
  onSelect: (index: number) => void;
  onHover: (index: number) => void;
}

export function EmojiSuggestions({
  suggestions,
  activeIndex,
  superlight,
  onSelect,
  onHover,
}: EmojiSuggestionsProps) {
  const listRef = useRef<HTMLDivElement>(null);

  // Keep the highlighted row in view as the user arrows through.
  useEffect(() => {
    const list = listRef.current;
    const active = list?.children[activeIndex] as HTMLElement | undefined;
    active?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  if (suggestions.length === 0) return null;

  return (
    <div
      ref={listRef}
      role="listbox"
      aria-label="Emoji suggestions"
      className={cn(
        "absolute bottom-full left-0 mb-2 z-50 w-64 max-h-56 overflow-y-auto scrollbar-autohide py-1",
        "bg-popover text-popover-foreground shadow-lg",
        superlight ? "border" : "border rounded-xl backdrop-blur-xl",
        "animate-in fade-in slide-in-from-bottom-1 duration-100"
      )}
    >
      {suggestions.map((emoji, i) => (
        <button
          key={emoji.name}
          type="button"
          role="option"
          aria-selected={i === activeIndex}
          // onMouseDown (not onClick) so focus stays in the textarea and the
          // selection logic can read the caret before blur.
          onMouseDown={(e) => {
            e.preventDefault();
            onSelect(i);
          }}
          onMouseMove={() => onHover(i)}
          className={cn(
            "flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-sm",
            i === activeIndex ? "bg-accent text-accent-foreground" : "text-foreground"
          )}
        >
          <span className="text-lg leading-none">{emoji.char}</span>
          <span className="truncate text-muted-foreground">:{emoji.name}:</span>
        </button>
      ))}
    </div>
  );
}
