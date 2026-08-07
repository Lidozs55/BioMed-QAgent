import {
  ArrowsClockwiseIcon,
  DownloadSimpleIcon,
  GearIcon,
  PlusCircleIcon,
  TrashIcon,
  WifiHighIcon,
  WifiSlashIcon,
  XIcon,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import biomedLogoV2 from "../../../assets/logo/biomed-qagent-logo-v2.svg";

import { TaskStatusIcon } from "@/components/taskStatus";
import { TASK_STATUS_META } from "@/components/taskStatusMeta";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { Spinner } from "@/components/ui/spinner";
import { errorMessage } from "@/lib/utils";
import type { RunStatus } from "@/runtime/contracts";
import type { ConnectionStatus, TaskProjection } from "@/runtime/types";
import { isActiveStatus } from "@/runtime/reducer";
import { useAgentStore } from "@/stores/agentStore";

interface SessionSidebarProps {
  onOpenSettings?: () => void;
  onNewDraft: () => void;
  onSelectTask: (taskId: string) => void | Promise<void>;
  onLoadMore?: () => Promise<void>;
  onRetryHistory?: () => Promise<void>;
  onCancelRun?: (taskId: string, runId: string) => Promise<void>;
  onDeleteTask?: (taskId: string) => Promise<void>;
  onExportCache?: () => void | Promise<void>;
}

const OCCUPYING_STATUSES = new Set<RunStatus>([
  "running",
  "finalizing",
  "cancel_requested",
  "awaiting_user_input",
]);

const CONNECTION_META: Record<
  ConnectionStatus,
  { label: string; pending: boolean }
> = {
  idle: { label: "空闲", pending: false },
  connecting: { label: "连接中", pending: true },
  connected: { label: "已连接", pending: false },
  reconnecting: { label: "重新连接中", pending: true },
  disconnected: { label: "已断开", pending: false },
};

function TaskRow({
  task,
  selected,
  pendingCancel,
  onSelect,
  onCancel,
  onDelete,
}: {
  task: TaskProjection;
  selected: boolean;
  pendingCancel: boolean;
  onSelect: () => void;
  onCancel: () => void;
  onDelete: () => void;
}) {
  const { summary } = task;
  const status = TASK_STATUS_META[summary.status];
  const active = isActiveStatus(summary.status);
  const latestRunId = task.runOrder[task.runOrder.length - 1];
  const latestRun =
    latestRunId === undefined ? null : task.runsById[latestRunId] ?? null;
  const buildStatus = latestRun?.summary?.build_result?.status ?? null;
  const statusIconClass = active
    ? "text-primary"
    : buildStatus === "no_data"
      ? "text-sky-600 dark:text-sky-400"
      : buildStatus === "spec_rejected"
        ? "text-amber-600 dark:text-amber-400"
        : buildStatus === "succeeded" || buildStatus === "partial_success"
          ? "text-emerald-600 dark:text-emerald-400"
          : summary.status === "failed" ||
              summary.status === "cancelled" ||
              summary.status === "interrupted"
            ? "text-destructive"
            : undefined;
  const cancelling = summary.status === "cancel_requested" || pendingCancel;

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={selected}
        onClick={onSelect}
        tooltip={summary.title}
        aria-label={`${summary.title} ${status.label}`}
        className={
          active
            ? "min-w-0"
            : "min-w-0 group-hover/menu-item:bg-sidebar-accent group-hover/menu-item:text-sidebar-accent-foreground"
        }
      >
        <TaskStatusIcon
          status={summary.status}
          buildStatus={buildStatus ?? undefined}
          className={statusIconClass}
        />
        <span className="min-w-0 flex-1 truncate" title={summary.title}>
          {summary.title}
        </span>
      </SidebarMenuButton>
      {active && summary.active_run_id !== null && (
        <SidebarMenuAction
          aria-label={
            cancelling
              ? `正在取消 ${summary.title}`
              : `取消 ${summary.title}`
          }
          title={cancelling ? "正在取消" : "取消任务"}
          disabled={cancelling}
          onClick={onCancel}
        >
          {cancelling ? <Spinner /> : <XIcon />}
        </SidebarMenuAction>
      )}
      {!active && (
        <SidebarMenuAction
          showOnHover
          aria-label={`删除 ${summary.title}`}
          title="删除任务"
          onClick={onDelete}
        >
          <TrashIcon />
        </SidebarMenuAction>
      )}
    </SidebarMenuItem>
  );
}

export function SessionSidebar({
  onNewDraft,
  onSelectTask,
  onLoadMore,
  onRetryHistory,
  onCancelRun,
  onDeleteTask,
  onExportCache,
  onOpenSettings,
}: SessionSidebarProps) {
  const tasksById = useAgentStore((state) => state.tasksById);
  const activeItems = useAgentStore((state) => state.activeItems);
  const taskOrder = useAgentStore((state) => state.taskOrder);
  const activeTaskId = useAgentStore((state) => state.activeTaskId);
  const nextCursor = useAgentStore((state) => state.nextCursor);
  const connectionStatus = useAgentStore((state) => state.connectionStatus);
  const historyStatus = useAgentStore((state) => state.historyStatus);
  const historyError = useAgentStore((state) => state.historyError);
  const { isMobile, setOpenMobile } = useSidebar();
  const [loadingMore, setLoadingMore] = useState(false);
  const [pendingCancels, setPendingCancels] = useState<Set<string>>(
    () => new Set(),
  );
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const activeTasks = activeItems
    .map((taskId) => tasksById[taskId])
    .filter((task): task is TaskProjection => task !== undefined);
  const visibleTaskIds = new Set([...activeItems, ...taskOrder]);
  const visibleTasks = [...visibleTaskIds]
    .map((taskId) => tasksById[taskId])
    .filter((task): task is TaskProjection => task !== undefined);
  const runningCount = activeTasks.filter((task) =>
    OCCUPYING_STATUSES.has(task.summary.status),
  ).length;
  const connection = CONNECTION_META[connectionStatus];
  const deleteTarget =
    deleteTargetId === null ? undefined : tasksById[deleteTargetId];

  const closeMobile = useCallback(() => {
    if (isMobile) setOpenMobile(false);
  }, [isMobile, setOpenMobile]);

  const selectTask = async (taskId: string) => {
    closeMobile();
    try {
      await onSelectTask(taskId);
    } catch (error) {
      toast.error("打开任务失败", { description: errorMessage(error) });
    }
  };

  const showNewDraft = useCallback(() => {
    onNewDraft();
    closeMobile();
  }, [closeMobile, onNewDraft]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "n") {
        event.preventDefault();
        showNewDraft();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [showNewDraft]);

  const loadMore = async () => {
    if (loadingMore || onLoadMore === undefined || nextCursor === null) return;
    setLoadingMore(true);
    try {
      await onLoadMore();
    } catch (error) {
      toast.error("历史任务加载失败", {
        description: errorMessage(error),
      });
    } finally {
      setLoadingMore(false);
    }
  };

  const retryHistory = async () => {
    if (onRetryHistory === undefined || historyStatus === "loading") return;
    try {
      await onRetryHistory();
    } catch (error) {
      toast.error("会话历史加载失败", {
        description: errorMessage(error),
      });
    }
  };

  const cancelTask = async (task: TaskProjection) => {
    const runId = task.summary.active_run_id;
    if (runId === null || onCancelRun === undefined) return;
    setPendingCancels((current) => new Set(current).add(task.summary.task_id));
    try {
      await onCancelRun(task.summary.task_id, runId);
    } catch (error) {
      toast.error("取消任务失败", { description: errorMessage(error) });
    } finally {
      setPendingCancels((current) => {
        const next = new Set(current);
        next.delete(task.summary.task_id);
        return next;
      });
    }
  };

  const confirmDelete = async () => {
    if (deleteTargetId === null || onDeleteTask === undefined || deleting) return;
    setDeleting(true);
    try {
      await onDeleteTask(deleteTargetId);
      setDeleteTargetId(null);
    } catch (error) {
      toast.error("删除任务失败", { description: errorMessage(error) });
    } finally {
      setDeleting(false);
    }
  };

  const taskRows = (tasks: TaskProjection[]) => (
    <SidebarMenu>
      {tasks.map((task) => (
        <TaskRow
          key={task.summary.task_id}
          task={task}
          selected={task.summary.task_id === activeTaskId}
          pendingCancel={pendingCancels.has(task.summary.task_id)}
          onSelect={() => void selectTask(task.summary.task_id)}
          onCancel={() => void cancelTask(task)}
          onDelete={() => setDeleteTargetId(task.summary.task_id)}
        />
      ))}
    </SidebarMenu>
  );

  return (
    <>
      <Sidebar>
        <SidebarHeader className="gap-1 p-1">
          <div className="flex min-w-0 items-center px-1">
            <img
              src={biomedLogoV2}
              alt="BioMed QAgent"
              draggable={false}
              className="h-[95.04px] w-auto max-w-full"
            />
          </div>
          <Button
            variant="outline"
            size="lg"
            className="h-11 w-full justify-start gap-2 px-3"
            onClick={showNewDraft}
          >
            <PlusCircleIcon data-icon="inline-start" className="size-5" />
            <span className="truncate">新建研究</span>
            <span className="ml-auto flex shrink-0 items-center gap-1">
              <kbd className="rounded-md border border-sidebar-border bg-sidebar-accent px-1.5 py-0.5 font-mono text-[10px] font-medium text-sidebar-foreground/70">
                Ctrl
              </kbd>
              <kbd className="rounded-md border border-sidebar-border bg-sidebar-accent px-1.5 py-0.5 font-mono text-[10px] font-medium text-sidebar-foreground/70">
                N
              </kbd>
            </span>
          </Button>
        </SidebarHeader>

        <SidebarContent
          onScroll={(event) => {
            const element = event.currentTarget;
            if (element.scrollHeight - element.scrollTop - element.clientHeight < 160) {
              void loadMore();
            }
          }}
        >
          <SidebarGroup>
            <SidebarGroupContent>
              {historyStatus === "error" && (
                <Alert variant="destructive" className="mb-2">
                  <AlertTitle>会话历史加载失败</AlertTitle>
                  <AlertDescription className="flex flex-col gap-2 break-words">
                    <p>{historyError ?? "暂时无法读取后端会话历史。"}</p>
                    {onRetryHistory !== undefined && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void retryHistory()}
                        aria-label="重试加载历史"
                      >
                        重试
                      </Button>
                    )}
                  </AlertDescription>
                </Alert>
              )}
              {historyStatus === "loading" && visibleTasks.length === 0 ? (
                <div
                  role="status"
                  className="flex items-center gap-2 p-4 text-xs text-muted-foreground"
                >
                  <Spinner aria-hidden="true" />
                  正在加载对话
                </div>
              ) : visibleTasks.length > 0 ? (
                taskRows(visibleTasks)
              ) : historyStatus !== "error" ? (
                <Empty className="p-4">
                  <EmptyHeader>
                    <EmptyTitle>暂无对话</EmptyTitle>
                  </EmptyHeader>
                </Empty>
              ) : null}
              {loadingMore && (
                <div
                  role="status"
                  className="flex items-center justify-center gap-2 p-3 text-xs text-muted-foreground"
                >
                  <Spinner className="size-3.5" aria-hidden="true" />
                  正在加载
                </div>
              )}
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>

        <SidebarFooter className="gap-2">
          <div className="flex items-center justify-between gap-2 px-2">
            <span className="flex min-w-0 items-center gap-2 text-xs">
              {connection.pending ? (
                <ArrowsClockwiseIcon className="shrink-0" />
              ) : connectionStatus === "connected" ? (
                <WifiHighIcon className="shrink-0" />
              ) : (
                <WifiSlashIcon className="shrink-0" />
              )}
              <span className="truncate">连接状态</span>
            </span>
            <Badge
              variant="outline"
              className="shrink-0"
              data-connection-status={connectionStatus}
              aria-label={`${connectionStatus}: ${connection.label}`}
            >
              {connection.label}
            </Badge>
          </div>
          <div className="flex items-center justify-between gap-2 px-2">
            <span className="text-xs text-sidebar-foreground/70">并发槽位</span>
            <Badge variant="secondary">运行中 {runningCount} / 4</Badge>
          </div>
          {onExportCache !== undefined && (
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-start text-sidebar-foreground/70 hover:text-sidebar-accent-foreground"
              onClick={() => {
                try {
                  void onExportCache();
                } catch (error) {
                  toast.error("导出缓存失败", {
                    description: errorMessage(error),
                  });
                }
              }}
              aria-label="导出本地缓存为 ZIP"
              title="导出本地缓存为 ZIP"
            >
              <DownloadSimpleIcon data-icon="inline-start" aria-hidden="true" />
              导出缓存
            </Button>
          )}
          {onOpenSettings !== undefined && (
            <div className="px-1">
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start gap-2 text-sidebar-foreground/70 hover:text-sidebar-accent-foreground"
                onClick={onOpenSettings}
                aria-label="打开设置"
              >
                <GearIcon className="size-4" aria-hidden="true" />
                <span>设置</span>
              </Button>
            </div>
          )}
        </SidebarFooter>
      </Sidebar>

      <AlertDialog
        open={deleteTargetId !== null}
        onOpenChange={(open) => {
          if (!open && !deleting) setDeleteTargetId(null);
        }}
      >
        <AlertDialogContent className="min-w-0 max-w-[calc(100vw-2rem)]">
          <AlertDialogHeader>
            <AlertDialogTitle>删除任务</AlertDialogTitle>
            <AlertDialogDescription className="min-w-0 break-words">
              删除“{deleteTarget?.summary.title ?? "该任务"}”后无法恢复。任务只会在服务端确认删除后从列表移除。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={deleting}
              onClick={() => void confirmDelete()}
            >
              {deleting && <Spinner data-icon="inline-start" />}
              {deleting ? "删除中" : "确认删除"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
