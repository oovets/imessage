import { useEffect, useState } from "react";
import { useAppStore } from "@/store/useAppStore";
import { cn } from "@/lib/utils";

interface TypingIndicatorProps {
  chatGUID: string;
}

export function TypingIndicator({ chatGUID }: TypingIndicatorProps) {
  const expiresAt = useAppStore((s) => s.typingChats[chatGUID]);
  const setTyping = useAppStore((s) => s.setTyping);
  const superlightMode = useAppStore((s) => s.superlightMode);
  const [, force] = useState(0);

  useEffect(() => {
    if (!expiresAt) return;
    const ms = expiresAt - Date.now();
    if (ms <= 0) {
      setTyping(chatGUID, false);
      return;
    }
    const t = window.setTimeout(() => {
      setTyping(chatGUID, false);
      force((n) => n + 1);
    }, ms);
    return () => window.clearTimeout(t);
  }, [expiresAt, chatGUID, setTyping]);

  if (!expiresAt || expiresAt <= Date.now()) return null;

  if (superlightMode) {
    return (
      <div className="px-3 md:px-4 py-1 text-[11px] text-muted-foreground">typing…</div>
    );
  }

  return (
    <div className="flex items-end px-3 md:px-4 mt-1 mb-1 animate-in fade-in slide-in-from-bottom-1 duration-150">
      <div
        className={cn(
          "rounded-2xl rounded-bl-md bg-muted px-3.5 py-2.5 shadow-sm",
          "flex items-center gap-1"
        )}
        aria-label="Typing"
      >
        <Dot delay="0ms" />
        <Dot delay="150ms" />
        <Dot delay="300ms" />
      </div>
    </div>
  );
}

function Dot({ delay }: { delay: string }) {
  return (
    <span
      className="typing-dot h-1.5 w-1.5 rounded-full bg-muted-foreground/60"
      style={{ animationDelay: delay }}
    />
  );
}
