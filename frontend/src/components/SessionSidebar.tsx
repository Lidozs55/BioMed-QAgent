import {
  GearIcon,
  PlusCircleIcon,
  TrashIcon,
  XIcon,
} from "@phosphor-icons/react";
import { memo, useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import biomedLogoV2 from "../../../assets/logo/Logo-title.svg";

import { TaskStatusIcon } from "@/components/taskStatus";
import { TASK_STATUS_META } from "@/components/taskStatusMeta";
import { taskOutcome } from "@/components/taskOutcome";
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
import type { TaskProjection } from "@/runtime/types";
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
}

/**
 * Memoized because ``tasksById`` in the agent store changes on every runtime
 * event (including assistant stream frames); without memoization every event
 * re-rendered every history row, which is noticeable with a long sidebar.
 */
const TaskRow = memo(function TaskRow({
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
  onSelect: (taskId: string) => void;
  onCancel: (task: TaskProjection) => void;
  onDelete: (taskId: string) => void;
}) {
  const { summary } = task;
  const status = TASK_STATUS_META[summary.status];
  const active = isActiveStatus(summary.status);
  const outcome = taskOutcome(task);
  const statusIconClass = active
    ? "text-primary"
    : outcome === "data"
      ? "text-success"
      : outcome === "problem"
        ? "text-destructive"
        : undefined;
  const cancelling = summary.status === "cancel_requested" || pendingCancel;

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={selected}
        onClick={() => onSelect(task.summary.task_id)}
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
          onClick={() => onCancel(task)}
        >
          {cancelling ? <Spinner /> : <XIcon />}
        </SidebarMenuAction>
      )}
      {!active && (
        <SidebarMenuAction
          showOnHover
          aria-label={`删除 ${summary.title}`}
          title="删除任务"
          onClick={() => onDelete(task.summary.task_id)}
        >
          <TrashIcon />
        </SidebarMenuAction>
      )}
    </SidebarMenuItem>
  );
});

export function SessionSidebar({
  onNewDraft,
  onSelectTask,
  onLoadMore,
  onRetryHistory,
  onCancelRun,
  onDeleteTask,
  onOpenSettings,
}: SessionSidebarProps) {
  const tasksById = useAgentStore((state) => state.tasksById);
  const activeItems = useAgentStore((state) => state.activeItems);
  const taskOrder = useAgentStore((state) => state.taskOrder);
  const activeTaskId = useAgentStore((state) => state.activeTaskId);
  const nextCursor = useAgentStore((state) => state.nextCursor);
  const historyStatus = useAgentStore((state) => state.historyStatus);
  const historyError = useAgentStore((state) => state.historyError);
  const { isMobile, setOpenMobile } = useSidebar();
  const [loadingMore, setLoadingMore] = useState(false);
  const [pendingCancels, setPendingCancels] = useState<Set<string>>(
    () => new Set(),
  );
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const visibleTaskIds = new Set([...activeItems, ...taskOrder]);
  const visibleTasks = [...visibleTaskIds]
    .map((taskId) => tasksById[taskId])
    .filter((task): task is TaskProjection => task !== undefined);
  const deleteTarget =
    deleteTargetId === null ? undefined : tasksById[deleteTargetId];

  const closeMobile = useCallback(() => {
    if (isMobile) setOpenMobile(false);
  }, [isMobile, setOpenMobile]);

  const selectTask = useCallback(async (taskId: string) => {
    closeMobile();
    try {
      await onSelectTask(taskId);
    } catch (error) {
      toast.error("打开任务失败", { description: errorMessage(error) });
    }
  }, [closeMobile, onSelectTask]);

  const handleSelectTask = useCallback((taskId: string) => {
    void selectTask(taskId);
  }, [selectTask]);

  const handleDeleteTask = useCallback((taskId: string) => {
    setDeleteTargetId(taskId);
  }, []);

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

  const loadMore = useCallback(async () => {
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
  }, [loadingMore, onLoadMore, nextCursor]);

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

  const cancelTask = useCallback(async (task: TaskProjection) => {
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
  }, [onCancelRun]);

  const handleCancelTask = useCallback((task: TaskProjection) => {
    void cancelTask(task);
  }, [cancelTask]);

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
          onSelect={handleSelectTask}
          onCancel={handleCancelTask}
          onDelete={handleDeleteTask}
        />
      ))}
    </SidebarMenu>
  );

  return (
    <>
      <Sidebar>
        <SidebarHeader className="gap-1 p-2">
          <div className="flex min-w-0 items-center">
            <img
              src={biomedLogoV2}
              alt="BioMed QAgent"
              draggable={false}
              className="h-auto w-full max-w-full"
            />
          </div>
          <Button
            variant="outline"
            size="default"
            className="w-full justify-start gap-2 rounded-md p-2"
            onClick={showNewDraft}
          >
            <PlusCircleIcon data-icon="inline-start" className="size-4" />
            <span className="truncate">新建研究</span>
            <span className="ml-auto flex shrink-0 items-center gap-1">
              <kbd className="rounded-md border border-sidebar-border bg-sidebar-accent px-1.5 py-0.5 font-mono text-xs font-medium text-sidebar-foreground/70">
                Ctrl
              </kbd>
              <kbd className="rounded-md border border-sidebar-border bg-sidebar-accent px-1.5 py-0.5 font-mono text-xs font-medium text-sidebar-foreground/70">
                N
              </kbd>
            </span>
          </Button>
        </SidebarHeader>

        <SidebarContent>
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
              {nextCursor !== null && visibleTasks.length > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full justify-center text-xs text-muted-foreground"
                  disabled={loadingMore}
                  onClick={() => void loadMore()}
                  aria-label="展开显示更多历史对话"
                >
                  {loadingMore && (
                    <Spinner
                      className="size-3.5"
                      data-icon="inline-start"
                      aria-hidden="true"
                    />
                  )}
                  {loadingMore ? "加载中" : "展开显示"}
                </Button>
              )}
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>

        <SidebarFooter>
          {onOpenSettings !== undefined && (
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  onClick={onOpenSettings}
                  aria-label="打开设置"
                >
                  <GearIcon aria-hidden="true" />
                  <span>设置</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
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
