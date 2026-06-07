import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

// Alternating incoming/outgoing bubble placeholders shown while the first page
// of a conversation loads. Widths vary so it reads like a real thread.
const ROWS: Array<{ me: boolean; w: string }> = [
  { me: false, w: "w-40" },
  { me: false, w: "w-24" },
  { me: true, w: "w-48" },
  { me: false, w: "w-56" },
  { me: true, w: "w-28" },
  { me: true, w: "w-36" },
  { me: false, w: "w-44" },
];

export function MessageListSkeleton() {
  return (
    <div className="flex-1 flex flex-col justify-end gap-2 px-4 py-3" aria-hidden>
      {ROWS.map((row, i) => (
        <div key={i} className={cn("flex", row.me ? "justify-end" : "justify-start")}>
          <Skeleton
            className={cn(
              "h-9 rounded-2xl",
              row.w,
              row.me ? "rounded-br-md" : "rounded-bl-md"
            )}
          />
        </div>
      ))}
    </div>
  );
}
