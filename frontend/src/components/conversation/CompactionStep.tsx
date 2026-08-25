import {
  CheckCircleIcon,
  InfoIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";

import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Message, MessageContent } from "@/components/ui/message";
import { Spinner } from "@/components/ui/spinner";
import type { CompactionItem } from "@/runtime/types";

interface CompactionStepProps {
  item: CompactionItem;
}

const STATUS_TEXT = {
  running: "正在压缩上下文…",
  completed: "上下文压缩完成",
  no_content: "没有可压缩的对话内容",
  failed: "上下文压缩失败",
} as const;

export function CompactionStep({ item }: CompactionStepProps) {
  const icon = item.status === "running"
    ? <Spinner className="size-4 shrink-0" data-icon="inline-start" aria-hidden="true" />
    : item.status === "completed"
      ? <CheckCircleIcon className="size-4 shrink-0" aria-hidden="true" />
      : item.status === "no_content"
        ? <InfoIcon className="size-4 shrink-0" aria-hidden="true" />
        : <WarningCircleIcon className="size-4 shrink-0" aria-hidden="true" />;
  return (
    <Message align="start">
      <MessageContent>
        <Bubble variant="ghost" className="w-full">
          <BubbleContent className="flex w-full items-start gap-2 text-sm text-muted-foreground">
            <span className="mt-0.5 shrink-0">{icon}</span>
            <span>
              {STATUS_TEXT[item.status]}
              {item.status === "failed" && item.message !== null
                ? `：${item.message}`
                : null}
            </span>
          </BubbleContent>
        </Bubble>
      </MessageContent>
    </Message>
  );
}
