import { useEffect, useState } from "react";
import { useAppStore } from "@/store/useAppStore";

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
      <div className="px-3.5 py-1 text-cc-meta text-muted-foreground">typing…</div>
    );
  }

  return (
    <div className="mt-2.5 flex items-end px-3.5 animate-in fade-in slide-in-from-bottom-1 duration-150">
      <div
        className="flex h-[35px] items-center gap-1 rounded-md bg-panel px-[11px] shadow-[inset_0_0_0_1px_hsl(var(--border))]"
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
      className="typing-dot h-1.5 w-1.5 rounded-full bg-signal"
      style={{ animationDelay: delay }}
    />
  );
}
