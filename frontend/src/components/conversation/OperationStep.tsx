import { useState } from "react";
import { CaretDownIcon, SpinnerGapIcon } from "@phosphor-icons/react";

import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Message, MessageContent } from "@/components/ui/message";
import type { OperationItem } from "@/runtime/types";
import {
  operationCategoryMeta,
  operationDisplayLabel,
} from "./operationMeta";

interface OperationStepProps {
  item: OperationItem;
}

interface OperationStatusMeta {
  label: string;
  variant: "default" | "secondary" | "destructive" | "outline";
}

function operationStatusMeta(item: OperationItem): OperationStatusMeta {
  switch (item.status) {
    case "running":
      return { label: "运行中", variant: "secondary" };
    case "failed":
      return { label: "失败", variant: "destructive" };
    case "skipped":
      return { label: "已跳过", variant: "outline" };
    case "cancelled":
      return { label: "已取消", variant: "outline" };
    default:
      return { label: "已完成", variant: "outline" };
  }
}

/**
 * One V2 build-execution operation (Design §15.1). While running the row
 * shows an inline progress summary; once terminal it auto-collapses into a
 * compact summary row whose detail (progress/error) is expandable on click.
 * Manual expand/collapse is preserved via local state. Downloads render a
 * dedicated compact progress strip with pause/resume controls.
 */
export function OperationStep({ item }: OperationStepProps) {
  const [expanded, setExpanded] = useState(false);
  const categoryMeta = operationCategoryMeta(item.category);
  const statusMeta = operationStatusMeta(item);
  const label = operationDisplayLabel(item);
  const isRunning = item.status === "running";
  const isDownload = item.progress?.kind === "downloaded_bytes";
  const CategoryIcon = categoryMeta.icon;
  // Byte-level download progress lives on the owning tool-call bubble (the
  // only place it is rendered), so the operation row keeps just its status
  // badge — otherwise the timeline shows two duplicate progress strips.
  const showDetail =
    expanded && item.progress !== null && !isDownload || (expanded && item.error !== null);

  return (
    <Message align="start">
      <MessageContent>
        <Bubble variant="ghost" className="w-full">
          <BubbleContent className="w-full gap-2 text-sm">
            <Collapsible open={expanded} onOpenChange={setExpanded}>
              <CollapsibleTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-auto w-full justify-start gap-2 px-1 text-left font-normal"
                  />
                }
              >
                <span
                  data-testid="operation-icon"
                  data-operation-category={item.category ?? ""}
                  className={cn("shrink-0", categoryMeta.color)}
                >
                  {isRunning ? (
                    <SpinnerGapIcon
                      className="animate-spin"
                      aria-hidden="true"
                    />
                  ) : (
                    <CategoryIcon aria-hidden />
                  )}
                </span>
                <span className="font-medium">{label}</span>
                {isRunning && !isDownload && item.progress !== null && (
                  <span className="text-sm text-muted-foreground">
                    {item.progress.current}/
                    {item.progress.total ?? "…"}
                  </span>
                )}
                <Badge variant={statusMeta.variant}>{statusMeta.label}</Badge>
                <CaretDownIcon
                  className={cn(
                    "ml-auto shrink-0 transition-transform",
                    expanded && "rotate-180",
                  )}
                  aria-hidden="true"
                />
              </CollapsibleTrigger>
              {showDetail ? (
                <CollapsibleContent className="mt-1 flex flex-col gap-1">
                  {item.progress !== null && (
                    <p className="text-xs text-muted-foreground">
                      {item.progress.kind}：
                      <span>
                        {item.progress.current}/{item.progress.total ?? "…"}
                      </span>
                    </p>
                  )}
                  {item.error !== null && (
                    <p className="text-xs text-destructive">{item.error}</p>
                  )}
                </CollapsibleContent>
              ) : null}
            </Collapsible>
          </BubbleContent>
        </Bubble>
      </MessageContent>
    </Message>
  );
}
