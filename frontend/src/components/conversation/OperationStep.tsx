import { useState } from "react";
import { CaretDownIcon, SpinnerGapIcon } from "@phosphor-icons/react";

import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
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
 * Manual expand/collapse is preserved via local state.
 */
export function OperationStep({ item }: OperationStepProps) {
  const [expanded, setExpanded] = useState(false);
  const categoryMeta = operationCategoryMeta(item.category);
  const statusMeta = operationStatusMeta(item);
  const label = operationDisplayLabel(item);
  const isRunning = item.status === "running";
  const CategoryIcon = categoryMeta.icon;
  const showDetail = expanded && (item.progress !== null || item.error !== null);

  return (
    <Message align="start">
      <MessageContent>
        <Bubble variant="ghost" className="w-full">
          <BubbleContent className="w-full gap-2 text-sm">
            <button
              type="button"
              onClick={() => setExpanded((prev) => !prev)}
              aria-expanded={expanded}
              className="flex w-full items-center gap-2 text-left"
            >
              <span
                data-testid="operation-icon"
                data-operation-category={item.category ?? ""}
                className={cn("shrink-0", categoryMeta.color)}
              >
                {isRunning ? (
                  <SpinnerGapIcon
                    className="size-4 animate-spin"
                    aria-hidden="true"
                  />
                ) : (
                  <CategoryIcon className="size-4" aria-hidden />
                )}
              </span>
              <span className="font-medium">{label}</span>
              {isRunning && item.progress !== null && (
                <span className="text-sm text-muted-foreground">
                  {item.progress.current}/
                  {item.progress.total ?? "…"}
                </span>
              )}
              <Badge variant={statusMeta.variant}>{statusMeta.label}</Badge>
              <CaretDownIcon
                className={cn(
                  "ml-auto size-3.5 shrink-0 transition-transform",
                  expanded && "rotate-180",
                )}
                aria-hidden="true"
              />
            </button>
            {showDetail && (
              <div className="mt-1 space-y-1">
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
              </div>
            )}
          </BubbleContent>
        </Bubble>
      </MessageContent>
    </Message>
  );
}
