import type { LinkPreview } from "@/types";
import { cn } from "@/lib/utils";

interface LinkPreviewCardProps {
  preview?: LinkPreview;
  url: string;
  loading?: boolean;
  isOwnMessage: boolean;
}

function getHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function LinkPreviewCard({ preview, url, loading, isOwnMessage }: LinkPreviewCardProps) {
  if (!loading && (!preview || preview.status !== "ready")) return null;

  const host = getHost(preview?.url ?? url);
  const title = preview?.title;
  const description = preview?.description;
  const image = preview?.image;
  const favicon = preview?.favicon;
  const siteName = preview?.siteName || host;

  return (
    <a
      href={preview?.url ?? url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(event) => event.stopPropagation()}
      className={cn(
        "mt-2 block overflow-hidden rounded-md border text-left transition-[background-color] duration-120",
        isOwnMessage
          ? "border-primary-foreground/20 bg-primary-foreground/10 text-primary-foreground hover:bg-primary-foreground/15"
          : "border-border bg-background text-foreground hover:bg-muted"
      )}
    >
      {loading ? (
        <div className="grid gap-2 p-3">
          <div className="h-3 w-28 rounded-full bg-current/15" />
          <div className="h-4 w-48 rounded-full bg-current/15" />
          <div className="h-3 w-36 rounded-full bg-current/10" />
        </div>
      ) : (
        <>
          {image && (
            <img
              src={image}
              alt=""
              loading="lazy"
              referrerPolicy="no-referrer"
              className="max-h-44 w-full object-cover"
            />
          )}
          <div className="grid gap-1.5 p-3">
            <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide opacity-70">
              {favicon && (
                <img
                  src={favicon}
                  alt=""
                  loading="lazy"
                  referrerPolicy="no-referrer"
                  className="h-3.5 w-3.5 rounded-sm"
                />
              )}
              <span className="truncate">{siteName}</span>
            </div>
            {title && <p className="line-clamp-2 text-sm font-semibold leading-snug">{title}</p>}
            {description && (
              <p className="line-clamp-2 text-xs leading-relaxed opacity-75">{description}</p>
            )}
            <p className="truncate text-[11px] opacity-55">{host}</p>
          </div>
        </>
      )}
    </a>
  );
}
