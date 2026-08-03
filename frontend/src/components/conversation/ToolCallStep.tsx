import { useState } from "react";
import {
  CaretDownIcon,
  CheckCircleIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";

import { cn } from "@/lib/utils";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Message, MessageContent } from "@/components/ui/message";
import { Spinner } from "@/components/ui/spinner";
import type { ToolCallItem } from "@/runtime/types";
import { formatToolCall } from "./toolLabels";
import { toolRenderers } from "./toolRenderers";

interface ToolCallStepProps {
  item: ToolCallItem;
}

export function ToolCallStep({ item }: ToolCallStepProps) {
  const Renderer = toolRenderers[item.toolName];
  if (Renderer !== undefined) {
    return <Renderer item={item} />;
  }
  return <DefaultToolCallStep item={item} />;
}

function DefaultToolCallStep({ item }: ToolCallStepProps) {
  const label = formatToolCall(item.toolName, item.arguments);
  const [expanded, setExpanded] = useState(false);
  const isRunning = item.status === "running";

  return (
    <Message align="start">
      <MessageContent>
        <Bubble variant="ghost" className="w-full">
          <BubbleContent className="w-full gap-2">
            <button
              type="button"
              onClick={() => setExpanded((prev) => !prev)}
              aria-expanded={expanded}
              className="flex w-full items-center gap-2 text-left"
            >
              {isRunning ? (
                <Spinner aria-hidden="true" />
              ) : item.status === "error" ? (
                <WarningCircleIcon className="size-4" aria-hidden="true" />
              ) : (
                <CheckCircleIcon className="size-4" aria-hidden="true" />
              )}
              <span className="font-medium">
                {label.verb} {label.target}
              </span>
              {label.details && (
                <span className="text-sm text-muted-foreground">{label.details}</span>
              )}
              <CaretDownIcon
                className={cn(
                  "ml-auto size-3.5 transition-transform",
                  expanded && "rotate-180",
                )}
                aria-hidden="true"
              />
            </button>
            {expanded && (
              <div className="mt-1 space-y-1 text-sm">
                {item.arguments && (
              <details>
                <summary className="cursor-pointer text-muted-foreground">输入参数</summary>
                <pre className="mt-1 overflow-x-auto rounded-md bg-primary-foreground/15 p-2 text-xs">
                  {JSON.stringify(item.arguments, null, 2)}
                </pre>
              </details>
                )}
                {item.output && (
                  <details>
                    <summary className="cursor-pointer text-muted-foreground">
                      输出{item.status === "error" ? "（错误）" : ""}
                    </summary>
                    <pre
                      className={cn(
                        "mt-1 overflow-x-auto rounded-md p-2 text-xs",
                        item.status === "error" ? "bg-destructive/10" : "bg-primary-foreground/15",
                      )}
                    >
                      {item.output}
                    </pre>
                  </details>
                )}
              </div>
            )}
          </BubbleContent>
        </Bubble>
      </MessageContent>
    </Message>
  );
}
