import type { ReactNode } from "react";
import { CaretDownIcon } from "@phosphor-icons/react";

import { Button } from "@/components/ui/button";
import { CollapsibleTrigger } from "@/components/ui/collapsible";
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

interface ToolCallMarkerProps {
  status: "running" | "completed" | "error";
  /** 工具身份图标(phosphor 元素),用颜色区分状态;通用工具可为 null。 */
  icon: ReactNode;
  /** mono 摘要行:文件路径 / 命令首行 / 中文标签。 */
  title: ReactNode;
  /** 行尾元信息 Badge(read 的行范围、edit 的 ±统计等)。 */
  badges?: ReactNode;
  open: boolean;
}

/**
 * 工具调用收起态触发行:CollapsibleTrigger render 成 Marker(button)。
 * 默认无框变体;单一图标位——运行中是 Spinner,完成/出错用工具图标的
 * 颜色区分(用户反馈:独立状态圆圈图标冗余)。
 */
export function ToolCallMarker({
  status,
  icon,
  title,
  badges,
  open,
}: ToolCallMarkerProps) {
  const showErrorTint = status === "error";
  return (
    <CollapsibleTrigger
      render={
        <Marker
          className="cursor-pointer select-none"
          render={
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-auto w-full justify-start px-0 text-left font-normal hover:bg-transparent"
            />
          }
        />
      }
    >
      <MarkerIcon
        aria-hidden="true"
        className={cn(showErrorTint && "text-destructive")}
      >
        {status === "running" ? <Spinner aria-hidden="true" /> : icon}
      </MarkerIcon>
      <MarkerContent
        className={cn(
          "flex min-w-0 flex-1 flex-wrap items-center gap-2 font-mono",
          icon === null && showErrorTint && "text-destructive",
        )}
      >
        {title}
      </MarkerContent>
      {badges}
      <CaretDownIcon
        aria-hidden="true"
        className={cn(
          "ml-auto size-3.5 shrink-0 transition-transform",
          open && "rotate-180",
        )}
      />
    </CollapsibleTrigger>
  );
}
