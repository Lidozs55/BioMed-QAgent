import { MessageScrollerContent } from "@/components/ui/message-scroller";
import type { ConversationItem } from "@/runtime/types";
import { ConversationStep } from "./ConversationStep";

interface ConversationListProps {
  items: ConversationItem[];
  activeRunId: string | null;
}

export function ConversationList({ items, activeRunId }: ConversationListProps) {
  return (
    <MessageScrollerContent>
      {items.map((item) => (
        <ConversationStep
          key={item.itemId}
          item={item}
          isActive={item.runId === activeRunId}
        />
      ))}
    </MessageScrollerContent>
  );
}
