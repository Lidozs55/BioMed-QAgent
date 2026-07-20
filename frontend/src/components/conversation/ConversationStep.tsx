import type { ConversationItem } from "@/runtime/types";
import { ArtifactStep } from "./ArtifactStep";
import { AssistantSegment } from "./AssistantSegment";
import { ProgressStep } from "./ProgressStep";
import { ReasoningBlock } from "./ReasoningBlock";
import { StageStep } from "./StageStep";
import { ToolCallStep } from "./ToolCallStep";
import { UserMessageBubble } from "./UserMessageBubble";
import { WarningStep } from "./WarningStep";

interface ConversationStepProps {
  item: ConversationItem;
  isActive: boolean;
}

export function ConversationStep({ item }: ConversationStepProps) {
  switch (item.kind) {
    case "user_message":
      return <UserMessageBubble item={item} />;
    case "assistant_segment":
      return <AssistantSegment item={item} />;
    case "reasoning":
      return <ReasoningBlock item={item} />;
    case "tool_call":
      return <ToolCallStep item={item} />;
    case "stage":
      return <StageStep item={item} />;
    case "progress":
      return <ProgressStep item={item} />;
    case "warning":
      return <WarningStep item={item} />;
    case "artifact":
      return <ArtifactStep item={item} />;
    default:
      return null;
  }
}
