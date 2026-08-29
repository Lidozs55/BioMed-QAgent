import { GitDiffIcon } from "@phosphor-icons/react";

import { Badge } from "@/components/ui/badge";
import { unwrapToolOutput } from "@/lib/toolOutput";

import { CodeBlock } from "./CodeBlock";
import { DiffView } from "./DiffView";
import { ToolCallShell } from "./ToolCallShell";
import { readStringArg, type ToolRendererProps } from "./types";

/**
 * edit 专用渲染:路径 + ±行数 Badge,展开为红删绿增 diff;
 * 出错时不显示 diff,直接显示错误信息(用户反馈)。
 */
export function FileEditTool({ item, open, onOpenChange }: ToolRendererProps) {
  const path = readStringArg(item.arguments, "path");
  const oldText = readStringArg(item.arguments, "oldText");
  const newText = readStringArg(item.arguments, "newText");
  const isError = item.status === "error";
  const unwrapped = unwrapToolOutput(item.output);
  const deleted = oldText !== undefined && !isError ? oldText.split("\n") : [];
  const added = newText !== undefined && !isError ? newText.split("\n") : [];
  const hasDiff = !isError && (oldText !== undefined || newText !== undefined);
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
      {isError ? (
        unwrapped && <CodeBlock text={unwrapped.text} tone="error" />
      ) : hasDiff ? (
        <DiffView deleted={deleted.length > 0 ? deleted : undefined} added={added} />
      ) : (
        unwrapped && <CodeBlock text={unwrapped.text} />
      )}
    </ToolCallShell>
  );
}
