import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Message, MessageContent } from "@/components/ui/message";
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
            {item.injected && (
              <span className="mb-1 block text-right text-[10px] font-medium text-muted-foreground">
                注入的上下文
              </span>
            )}
            <span className="whitespace-pre-wrap">{item.content}</span>
          </BubbleContent>
        </Bubble>
      </MessageContent>
    </Message>
  );
}
