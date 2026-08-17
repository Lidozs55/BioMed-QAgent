import { memo } from "react";

import { MessageScrollerItem } from "@/components/ui/message-scroller";
import type { ConversationItem, DownloadControl } from "@/runtime/types";
import { ConversationStep } from "./ConversationStep";

interface ConversationListProps {
  items: readonly ConversationItem[];
  activeRunId: string | null;
  /** Pause/resume controls forwarded to download operation steps. */
  downloadControl?: DownloadControl;
}

interface ConversationListItemProps {
  item: ConversationItem;
  isActive: boolean;
  downloadControl?: DownloadControl;
}

const ConversationListItem = memo(function ConversationListItem({
  item,
  isActive,
  downloadControl,
}: ConversationListItemProps) {
  return (
    <MessageScrollerItem messageId={item.itemId}>
      <ConversationStep
        item={item}
        isActive={isActive}
        downloadControl={downloadControl}
      />
    </MessageScrollerItem>
  );
});

export function ConversationList({
  items,
  activeRunId,
  downloadControl,
}: ConversationListProps) {
  return (
    <>
      {items.filter((item) => item.kind !== "artifact").map((item) => (
        <ConversationListItem
          key={item.itemId}
          item={item}
          isActive={item.runId === activeRunId}
          downloadControl={downloadControl}
        />
      ))}
    </>
  );
}
