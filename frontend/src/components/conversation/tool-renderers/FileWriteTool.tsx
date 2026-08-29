import { FilePlusIcon } from "@phosphor-icons/react";

import { Badge } from "@/components/ui/badge";

import { CodeBlock } from "./CodeBlock";
import { DiffView } from "./DiffView";
import { ToolCallShell } from "./ToolCallShell";
import { readStringArg, type ToolRendererProps } from "./types";

/** write 专用渲染:路径 + 新增行数 Badge,展开为全绿新增视图。 */
export function FileWriteTool({ item, open, onOpenChange }: ToolRendererProps) {
  const path = readStringArg(item.arguments, "path");
  const content = readStringArg(item.arguments, "content");
  const added = content !== undefined ? content.split("\n") : [];
  return (
    <ToolCallShell
      item={item}
      open={open}
      onOpenChange={onOpenChange}
      icon={<FilePlusIcon />}
      title={<span className="truncate">{path ?? "write"}</span>}
      badges={
        added.length > 0 ? (
          <Badge variant="secondary" className="font-mono text-[11px]">
            <span className="text-success">+{added.length}</span>
          </Badge>
        ) : undefined
      }
    >
      {content !== undefined ? (
        <DiffView added={added} />
      ) : (
        item.output && <CodeBlock text={item.output} />
      )}
    </ToolCallShell>
  );
}
