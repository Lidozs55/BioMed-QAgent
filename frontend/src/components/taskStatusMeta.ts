import type { RunStatus } from "@/runtime/contracts";

export type StatusBadgeVariant =
  | "default"
  | "secondary"
  | "destructive"
  | "outline";

export const TASK_STATUS_META: Record<
  RunStatus,
  { label: string; badgeVariant: StatusBadgeVariant }
> = {
  queued: { label: "排队中", badgeVariant: "outline" },
  running: { label: "运行中", badgeVariant: "default" },
  finalizing: { label: "收尾中", badgeVariant: "secondary" },
  cancel_requested: { label: "正在取消", badgeVariant: "destructive" },
  awaiting_user_input: { label: "等待确认", badgeVariant: "secondary" },
  completed: { label: "已完成", badgeVariant: "secondary" },
  failed: { label: "失败", badgeVariant: "destructive" },
  cancelled: { label: "已取消", badgeVariant: "outline" },
  interrupted: { label: "已中断", badgeVariant: "destructive" },
};
