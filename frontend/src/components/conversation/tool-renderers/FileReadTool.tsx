import { FileTextIcon } from "@phosphor-icons/react";

import { Badge } from "@/components/ui/badge";
import type { ToolCallItem } from "@/runtime/types";

import { CodeBlock } from "./CodeBlock";
import { ToolCallShell } from "./ToolCallShell";
import {
  countLines,
  readNumberArg,
  readStringArg,
  type ToolRendererProps,
} from "./types";

/** read 专用渲染:路径 + 行范围 Badge,展开为代码预览。 */
export function FileReadTool({ item, open, onOpenChange }: ToolRendererProps) {
  const path = readStringArg(item.arguments, "path");
  const offset = readNumberArg(item.arguments, "offset");
  const limit = readNumberArg(item.arguments, "limit");
  const range = lineRangeBadge(item, offset, limit);
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
      {item.output && <CodeBlock text={item.output} />}
    </ToolCallShell>
  );
}

function lineRangeBadge(
  item: ToolCallItem,
  offset: number | undefined,
  limit: number | undefined,
): string | null {
  if (offset !== undefined || limit !== undefined) {
    const start = offset ?? 1;
    return `L${start}${limit !== undefined ? `–L${start + limit - 1}` : "+"}`;
  }
  if (item.status !== "running" && item.output) {
    return `L1–L${countLines(item.output)}`;
  }
  return null;
}
