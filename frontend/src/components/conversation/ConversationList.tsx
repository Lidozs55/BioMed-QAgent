import { MessageScrollerItem } from "@/components/ui/message-scroller";
import type { ConversationItem, DownloadControl } from "@/runtime/types";
import { ConversationStep } from "./ConversationStep";

interface ConversationListProps {
  items: readonly ConversationItem[];
  activeRunId: string | null;
  /** Pause/resume controls forwarded to download operation steps. */
  downloadControl?: DownloadControl;
}

export function ConversationList({
  items,
  activeRunId,
  downloadControl,
}: ConversationListProps) {
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
            downloadControl={downloadControl}
          />
        </MessageScrollerItem>
      ))}
    </>
  );
}
