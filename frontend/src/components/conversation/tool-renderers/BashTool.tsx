import { TerminalIcon } from "@phosphor-icons/react";

import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

import { CopyButton } from "./CopyButton";
import { ToolCallShell } from "./ToolCallShell";
import { readStringArg, type ToolRendererProps } from "./types";

/** bash 专用渲染:命令首行收起态,展开为反转终端块(命令 + 输出)。 */
export function BashTool({ item, open, onOpenChange }: ToolRendererProps) {
  const command = readStringArg(item.arguments, "command");
  const firstLine = command !== undefined ? command.split("\n")[0] : undefined;
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
        {item.output && (
          <CopyButton text={item.output} className="absolute top-1.5 right-1.5 z-10" />
        )}
        <ScrollArea className={item.output ? "max-h-72 pr-8" : undefined}>
          <pre className="break-words whitespace-pre-wrap">
            <span className="opacity-60 select-none">$ </span>
            {command}
            {item.output && <span>{"\n\n"}{item.output}</span>}
          </pre>
        </ScrollArea>
      </div>
    </ToolCallShell>
  );
}
