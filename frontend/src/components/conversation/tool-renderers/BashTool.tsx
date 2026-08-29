import { useState } from "react";
import { BracketsCurlyIcon, TerminalIcon } from "@phosphor-icons/react";

import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { unwrapToolOutput } from "@/lib/toolOutput";
import { cn } from "@/lib/utils";

import { CopyButton } from "./CopyButton";
import { ToolCallShell } from "./ToolCallShell";
import { readStringArg, type ToolRendererProps } from "./types";

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
  return (
    <ToolCallShell
      item={item}
      open={open}
      onOpenChange={onOpenChange}
      icon={<TerminalIcon />}
      title={<span className="truncate">{firstLine ?? "bash"}</span>}
    >
      <div
        className={cn(
          "relative rounded-md bg-card-foreground p-3 font-mono text-xs leading-5 text-background",
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
                  "bg-background/80 text-muted-foreground hover:text-foreground",
                  showRaw && "bg-muted text-foreground",
                )}
                onClick={() => setShowRaw((prev) => !prev)}
              >
                <BracketsCurlyIcon aria-hidden="true" />
              </Button>
            )}
            <CopyButton text={outputText} />
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
