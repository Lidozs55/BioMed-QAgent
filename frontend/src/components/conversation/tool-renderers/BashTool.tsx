import { TerminalIcon } from "@phosphor-icons/react";

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
        {unwrapped && (
          <CopyButton text={unwrapped.text} className="absolute top-1.5 right-1.5 z-10" />
        )}
        <ScrollArea className={unwrapped ? "max-h-72 pr-8" : undefined}>
          <pre className="break-words whitespace-pre-wrap">
            <span className="opacity-60 select-none">$ </span>
            {command}
            {unwrapped && <span>{"\n\n"}{unwrapped.text}</span>}
          </pre>
        </ScrollArea>
      </div>
    </ToolCallShell>
  );
}
