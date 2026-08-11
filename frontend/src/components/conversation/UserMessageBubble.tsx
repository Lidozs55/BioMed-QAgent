import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Message, MessageContent } from "@/components/ui/message";
import { stripSteerFraming } from "@/lib/utils";
import type { UserMessageItem } from "@/runtime/types";

interface UserMessageBubbleProps {
  item: UserMessageItem;
}

export function UserMessageBubble({ item }: UserMessageBubbleProps) {
  return (
    <Message align="end">
      <MessageContent>
        <Bubble variant="default" align="end">
          <BubbleContent>
            <span className="whitespace-pre-wrap">
              {stripSteerFraming(item.content)}
            </span>
          </BubbleContent>
        </Bubble>
      </MessageContent>
    </Message>
  );
}
