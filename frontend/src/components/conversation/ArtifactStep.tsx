import { FileTextIcon } from "@phosphor-icons/react";

import { Badge } from "@/components/ui/badge";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Message, MessageContent } from "@/components/ui/message";
import type { ArtifactItem } from "@/runtime/types";

interface ArtifactStepProps {
  item: ArtifactItem;
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) {
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function ArtifactStep({ item }: ArtifactStepProps) {
  return (
    <Message align="start">
      <MessageContent>
        <Bubble variant="ghost" className="w-full">
          <BubbleContent className="w-full gap-2 text-sm">
            <FileTextIcon className="size-4" aria-hidden="true" />
            <span>生成产物：{item.name}</span>
            <Badge variant="secondary">{formatBytes(item.sizeBytes)}</Badge>
          </BubbleContent>
        </Bubble>
      </MessageContent>
    </Message>
  );
}
