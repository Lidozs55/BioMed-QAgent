import type { ConversationItem, DownloadControl } from "@/runtime/types";
import { PublicationReportCard } from "./PublicationReportCard";
import { AssistantSegment } from "./AssistantSegment";
import { CompactionStep } from "./CompactionStep";
import { OperationStep } from "./OperationStep";
import { PermissionStep } from "./PermissionStep";
import { ProgressStep } from "./ProgressStep";
import { ReasoningBlock } from "./ReasoningBlock";
import { StageStep } from "./StageStep";
import { ToolCallStep } from "./ToolCallStep";
import { UserMessageBubble } from "./UserMessageBubble";
import { WarningStep } from "./WarningStep";
interface ConversationStepProps {
  item: ConversationItem;
  isActive: boolean;
  /** Pause/resume controls forwarded to download operation steps. */
  downloadControl?: DownloadControl;
}

export function ConversationStep({ item, downloadControl }: ConversationStepProps) {
  switch (item.kind) {
    case "user_message":
      return <UserMessageBubble item={item} />;
    case "assistant_segment":
      return <AssistantSegment item={item} />;
    case "reasoning":
      return <ReasoningBlock item={item} />;
    case "tool_call":
      return <ToolCallStep item={item} downloadControl={downloadControl} />;
    case "stage":
      return <StageStep item={item} />;
    case "operation":
      return <OperationStep item={item} />;
    case "progress":
      return <ProgressStep item={item} />;
    case "warning":
      return <WarningStep item={item} />;
    case "compaction":
      return <CompactionStep item={item} />;
    case "permission":
      return <PermissionStep item={item} />;
    case "publication_report":
      return <PublicationReportCard item={item} />;
    default:
      return null;
  }
}
