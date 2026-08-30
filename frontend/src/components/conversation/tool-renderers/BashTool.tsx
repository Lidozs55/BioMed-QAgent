import { useState } from "react";
import { BracketsCurlyIcon, TerminalIcon } from "@phosphor-icons/react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { unwrapToolOutput } from "@/lib/toolOutput";
import { cn } from "@/lib/utils";

import { CopyButton } from "./CopyButton";
import { ToolCallShell } from "./ToolCallShell";
import { readStringArg, type ToolRendererProps } from "./types";

function formatDuration(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1_000);
  return `${minutes}m${String(seconds).padStart(2, "0")}s`;
}

/**
 * 命令执行专用渲染(bash / workspace_exec):命令首行收起态,
 * 展开为反转终端块(命令 + 输出)。
 *
 * bash 参数是 { command }?workspace_exec 是 { executable, args[] },
 * 这里统一拼成一条命令串展示。
 */
function resolveCommand(item: ToolRendererProps["item"]): string | undefined {
  const command = readStringArg(item.arguments, "command");
  if (command !== undefined) return command;
  const executable = readStringArg(item.arguments, "executable");
  if (executable === undefined) return undefined;
  const args = item.arguments?.args;
  const argText = Array.isArray(args)
    ? args.filter((a): a is string => typeof a === "string").join(" ")
    : "";
  return argText.length > 0 ? `${executable} ${argText}` : executable;
}

export function BashTool({ item, open, onOpenChange }: ToolRendererProps) {
  const command = resolveCommand(item);
  const firstLine = command !== undefined ? command.split("\n")[0] : undefined;
  const unwrapped = unwrapToolOutput(item.output);
  const [showRaw, setShowRaw] = useState(false);
  const hasRawToggle =
    item.output !== null && unwrapped !== null && item.output !== unwrapped.text;
  const outputText = showRaw && item.output !== null ? item.output : unwrapped?.text;
  // 运行时长与超时:来自 exec details,超时时长标红 + tooltip(用户反馈)。
  const durationMs =
    typeof unwrapped?.details?.durationMs === "number"
      ? unwrapped.details.durationMs
      : null;
  const timedOut = unwrapped?.details?.timedOut === true;
  return (
    <ToolCallShell
      item={item}
      open={open}
      onOpenChange={onOpenChange}
      icon={<TerminalIcon />}
      title={<span className="truncate">{firstLine ?? "bash"}</span>}
      badges={
        durationMs !== null ? (
          timedOut ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Badge variant="secondary" className="font-mono text-[11px] text-destructive">
                    {formatDuration(durationMs)}
                  </Badge>
                }
              />
              <TooltipContent>命令运行超时</TooltipContent>
            </Tooltip>
          ) : (
            <Badge variant="secondary" className="font-mono text-[11px]">
              {formatDuration(durationMs)}
            </Badge>
          )
        ) : undefined
      }
    >
      <div
        className={cn(
          "relative rounded-md border border-border bg-terminal p-3 font-mono text-xs leading-5 text-terminal-foreground",
        )}
      >
        {outputText !== undefined && (
          <div className="absolute top-1.5 right-1.5 z-10 flex gap-1">
            {hasRawToggle && (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label="原始输出"
                aria-pressed={showRaw}
                title="原始输出"
                className={cn(
                  "bg-terminal-foreground/10 text-terminal-foreground/70 hover:bg-terminal-foreground/20 hover:text-terminal-foreground",
                  showRaw && "bg-terminal-foreground/20 text-terminal-foreground",
                )}
                onClick={() => setShowRaw((prev) => !prev)}
              >
                <BracketsCurlyIcon aria-hidden="true" />
              </Button>
            )}
            <CopyButton
              text={outputText}
              className="bg-terminal-foreground/10 text-terminal-foreground/70 hover:bg-terminal-foreground/20 hover:text-terminal-foreground"
            />
          </div>
        )}
        <ScrollArea className={outputText !== undefined ? "max-h-72 pr-8" : undefined}>
          <pre className="break-words whitespace-pre-wrap">
            <span className="opacity-60 select-none">$ </span>
            {command}
            {outputText !== undefined && <span>{"\n\n"}{outputText}</span>}
          </pre>
        </ScrollArea>
      </div>
    </ToolCallShell>
  );
}
