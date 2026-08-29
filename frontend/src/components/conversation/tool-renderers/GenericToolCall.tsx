import { useMemo } from "react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

import { formatToolCall } from "../toolLabels";
import { CodeBlock } from "./CodeBlock";
import { JsonBlock } from "./JsonBlock";
import { ToolCallShell } from "./ToolCallShell";
import type { ToolRendererProps } from "./types";

/** 输出为 JSON 文本时返回解析结果,否则 null(走纯文本 CodeBlock)。 */
function parseMaybeJson(output: string | null): unknown {
  if (!output) return null;
  const trimmed = output.trim();
  const isObject = trimmed.startsWith("{") && trimmed.endsWith("}");
  const isArray = trimmed.startsWith("[") && trimmed.endsWith("]");
  if (!isObject && !isArray) return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
}

/**
 * 通用工具渲染(领域检索/下载/分析等):保持既有中文标签形态,
 * 参数与输出 JSON 自动格式化。
 */
export function GenericToolCall({ item, open, onOpenChange }: ToolRendererProps) {
  const label = formatToolCall(item.toolName, item.arguments);
  const parsedOutput = useMemo(() => parseMaybeJson(item.output), [item.output]);
  const isError = item.status === "error";
  return (
    <ToolCallShell
      item={item}
      open={open}
      onOpenChange={onOpenChange}
      icon={null}
      title={
        <span className="break-words">
          {label.verb} {label.target}
        </span>
      }
      badges={
        label.details ? (
          <Badge variant="ghost" className="max-w-48 font-normal">
            <span className="truncate">{label.details}</span>
          </Badge>
        ) : undefined
      }
    >
      {item.arguments && (
        <section className="flex w-full flex-col gap-1">
          <span className="text-xs text-muted-foreground">输入参数</span>
          <JsonBlock value={item.arguments} />
        </section>
      )}
      {item.output && (
        <section className="flex w-full flex-col gap-1">
          <span className={cn("text-xs", isError ? "text-destructive" : "text-muted-foreground")}>
            输出{isError ? "（错误）" : ""}
          </span>
          {parsedOutput !== null ? (
            <JsonBlock value={parsedOutput} />
          ) : (
            <CodeBlock text={item.output} tone={isError ? "error" : "default"} />
          )}
        </section>
      )}
    </ToolCallShell>
  );
}
