import { FilePlusIcon } from "@phosphor-icons/react";

import { Badge } from "@/components/ui/badge";
import { unwrapToolOutput } from "@/lib/toolOutput";

import { CodeBlock } from "./CodeBlock";
import { DiffView } from "./DiffView";
import { ToolCallShell } from "./ToolCallShell";
import { readStringArg, type ToolRendererProps } from "./types";

/**
 * write 专用渲染:路径 + 新增行数 Badge,展开为全绿新增视图;
 * 出错时不显示 diff,直接显示错误信息(用户反馈)。
 */
export function FileWriteTool({ item, open, onOpenChange }: ToolRendererProps) {
  const path = readStringArg(item.arguments, "path");
  const content = readStringArg(item.arguments, "content");
  const isError = item.status === "error";
  const unwrapped = unwrapToolOutput(item.output);
  const added = content !== undefined && !isError ? content.split("\n") : [];
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
      {isError ? (
        unwrapped && (
          <CodeBlock text={unwrapped.text} rawText={item.output ?? undefined} tone="error" />
        )
      ) : content !== undefined ? (
        <DiffView added={added} />
      ) : (
        unwrapped && (
          <CodeBlock text={unwrapped.text} rawText={item.output ?? undefined} />
        )
      )}
    </ToolCallShell>
  );
}
