import {
  ArrowsClockwiseIcon,
  FlaskIcon,
  PlusCircleIcon,
  TrashIcon,
  WifiHighIcon,
  WifiSlashIcon,
  XIcon,
} from "@phosphor-icons/react";
import { useState } from "react";
import { toast } from "sonner";

import { TaskStatusIcon } from "@/components/taskStatus";
import { TASK_STATUS_META } from "@/components/taskStatusMeta";
import { ThemeToggle } from "@/components/ThemeToggle";
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
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { Spinner } from "@/components/ui/spinner";
import type { RunStatus } from "@/runtime/contracts";
import type { ConnectionStatus, TaskProjection } from "@/runtime/types";
import { useAgentStore } from "@/stores/agentStore";

interface SessionSidebarProps {
  onNewDraft: () => void;
  onSelectTask: (taskId: string) => void | Promise<void>;
  onLoadMore?: () => Promise<void>;
  onRetryHistory?: () => Promise<void>;
  onCancelRun?: (taskId: string, runId: string) => Promise<void>;
  onDeleteTask?: (taskId: string) => Promise<void>;
}

const ACTIVE_STATUSES = new Set<RunStatus>([
  "queued",
  "running",
  "finalizing",
  "cancel_requested",
]);

const OCCUPYING_STATUSES = new Set<RunStatus>([
  "running",
  "finalizing",
  "cancel_requested",
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

function errorDescription(error: unknown): string {
  return error instanceof Error ? error.message : "未知错误";
}

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
  const active = ACTIVE_STATUSES.has(summary.status);
  const cancelling = summary.status === "cancel_requested" || pendingCancel;

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={selected}
        onClick={onSelect}
        tooltip={summary.title}
        aria-label={`${summary.title} ${status.label}`}
        className="min-w-0"
      >
        <TaskStatusIcon status={summary.status} />
        <span className="min-w-0 flex-1 truncate" title={summary.title}>
          {summary.title}
        </span>
        <Badge variant={status.badgeVariant} className="shrink-0">
          {status.label}
        </Badge>
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
  const historyTasks = taskOrder
    .map((taskId) => tasksById[taskId])
    .filter((task): task is TaskProjection => task !== undefined);
  const runningCount = activeTasks.filter((task) =>
    OCCUPYING_STATUSES.has(task.summary.status),
  ).length;
  const connection = CONNECTION_META[connectionStatus];
  const deleteTarget =
    deleteTargetId === null ? undefined : tasksById[deleteTargetId];

  const closeMobile = () => {
    if (isMobile) setOpenMobile(false);
  };

  const selectTask = async (taskId: string) => {
    closeMobile();
    try {
      await onSelectTask(taskId);
    } catch (error) {
      toast.error("打开任务失败", { description: errorDescription(error) });
    }
  };

  const showNewDraft = () => {
    onNewDraft();
    closeMobile();
  };

  const loadMore = async () => {
    if (loadingMore || onLoadMore === undefined) return;
    setLoadingMore(true);
    try {
      await onLoadMore();
    } catch (error) {
      toast.error("历史任务加载失败", {
        description: errorDescription(error),
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
        description: errorDescription(error),
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
      toast.error("取消任务失败", { description: errorDescription(error) });
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
      toast.error("删除任务失败", { description: errorDescription(error) });
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
        <SidebarHeader>
          <div className="flex min-w-0 items-center gap-2 px-2 pt-2">
            <FlaskIcon className="shrink-0 text-sidebar-foreground" />
            <div className="flex min-w-0 flex-col">
              <span className="truncate text-sm font-semibold text-sidebar-foreground">
                BioMed QAgent
              </span>
              <span className="truncate text-xs text-sidebar-foreground/70">
                Durable task workspace
              </span>
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="w-full justify-start"
            onClick={showNewDraft}
          >
            <PlusCircleIcon data-icon="inline-start" />
            新建研究
          </Button>
        </SidebarHeader>

        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>正在进行</SidebarGroupLabel>
            <SidebarGroupContent>
              {activeTasks.length > 0 ? (
                taskRows(activeTasks)
              ) : (
                <Empty className="p-4">
                  <EmptyHeader>
                    <EmptyTitle>没有运行中的任务</EmptyTitle>
                  </EmptyHeader>
                </Empty>
              )}
            </SidebarGroupContent>
          </SidebarGroup>

          <SidebarGroup>
            <SidebarGroupLabel>历史任务</SidebarGroupLabel>
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
              {historyStatus === "loading" && historyTasks.length === 0 ? (
                <div
                  role="status"
                  className="flex items-center gap-2 p-4 text-xs text-muted-foreground"
                >
                  <Spinner aria-hidden="true" />
                  正在加载历史任务
                </div>
              ) : historyTasks.length > 0 ? (
                taskRows(historyTasks)
              ) : historyStatus !== "error" ? (
                <Empty className="p-4">
                  <EmptyHeader>
                    <EmptyTitle>暂无历史任务</EmptyTitle>
                    <EmptyDescription>完成的研究会显示在这里。</EmptyDescription>
                  </EmptyHeader>
                </Empty>
              ) : null}
              {nextCursor !== null && onLoadMore !== undefined && (
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-2 w-full"
                  disabled={loadingMore}
                  aria-label={loadingMore ? "加载中" : "加载更多"}
                  onClick={() => void loadMore()}
                >
                  {loadingMore && (
                    <Spinner data-icon="inline-start" aria-hidden="true" />
                  )}
                  {loadingMore ? "加载中" : "加载更多"}
                </Button>
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
          <div className="px-1">
            <ThemeToggle />
          </div>
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
