import { WarningCircleIcon } from "@phosphor-icons/react";

import { Badge } from "@/components/ui/badge";
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
          <BubbleContent className="w-full gap-2 text-sm text-yellow-700 dark:text-yellow-400">
            <WarningCircleIcon className="size-4" aria-hidden="true" />
            <span>{item.message}</span>
            <Badge variant="outline">{item.code}</Badge>
          </BubbleContent>
        </Bubble>
      </MessageContent>
    </Message>
  );
}
