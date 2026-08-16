import { MessageScrollerItem } from "@/components/ui/message-scroller";
import type { ConversationItem } from "@/runtime/types";
import { ConversationStep } from "./ConversationStep";

interface ConversationListProps {
  items: readonly ConversationItem[];
  activeRunId: string | null;
}

export function ConversationList({ items, activeRunId }: ConversationListProps) {
  return (
    <>
      {items.filter((item) => item.kind !== "artifact").map((item) => (
        <MessageScrollerItem
          key={item.itemId}
          messageId={item.itemId}
          scrollAnchor={item.kind === "user_message"}
        >
          <ConversationStep
            item={item}
            isActive={item.runId === activeRunId}
          />
        </MessageScrollerItem>
      ))}
    </>
  );
}
