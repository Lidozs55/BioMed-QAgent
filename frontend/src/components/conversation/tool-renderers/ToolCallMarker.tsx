import type { ReactNode } from "react";
import {
  CaretDownIcon,
  CheckCircleIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";

import { CollapsibleTrigger } from "@/components/ui/collapsible";
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

interface ToolCallMarkerProps {
  status: "running" | "completed" | "error";
  /** 工具身份图标(phosphor 元素),置于状态图标右侧。 */
  icon: ReactNode;
  /** mono 摘要行:文件路径 / 命令首行 / 中文标签。 */
  title: ReactNode;
  /** 行尾元信息 Badge(read 的行范围、edit 的 ±统计等)。 */
  badges?: ReactNode;
  open: boolean;
}

/**
 * 工具调用收起态触发行:CollapsibleTrigger render 成 Marker(button),
 * 视觉与 PermissionStep 的 border Marker 一致。
 */
export function ToolCallMarker({
  status,
  icon,
  title,
  badges,
  open,
}: ToolCallMarkerProps) {
  const StatusIcon =
    status === "error"
      ? WarningCircleIcon
      : status === "completed"
        ? CheckCircleIcon
        : null;
  return (
    <CollapsibleTrigger
      render={
        <Marker
          variant="border"
          className="cursor-pointer select-none"
          render={<button type="button" className="w-full text-left" />}
        />
      }
    >
      <MarkerIcon aria-hidden="true">
        {status === "running" ? (
          <Spinner aria-hidden="true" />
        ) : StatusIcon ? (
          <StatusIcon />
        ) : null}
      </MarkerIcon>
      {icon ? <MarkerIcon aria-hidden="true">{icon}</MarkerIcon> : null}
      <MarkerContent className="flex min-w-0 flex-1 flex-wrap items-center gap-2 font-mono">
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
