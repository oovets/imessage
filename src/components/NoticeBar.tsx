import { X } from "lucide-react";
import { useAppStore } from "@/store/useAppStore";

/**
 * The strip under the toolbar for being offline and for connection / send
 * notices. A notice can be dismissed; the next one replaces it.
 */
export function NoticeBar() {
  const networkOnline = useAppStore((s) => s.networkOnline);
  const connectionNotice = useAppStore((s) => s.connectionNotice);
  const setConnectionNotice = useAppStore((s) => s.setConnectionNotice);

  // The live region stays mounted so screen readers announce what lands in it.
  return (
    <div role="status" aria-live="polite" className="shrink-0">
      {!networkOnline ? (
        // Offline explains any notice raised meanwhile; it clears by itself.
        <div className="border-b px-4 py-2 text-cc-meta text-signal">
          You are offline. Trying to reconnect automatically…
        </div>
      ) : (
        connectionNotice && (
          <div className="flex items-start gap-2 border-b px-4 py-2 text-cc-meta text-muted-foreground">
            <span className="min-w-0 flex-1 break-words">{connectionNotice}</span>
            <button
              type="button"
              onClick={() => setConnectionNotice(null)}
              className="flex h-4 w-4 shrink-0 items-center justify-center rounded hover:text-foreground"
              aria-label="Dismiss notice"
              title="Dismiss"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        )
      )}
    </div>
  );
}
