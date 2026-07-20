import { ChartBarIcon } from "@phosphor-icons/react";

import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Message, MessageContent } from "@/components/ui/message";
import type { ProgressItem } from "@/runtime/types";
import { PROGRESS_LABELS, STAGE_LABELS } from "./stageLabels";

interface ProgressStepProps {
  item: ProgressItem;
}

export function ProgressStep({ item }: ProgressStepProps) {
  const progressLabel = PROGRESS_LABELS[item.progressKind] ?? item.progressKind;
  const totalText = item.total === null ? "" : ` / ${item.total}`;
  return (
    <Message align="start">
      <MessageContent>
        <Bubble variant="ghost" className="w-full">
          <BubbleContent className="w-full gap-2 text-sm text-muted-foreground">
            <ChartBarIcon className="size-4" aria-hidden="true" />
            <span>
              {STAGE_LABELS[item.stage]} · {progressLabel}：{item.current}
              {totalText}
            </span>
          </BubbleContent>
        </Bubble>
      </MessageContent>
    </Message>
  );
}
