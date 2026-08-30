import { FileTextIcon } from "@phosphor-icons/react";

import { Badge } from "@/components/ui/badge";
import { unwrapToolOutput } from "@/lib/toolOutput";
import type { ToolCallItem } from "@/runtime/types";

import { CodeBlock } from "./CodeBlock";
import { ToolCallShell } from "./ToolCallShell";
import {
  countLines,
  readNumberArg,
  readStringArg,
  type ToolRendererProps,
} from "./types";

/** read 专用渲染:路径 + 行/字符范围 Badge,展开为文件文本(解包后)。 */
export function FileReadTool({ item, open, onOpenChange }: ToolRendererProps) {
  const path = readStringArg(item.arguments, "path");
  const offset = readNumberArg(item.arguments, "offset");
  const limit = readNumberArg(item.arguments, "limit");
  const unwrapped = unwrapToolOutput(item.output);
  const range = lineRangeBadge(item, offset, limit, unwrapped);
  return (
    <ToolCallShell
      item={item}
      open={open}
      onOpenChange={onOpenChange}
      icon={<FileTextIcon />}
      title={<span className="truncate">{path ?? "read"}</span>}
      badges={
        range ? (
          <Badge variant="secondary" className="font-mono text-[11px]">
            {range}
          </Badge>
        ) : undefined
      }
    >
      {unwrapped && (
        <CodeBlock text={unwrapped.text} rawText={item.output ?? undefined} />
      )}
    </ToolCallShell>
  );
}

/**
 * Badge 语义按工具族区分:workspace_read 的 offset 是字符偏移,展示字符数;
 * Pi read 的 offset/limit 是行号,展示 L 范围;都缺省时按文本行数计。
 */
function lineRangeBadge(
  item: ToolCallItem,
  offset: number | undefined,
  limit: number | undefined,
  unwrapped: ReturnType<typeof unwrapToolOutput>,
): string | null {
  if (item.toolName === "workspace_read") {
    const characters = unwrapped?.details?.characters;
    if (typeof characters === "number") {
      const truncated = unwrapped?.details?.truncated === true;
      return `${characters} 字符${truncated ? " (截断)" : ""}`;
    }
  }
  if (offset !== undefined || limit !== undefined) {
    const start = offset ?? 1;
    return `L${start}${limit !== undefined ? `–L${start + limit - 1}` : "+"}`;
  }
  if (item.status !== "running" && unwrapped) {
    return `L1–L${countLines(unwrapped.text)}`;
  }
  return null;
}
