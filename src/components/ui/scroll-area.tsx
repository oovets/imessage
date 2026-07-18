import * as React from "react";
import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area";
import { cn } from "@/lib/utils";

const ScrollArea = React.forwardRef<
  React.ElementRef<typeof ScrollAreaPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.Root>
>(({ className, children, type = "scroll", scrollHideDelay = 650, ...props }, ref) => (
  <ScrollAreaPrimitive.Root
    ref={ref}
    type={type}
    scrollHideDelay={scrollHideDelay}
    className={cn("relative overflow-hidden", className)}
    {...props}
  >
    {/* Radix wraps children in a div with inline `display: table`, which
        sizes to max-content: one row with a long nowrap name (`truncate`)
        widens the whole list past the viewport, clipping everything at the
        right edge — stars, timestamps. This app only ever scrolls
        vertically, so force block layout and let rows truncate instead. */}
    <ScrollAreaPrimitive.Viewport className="h-full w-full rounded-[inherit] [&>div]:!block [&>div]:!min-w-0">
      {children}
    </ScrollAreaPrimitive.Viewport>
    <ScrollBar />
    <ScrollAreaPrimitive.Corner />
  </ScrollAreaPrimitive.Root>
));
ScrollArea.displayName = ScrollAreaPrimitive.Root.displayName;

const ScrollBar = React.forwardRef<
  React.ElementRef<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>,
  React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>
>(({ className, orientation = "vertical", ...props }, ref) => (
  <ScrollAreaPrimitive.ScrollAreaScrollbar
    ref={ref}
    orientation={orientation}
    className={cn(
      "flex touch-none select-none transition-opacity duration-150 data-[state=hidden]:opacity-0 data-[state=visible]:opacity-100",
      orientation === "vertical" && "h-full w-2.5 border-l border-l-transparent p-[1px]",
      orientation === "horizontal" && "h-2.5 flex-col border-t border-t-transparent p-[1px]",
      className
    )}
    {...props}
  >
    <ScrollAreaPrimitive.ScrollAreaThumb className="relative flex-1 rounded-full bg-border" />
  </ScrollAreaPrimitive.ScrollAreaScrollbar>
));
ScrollBar.displayName = ScrollAreaPrimitive.ScrollAreaScrollbar.displayName;

export { ScrollArea, ScrollBar };
