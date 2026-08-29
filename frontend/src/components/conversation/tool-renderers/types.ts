import type { ToolCallItem } from "@/runtime/types";

/** 所有工具调用渲染器的统一 props(展开状态由 ToolCallStep 受控提升)。 */
export interface ToolRendererProps {
  item: ToolCallItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** 读取字符串型参数(path / content / oldText / newText / command / pattern)。 */
export function readStringArg(
  args: Record<string, unknown> | null,
  key: string,
): string | undefined {
  const value = args?.[key];
  return typeof value === "string" ? value : undefined;
}

/** 读取数值型参数(offset / limit / timeout)。 */
export function readNumberArg(
  args: Record<string, unknown> | null,
  key: string,
): number | undefined {
  const value = args?.[key];
  return typeof value === "number" ? value : undefined;
}

/** 统计文本行数(output / content 通用)。 */
export function countLines(text: string): number {
  return text.split("\n").length;
}
