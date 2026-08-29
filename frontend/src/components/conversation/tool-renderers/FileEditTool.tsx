import { GitDiffIcon } from "@phosphor-icons/react";

import { Badge } from "@/components/ui/badge";

import { CodeBlock } from "./CodeBlock";
import { DiffView } from "./DiffView";
import { ToolCallShell } from "./ToolCallShell";
import { readStringArg, type ToolRendererProps } from "./types";

/** edit 专用渲染:路径 + ±行数 Badge,展开为红删绿增 diff。 */
export function FileEditTool({ item, open, onOpenChange }: ToolRendererProps) {
  const path = readStringArg(item.arguments, "path");
  const oldText = readStringArg(item.arguments, "oldText");
  const newText = readStringArg(item.arguments, "newText");
  const deleted = oldText !== undefined ? oldText.split("\n") : [];
  const added = newText !== undefined ? newText.split("\n") : [];
  const hasDiff = oldText !== undefined || newText !== undefined;
  return (
    <ToolCallShell
      item={item}
      open={open}
      onOpenChange={onOpenChange}
      icon={<GitDiffIcon />}
      title={<span className="truncate">{path ?? "edit"}</span>}
      badges={
        hasDiff ? (
          <Badge variant="secondary" className="font-mono text-[11px]">
            <span className="text-success">+{added.length}</span>
            <span className="text-destructive">−{deleted.length}</span>
          </Badge>
        ) : undefined
      }
    >
      {hasDiff ? (
        <DiffView deleted={deleted.length > 0 ? deleted : undefined} added={added} />
      ) : (
        item.output && <CodeBlock text={item.output} />
      )}
    </ToolCallShell>
  );
}
