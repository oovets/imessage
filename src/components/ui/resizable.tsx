import { Group, Panel, Separator } from "react-resizable-panels";
import { cn } from "@/lib/utils";

type GroupProps = React.ComponentProps<typeof Group>;
type PanelProps = React.ComponentProps<typeof Panel>;
type SepProps = React.ComponentProps<typeof Separator> & {
  orientation?: "horizontal" | "vertical";
};

// Overflow visible on both: the library clips by default, which would cut off
// the panes' outer 1.5px active ring where it reaches into the board gap.
const ResizablePanelGroup = ({ className, style, ...props }: GroupProps) => (
  <Group
    className={cn(
      "flex h-full w-full data-[orientation=vertical]:flex-col",
      className
    )}
    style={{ overflow: "visible", ...style }}
    {...props}
  />
);

const ResizablePanel = ({ style, ...props }: PanelProps) => (
  <Panel style={{ overflow: "visible", ...style }} {...props} />
);

/**
 * The 10px gap between board panes *is* the handle: transparent, with a 2px
 * border-coloured line centred in it on hover or while dragging.
 */
const ResizableHandle = ({
  className,
  orientation = "horizontal",
  ...props
}: SepProps) => {
  const isVertical = orientation === "vertical";
  return (
    <Separator
      className={cn(
        "group relative flex shrink-0 items-center justify-center bg-transparent outline-none",
        isVertical ? "h-2.5 w-full" : "h-full w-2.5",
        className
      )}
      {...props}
    >
      <span
        className={cn(
          "rounded-full bg-border opacity-0 transition-opacity duration-120 group-hover:opacity-100 group-data-[separator=active]:opacity-100 group-data-[separator=focus]:opacity-100 group-data-[separator=hover]:opacity-100",
          isVertical ? "h-0.5 w-full" : "h-full w-0.5"
        )}
      />
    </Separator>
  );
};

export { ResizablePanelGroup, ResizablePanel, ResizableHandle };
