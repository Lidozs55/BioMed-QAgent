import type { ReactNode } from "react";

import { Bubble, BubbleContent } from "@/components/ui/bubble";
import {
  Collapsible,
  CollapsibleContent,
} from "@/components/ui/collapsible";

import { ToolCallMarker } from "./ToolCallMarker";
import type { ToolRendererProps } from "./types";

interface ToolCallShellProps extends ToolRendererProps {
  icon: ReactNode;
  title: ReactNode;
  badges?: ReactNode;
  children: ReactNode;
}

/** Collapsible(Marker 触发行 + outline 卡片体)的共用外壳。 */
export function ToolCallShell({
  item,
  open,
  onOpenChange,
  icon,
  title,
  badges,
  children,
}: ToolCallShellProps) {
  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      <ToolCallMarker
        status={item.status}
        icon={icon}
        title={title}
        badges={badges}
        open={open}
      />
      <CollapsibleContent>
        <Bubble variant="outline" className="mt-2 w-full max-w-full">
          <BubbleContent className="flex w-full flex-col gap-2">
            {children}
          </BubbleContent>
        </Bubble>
      </CollapsibleContent>
    </Collapsible>
  );
}
