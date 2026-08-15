import { MarkdownContent } from "@/components/MarkdownContent";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Message, MessageContent } from "@/components/ui/message";
import type { AssistantSegmentItem } from "@/runtime/types";

interface AssistantSegmentProps {
  item: AssistantSegmentItem;
}

export function AssistantSegment({ item }: AssistantSegmentProps) {
  return (
    <Message align="start">
      <MessageContent>
        <Bubble variant="ghost" className="w-full">
          <BubbleContent className="w-full">
            <MarkdownContent content={item.content} streaming={item.isStreaming} />
          </BubbleContent>
        </Bubble>
      </MessageContent>
    </Message>
  );
}
