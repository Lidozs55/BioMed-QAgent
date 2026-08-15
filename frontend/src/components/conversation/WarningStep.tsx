import { WarningCircleIcon } from "@phosphor-icons/react";

import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Message, MessageContent } from "@/components/ui/message";
import type { WarningItem } from "@/runtime/types";

interface WarningStepProps {
  item: WarningItem;
}

export function WarningStep({ item }: WarningStepProps) {
  return (
    <Message align="start">
      <MessageContent>
        <Bubble variant="ghost" className="w-full">
          <BubbleContent className="flex w-full items-start gap-2 text-sm text-warning">
            <WarningCircleIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>{item.message}</span>
          </BubbleContent>
        </Bubble>
      </MessageContent>
    </Message>
  );
}
