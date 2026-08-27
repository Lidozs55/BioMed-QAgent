import { useState } from "react";
import {
  CaretDownIcon,
  CheckCircleIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";

import { cn } from "@/lib/utils";
import {
  parseDynamicFamilyToolOutputText,
} from "@/lib/familyHost";
import { FamilyHostStatusCard } from "@/components/FamilyHostStatusCard";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Message, MessageContent } from "@/components/ui/message";
import { Spinner } from "@/components/ui/spinner";
import type { DownloadControl, ToolCallItem } from "@/runtime/types";
import { DownloadProgress } from "./DownloadProgress";
import { formatToolCall } from "./toolLabels";

interface ToolCallStepProps {
  item: ToolCallItem;
  /** Pause/resume controls forwarded to download tool calls. */
  downloadControl?: DownloadControl;
}

/**
 * Default tool-call rendering.
 *
 * Phase 2 retired the find_skill/invoke_skill gateway, so no tool-specific
 * renderers remain; every tool call renders through the default bubble with
 * its toolLabels.ts entry (docs/migration/phase2-skills-tools-migration.md).
 * Download tool calls additionally render a live progress strip (bound by the
 * pipeline reducer from operation_progress events) with pause/resume.
 */
export function ToolCallStep({ item, downloadControl }: ToolCallStepProps) {
  const label = formatToolCall(item.toolName, item.arguments);
  const [expanded, setExpanded] = useState(false);
  const isRunning = item.status === "running";
  const isDownload = item.progress?.kind === "downloaded_bytes";
  const dynamicFamilyOutput =
    item.toolName === "submit_dynamic_family_publication"
      ? parseDynamicFamilyToolOutputText(item.output)
      : null;

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
            {isDownload && item.progress != null && (item.status !== "completed" || expanded) && (
              <div className="mt-1.5">
                <DownloadProgress
                  status={item.status}
                  progress={item.progress}
                  control={downloadControl}
                  resume={{
                    runId: item.runId,
                    toolCallId: item.toolCallId,
                    toolName: item.toolName,
                    arguments: item.arguments,
                  }}
                  expanded={expanded}
                />
              </div>
            )}
            {dynamicFamilyOutput !== null && <FamilyHostStatusCard output={dynamicFamilyOutput} />}
            {expanded && (
              <div className="mt-1 flex flex-col gap-1 text-sm">
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
