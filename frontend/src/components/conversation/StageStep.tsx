import {
  CheckCircleIcon,
  ProhibitIcon,
  SpinnerGapIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";

import { Badge } from "@/components/ui/badge";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Message, MessageContent } from "@/components/ui/message";
import type { StageItem } from "@/runtime/types";
import { STAGE_LABELS } from "./stageLabels";

interface StageStepProps {
  item: StageItem;
}

interface StageStatusMeta {
  label: string;
  variant: "default" | "secondary" | "destructive" | "outline";
}

function stageStatusMeta(item: StageItem): StageStatusMeta {
  if (item.status === "running") {
    return { label: "运行中", variant: "secondary" };
  }
  if (item.status === "failed") {
    return {
      label: item.stage === "validation" ? "验证失败" : "阶段失败",
      variant: "destructive",
    };
  }
  if (item.status === "skipped") {
    return { label: "已跳过", variant: "outline" };
  }
  return {
    label: item.stage === "validation" ? "验证通过" : "已完成",
    variant: "outline",
  };
}

export function StageStep({ item }: StageStepProps) {
  const meta = stageStatusMeta(item);
  return (
    <Message align="start">
      <MessageContent>
        <Bubble variant="ghost" className="w-full">
          <BubbleContent className="w-full gap-2 text-sm">
            {item.status === "running" ? (
              <SpinnerGapIcon className="size-4 animate-spin" aria-hidden="true" />
            ) : item.status === "failed" ? (
              <WarningCircleIcon className="size-4" aria-hidden="true" />
            ) : item.status === "skipped" ? (
              <ProhibitIcon className="size-4" aria-hidden="true" />
            ) : (
              <CheckCircleIcon className="size-4" aria-hidden="true" />
            )}
            <span>
              阶段：{STAGE_LABELS[item.stage]}
              {item.attempt > 1 ? `（第 ${item.attempt} 次）` : ""}
            </span>
            <Badge variant={meta.variant}>{meta.label}</Badge>
            {item.error && (
              <span className="text-xs text-destructive">{item.error}</span>
            )}
          </BubbleContent>
        </Bubble>
      </MessageContent>
    </Message>
  );
}
