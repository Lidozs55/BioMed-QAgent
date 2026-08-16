import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUpIcon,
  CheckCircleIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import { toast } from "sonner";

import { AgentComposer } from "@/components/AgentComposer";
import { LoadingScreen } from "@/components/LoadingScreen";
import {
  QueuedMessages,
  type QueuedMessage,
} from "@/components/QueuedMessages";
import { ConversationList } from "@/components/conversation/ConversationList";
import { formatToolCall } from "@/components/conversation/toolLabels";
import { operationDisplayLabel } from "@/components/conversation/operationMeta";
import { STAGE_LABELS } from "@/components/conversation/stageLabels";
import { openSubagentPanel } from "@/components/subagentPanelControl";
import { TaskStatusIcon } from "@/components/taskStatus";
import { UserInputDialog } from "@/components/UserInputDialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { Spinner } from "@/components/ui/spinner";
import type {
  BuildResultStatus,
  DownloadResumeAccepted,
  ResumeRunInput,
  StartTaskInput,
  TaskRunAccepted,
} from "@/runtime/contracts";
import type {
  ConversationItem,
  DownloadControl,
  DownloadResumeRequest,
  RunProjection,
} from "@/runtime/types";
import { errorMessage } from "@/lib/utils";
import { estimateContextTokens } from "@/lib/tokenEstimate";
import { useIsMobile } from "@/hooks/use-mobile";
import {
  selectActiveItem,
  selectActiveItems,
  selectActiveTask,
  selectConnectionIsConnected,
} from "@/stores/agentSelectors";
import { useAgentStore } from "@/stores/agentStore";
import {
  isSubmitKey,
  type FollowUpMode,
  usePreferencesStore,
} from "@/stores/preferencesStore";
import type { ModelInfo, SteerResponse } from "@/hooks/useAPI";

interface ChatPanelProps {
  startTask: (input: StartTaskInput) => Promise<TaskRunAccepted>;
  uploadFiles?: (files: File[], note: string) => Promise<unknown>;
  continueTask?: (
    taskId: string,
    input: { input: string },
  ) => Promise<TaskRunAccepted>;
  /** Cancels the currently running run (used by “调整方向” follow-up mode). */
  cancelRun?: (taskId: string, runId: string) => Promise<void>;
  resumeRun?: (
    taskId: string,
    runId: string,
    input: ResumeRunInput,
  ) => Promise<void>;
  /** Resumes an interrupted download directly (no AI pass, no new run). */
  resumeDownload?: (
    taskId: string,
    input: DownloadResumeRequest,
  ) => Promise<DownloadResumeAccepted>;
  /** Aborts the task's in-flight standalone download. */
  cancelDownload?: (taskId: string) => Promise<void>;
  loadOlderMessages?: (taskId: string) => Promise<void>;
  /** Trigger context compaction on a task */
  compactTask?: (taskId: string) => Promise<void>;
  /** Steer a short text into a task's active run (interrupt + regenerate) */
  injectTaskContext?: (
    taskId: string,
    text: string,
    expectedRunId?: string | null,
  ) => Promise<SteerResponse>;
  /** Available models from settings */
  models?: ModelInfo[];
  /** Whether the user has configured an API key */
  hasApiKey?: boolean;
  /** Opens the settings panel */
  onOpenSettings?: () => void;
  /** Called when the user selects a different model */
  onModelChange?: (modelId: string) => void;
  /** Currently selected model ID */
  selectedModelId?: string;
  /** Context window capacity in tokens from model settings */
  contextWindow?: number;
  /** Non-null when model settings block task creation (e.g. missing context window) */
  runBlockReason?: string | null;
}

const TERMINAL_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

const STATUS_LABELS = {
  queued: "等待执行",
  running: "Agent 正在运行",
  finalizing: "正在整理回复与产物",
  cancel_requested: "正在取消",
  awaiting_user_input: "等待你的确认",
  completed: "任务已完成",
  failed: "任务执行失败",
  cancelled: "任务已取消",
  interrupted: "任务已中断",
} as const;

/**
 * 任务在没有任何新事件（summary.updated_at 不前进）的情况下持续多久后，
 * 前端提示任务可能挂起/异常终止，并给出取消重试入口（异常终止的及时提示）。
 */
const STALL_THRESHOLD_MS = 2 * 60 * 1000;

const BUILD_LABELS: Record<BuildResultStatus, string> = {
  succeeded: "构建成功",
  partial_success: "部分成功",
  no_data: "无数据",
  spec_rejected: "规格被拒",
};

function formatActiveItemStatus(item: ConversationItem): string {
  switch (item.kind) {
    case "tool_call":
      if (item.status !== "running") return STATUS_LABELS.running;
      {
        const label = formatToolCall(item.toolName, item.arguments);
        const parts = [`${label.verb} ${label.target}`];
        if (label.details) parts.push(label.details);
        return parts.join(" · ");
      }
    case "assistant_segment":
      return item.isStreaming ? "正在生成回复…" : STATUS_LABELS.running;
    case "reasoning":
      return item.isStreaming ? "正在思考…" : STATUS_LABELS.running;
    case "stage":
      return STATUS_LABELS.running;
    case "operation":
      return item.status === "running"
        ? operationDisplayLabel(item)
        : STATUS_LABELS.running;
    default:
      return STATUS_LABELS.running;
  }
}

/**
 * Compact secondary text for the latest terminal run, driven by the
 * server-provided ``RunSummary`` (Phase 4a acceptance): build outcomes
 * carry ``user_summary`` + ``recommended_next_action``, failed runs carry
 * the stable ``error_code``/``user_message``, and cancelled/interrupted
 * runs carry ``cancelled_at_stage``. Renders nothing when the run has no
 * summary or none of the structured fields are populated.
 */
function renderLatestRunSummary(
  latestRun: RunProjection | undefined,
): React.ReactNode | null {
  const summary = latestRun?.summary ?? null;
  if (summary === null) return null;
  const lines: string[] = [];
  if (summary.build_result !== null) {
    if (summary.build_result.user_summary.length > 0) {
      lines.push(summary.build_result.user_summary);
    }
    if (summary.build_result.recommended_next_action.length > 0) {
      lines.push(summary.build_result.recommended_next_action);
    }
  } else if (summary.run_status === "failed") {
    if (summary.error_code !== null) {
      lines.push(`错误码：${summary.error_code}`);
    }
    if (summary.user_message !== null && summary.user_message.length > 0) {
      lines.push(summary.user_message);
    }
  } else if (
    (summary.run_status === "cancelled" ||
      summary.run_status === "interrupted") &&
    summary.cancelled_at_stage !== null
  ) {
    lines.push(`取消于${STAGE_LABELS[summary.cancelled_at_stage]}阶段`);
  }
  if (lines.length === 0) return null;
  return (
    <div
      data-slot="latest-run-summary"
      className="flex flex-col gap-0.5 border-b border-border px-5 pb-2 text-xs text-muted-foreground"
    >
      {lines.map((line) => (
        <p key={line}>{line}</p>
      ))}
    </div>
  );
}

function latestRunIsTerminal(
  task: NonNullable<ReturnType<typeof selectActiveTask>>,
) {
  const latestRunId = task.runOrder[task.runOrder.length - 1];
  const latestRun = latestRunId === undefined ? undefined : task.runsById[latestRunId];
  return latestRun !== undefined && TERMINAL_STATUSES.has(latestRun.status);
}

function draftKey(input: string, databases: readonly string[]): string {
  return JSON.stringify({ input, databases });
}

export function ChatPanel({
  startTask,
  uploadFiles,
  continueTask,
  cancelRun,
  resumeRun,
  resumeDownload,
  cancelDownload,
  loadOlderMessages,
  compactTask,
  injectTaskContext,
  models,
  hasApiKey,
  onOpenSettings,
  onModelChange,
  selectedModelId,
  contextWindow,
  runBlockReason,
}: ChatPanelProps) {
  const isMobile = useIsMobile();
  const activeTaskId = useAgentStore((state) => state.activeTaskId);
  const activeTask = useAgentStore(selectActiveTask);
  const items = useAgentStore(selectActiveItems);
  const activeItem = useAgentStore(selectActiveItem);
  const connected = useAgentStore(selectConnectionIsConnected);
  const hydratingTaskId = useAgentStore((state) => state.hydratingTaskId);
  const activeTaskHydrating =
    activeTaskId !== null &&
    activeTaskId === hydratingTaskId &&
    activeTask !== undefined;
  // 周期性心跳：仅当没有任何新事件（updated_at 不前进）时才能发现"卡死"，
  // 所以用一个定时 tick 驱动重算，而非等待 store 变化。
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNowTick(Date.now()), 10_000);
    return () => window.clearInterval(timer);
  }, []);
  const sendShortcut = usePreferencesStore((state) => state.sendShortcut);
  const showContextUsage = usePreferencesStore((state) => state.showContextUsage);
  const followUpMode = usePreferencesStore((state) => state.followUpMode);
  const draftInput = useAgentStore((state) => state.draft.input);
  const selectedDatabases = useAgentStore(
    (state) => state.draft.selectedDatabaseIds,
  );
  const draftError = useAgentStore((state) => state.draft.error);
  const setDraftInput = useAgentStore((state) => state.setDraftInput);
  const setDraftError = useAgentStore((state) => state.setDraftError);

  // Estimate context token usage from conversation items
  const estimatedTokens = useMemo(() => estimateContextTokens(items), [items]);

  // Context compaction handler
  const [, setCompacting] = useState(false);
  const handleCompact = useCallback(async () => {
    if (activeTaskId === null || compactTask === undefined) return;
    // Manual compaction threshold: only allow when usage > 65%
    const pct = contextWindow && contextWindow > 0
      ? Math.round((estimatedTokens / contextWindow) * 100)
      : 0;
    if (pct <= 65) {
      toast.info("上下文占用较低，无需压缩", { description: `当前占用 ${pct}%，超过 65% 时才建议压缩` });
      return;
    }
    setCompacting(true);
    try {
      await compactTask(activeTaskId);
      toast.success("上下文压缩已触发", { description: "早期内容将被摘要以释放上下文空间" });
    } catch (e) {
      toast.error("压缩失败", { description: e instanceof Error ? e.message : "请求失败" });
    } finally {
      setCompacting(false);
    }
  }, [activeTaskId, compactTask, contextWindow, estimatedTokens]);

  const [submittingDraftKey, setSubmittingDraftKey] = useState<string | null>(null);
  const [importPending, setImportPending] = useState(false);
  const [continuationDrafts, setContinuationDrafts] = useState<Record<string, string>>({});
  const [continuationPendingByTask, setContinuationPendingByTask] = useState<Record<string, boolean>>({});
  const [continuationErrors, setContinuationErrors] = useState<Record<string, string>>({});
  const [queuedFollowUps, setQueuedFollowUps] = useState<
    Record<string, QueuedMessage[]>
  >({});
  const [steeringRuns, setSteeringRuns] = useState<Record<string, string | null>>(
    {},
  );
  const [olderMessagesPendingByTask, setOlderMessagesPendingByTask] = useState<Record<string, boolean>>({});
  const [olderMessagesErrors, setOlderMessagesErrors] = useState<Record<string, string>>({});
  // Sentinel observed while the conversation starts scrolled to the newest
  // messages; when the user scrolls up far enough to reach it, earlier
  // messages are fetched automatically (the explicit button remains as a
  // keyboard-accessible fallback).
  const olderSentinelRef = useRef<HTMLDivElement | null>(null);
  const loadEarlierMessagesRef = useRef<() => Promise<void>>(async () => {});

  const continuationInput =
    activeTaskId === null ? "" : continuationDrafts[activeTaskId] ?? "";
  const continuationError =
    activeTaskId === null ? null : continuationErrors[activeTaskId] ?? null;
  const currentDraftKey = draftKey(draftInput, selectedDatabases);
  const isSubmitting = submittingDraftKey === currentDraftKey;
  const dataSourceSelectionMissing = selectedDatabases.length === 0;
  const continuationPending =
    activeTaskId !== null && continuationPendingByTask[activeTaskId] === true;
  const olderMessagesPending =
    activeTaskId !== null && olderMessagesPendingByTask[activeTaskId] === true;
  const olderMessagesError =
    activeTaskId === null ? null : olderMessagesErrors[activeTaskId] ?? null;
  const hasOlderMessages =
    activeTaskId !== null &&
    activeTask !== undefined &&
    activeTask.olderMessagesCursor !== null &&
    loadOlderMessages !== undefined;

  const continuationEditable =
    activeTask !== undefined &&
    activeTask.summary.mode === "agent" &&
    continueTask !== undefined;
  const activeRunId = activeTask?.summary.active_run_id ?? null;
  const stallMs =
    activeTask !== undefined &&
    activeTask.summary.mode === "agent" &&
    (activeTask.summary.status === "running" ||
      activeTask.summary.status === "finalizing")
      ? nowTick - Date.parse(activeTask.summary.updated_at)
      : 0;
  const stalled =
    activeRunId !== null && Number.isFinite(stallMs) && stallMs > STALL_THRESHOLD_MS;
  const cancelStalledRun = useCallback(async () => {
    if (activeTaskId === null || activeTask === undefined) return;
    const runId = activeTask.summary.active_run_id;
    if (runId === null || cancelRun === undefined) return;
    try {
      await cancelRun(activeTaskId, runId);
      toast.success("已发送取消请求", {
        description: "任务将在当前步骤结束后停止，可重新提问重试",
      });
    } catch (error) {
      toast.error("取消失败", {
        description: errorMessage(error, "请稍后重试"),
      });
    }
  }, [activeTaskId, activeTask, cancelRun]);
  /**
   * Pause/resume controls for download operations. Pause cancels the current
   * run when the download belongs to an active host run (the server keeps the
   * partial file for resumable acquisition); a standalone resume has no live
   * run, so pause aborts the in-flight download directly. Resume replays the
   * download onto the original run's event stream — no new run/bubble, the
   * existing progress strip keeps updating.
   */
  const downloadControl = useMemo<DownloadControl | undefined>(() => {
    if (activeTaskId === null || cancelDownload === undefined || resumeDownload === undefined) {
      return undefined;
    }
    return {
      taskId: activeTaskId,
      onPause: async (taskId) => {
        if (activeRunId !== null && cancelRun !== undefined) {
          await cancelRun(taskId, activeRunId);
        } else {
          await cancelDownload(taskId);
        }
      },
      onResume: async (taskId, resume) => {
        await resumeDownload(taskId, resume);
      },
    };
  }, [activeTaskId, activeRunId, cancelDownload, cancelRun, resumeDownload]);
  const activeQueue =
    activeTaskId === null ? [] : (queuedFollowUps[activeTaskId] ?? []);
  // 运行中也可以发送：加入队列等待当前回答结束，或调整方向取消并重引导。
  const continuationSendable =
    continuationEditable &&
    !continuationPending &&
    (activeRunId === null
      ? latestRunIsTerminal(activeTask)
      : activeTask !== undefined);
  const subagentCount = activeTask?.subagentOrder.length ?? 0;
  const activeSubagentCount = activeTask?.subagentOrder.reduce(
    (count, subagentId) => {
      const status = activeTask.subagentsById[subagentId].status;
      return status === "queued" ||
        status === "running" ||
        status === "cancel_requested"
        ? count + 1
        : count;
    },
    0,
  ) ?? 0;
  const activeRunHasAssistantMessage =
    activeRunId !== null &&
    items.some(
      (item) =>
        item.runId === activeRunId && item.kind === "assistant_segment",
    );
  const latestRunId = activeTask?.runOrder[activeTask.runOrder.length - 1];
  const latestRun =
    latestRunId === undefined ? undefined : activeTask?.runsById[latestRunId];
  const buildLabel =
    activeTask?.summary.status === "completed" &&
    latestRun?.summary?.build_result?.status !== undefined
      ? BUILD_LABELS[latestRun.summary.build_result.status]
      : undefined;
  // 后端进入 JSON 缓冲模式时会先 end() 当前 segment
  // （finish_reason="tool_call_pending"），标记为"正在准备工具调用"。
  // 此时虽然有 assistant_segment 但需要显示提示。
  const activeRunPendingToolCall =
    activeRunId !== null &&
    items.some(
      (item) =>
        item.runId === activeRunId &&
        item.kind === "assistant_segment" &&
        item.finishReason === "tool_call_pending",
    );
  const showActiveRunStatus =
    activeTask?.summary.mode === "agent" &&
    (activeTask.summary.status === "queued" ||
      activeTask.summary.status === "running" ||
      activeTask.summary.status === "finalizing") &&
    activeRunId !== null &&
    (!activeRunHasAssistantMessage || activeRunPendingToolCall);
  const continuationDisabledReason = useMemo(() => {
    if (activeTask === undefined) return "选择已完成的 Agent 任务后继续提问";
    if (activeTask.summary.mode !== "agent") return "固定验收任务不支持继续提问";
    if (activeTask.summary.active_run_id !== null) return "可先输入下一条指令，当前回答完成后即可发送";
    if (continuationPending) return "正在提交继续问题";
    return "选择已完成的 Agent 任务后继续提问";
  }, [activeTask, continuationPending]);

  const submitTask = async (mode: StartTaskInput["mode"] = "agent") => {
    const input = draftInput.trim();
    if (!input || isSubmitting) return;
    if (selectedDatabases.length === 0) {
      setDraftError("请至少选择一个数据源");
      return;
    }
    if (runBlockReason) {
      setDraftError(`模型配置不完整：${runBlockReason}。请在设置中配置上下文窗口或选择已有模型。`);
      return;
    }
    const submissionKey = draftKey(input, selectedDatabases);
    setDraftError(null);
    setSubmittingDraftKey(submissionKey);
    try {
      await startTask({ input, databases: selectedDatabases, mode });
      const currentDraft = useAgentStore.getState().draft;
      if (draftKey(currentDraft.input, currentDraft.selectedDatabaseIds) === submissionKey) {
        setDraftInput("");
      }
    } catch (error) {
      const currentDraft = useAgentStore.getState().draft;
      if (draftKey(currentDraft.input, currentDraft.selectedDatabaseIds) === submissionKey) {
        setDraftError(errorMessage(error, "任务提交失败"));
      }
    } finally {
      setSubmittingDraftKey((current) => current === submissionKey ? null : current);
    }
  };

  const submitFiles = async (files: File[], note: string) => {
    if (uploadFiles === undefined || importPending || files.length === 0) return;
    setDraftError(null);
    setImportPending(true);
    try {
      await uploadFiles(files, note);
      const currentDraft = useAgentStore.getState().draft;
      if (currentDraft.input === note) {
        setDraftInput("");
      }
    } catch (error) {
      setDraftError(errorMessage(error, "文件导入失败"));
      throw error;
    } finally {
      setImportPending(false);
    }
  };

  const steerTask = useCallback(
    async (taskId: string, text: string): Promise<boolean> => {
      if (injectTaskContext === undefined) return false;
      if (steeringRuns[taskId] !== undefined) return false;
      const task = useAgentStore.getState().tasksById[taskId];
      const activeRunId = task?.summary.active_run_id ?? null;
      setSteeringRuns((current) => ({ ...current, [taskId]: activeRunId }));
      try {
        const response = await injectTaskContext(taskId, text, activeRunId);
        if (response.message_id && response.content) {
          // 中途转向：后端把标注后的文本写入会话，这里同步显示用户气泡，
          // 使用后端的 message_id 保证刷新/拉历史时不会重复。
          useAgentStore
            .getState()
            .appendSteerMessage(taskId, response.content, response.message_id);
        }
        toast.success("已调整方向，正在重新生成…");
        return true;
      } catch (error) {
        toast.error("调整方向失败", {
          description: errorMessage(error, "请稍后重试"),
        });
        return false;
      } finally {
        setSteeringRuns((current) => {
          const next = { ...current };
          delete next[taskId];
          return next;
        });
      }
    },
    [injectTaskContext, steeringRuns],
  );

  const sendContinuationWithMode = async (mode: FollowUpMode) => {
    if (
      !continuationSendable ||
      activeTaskId === null ||
      activeTask === undefined ||
      continueTask === undefined
    ) {
      return;
    }
    const taskId = activeTaskId;
    const input = continuationInput.trim();
    if (!input) return;

    if (activeRunId !== null || activeQueue.length > 0) {
      if (
        mode === "steer" &&
        activeRunId !== null &&
        injectTaskContext !== undefined
      ) {
        const steered = await steerTask(taskId, input);
        if (steered) {
          setContinuationDrafts((current) =>
            current[taskId] === input ? { ...current, [taskId]: "" } : current,
          );
        }
        return;
      }
      const entry: QueuedMessage = { id: crypto.randomUUID(), input };
      setQueuedFollowUps((current) => {
        const queue = current[taskId] ?? [];
        return {
          ...current,
          [taskId]: mode === "steer" ? [entry, ...queue] : [...queue, entry],
        };
      });
      setContinuationDrafts((current) =>
        current[taskId] === input ? { ...current, [taskId]: "" } : current,
      );
      if (
        mode === "steer" &&
        activeRunId !== null &&
        cancelRun !== undefined
      ) {
        try {
          await cancelRun(taskId, activeRunId);
        } catch (error) {
          toast.error("取消当前回答失败", {
            description: errorMessage(error, "新指令仍将在当前回答结束后自动发送"),
          });
        }
      }
      return;
    }

    setContinuationPendingByTask((current) => ({ ...current, [taskId]: true }));
    setContinuationErrors((current) => {
      const next = { ...current };
      delete next[taskId];
      return next;
    });
    try {
      await continueTask(taskId, { input });
      setContinuationDrafts((current) =>
        current[taskId] === input ? { ...current, [taskId]: "" } : current,
      );
    } catch (error) {
      setContinuationErrors((current) => ({
        ...current,
        [taskId]: errorMessage(error, "继续提问失败"),
      }));
    } finally {
      setContinuationPendingByTask((current) => ({ ...current, [taskId]: false }));
    }
  };

  const sendContinuation = () => {
    void sendContinuationWithMode(followUpMode);
  };

  const submitQueuedInput = useCallback(
    async (taskId: string, input: string) => {
      if (continueTask === undefined) return;
      setContinuationPendingByTask((current) => ({ ...current, [taskId]: true }));
      setContinuationErrors((current) => {
        const next = { ...current };
        delete next[taskId];
        return next;
      });
      try {
        await continueTask(taskId, { input });
        setContinuationDrafts((current) =>
          current[taskId] === input ? { ...current, [taskId]: "" } : current,
        );
      } catch (error) {
        setContinuationErrors((current) => ({
          ...current,
          [taskId]: errorMessage(error, "继续提问失败"),
        }));
      } finally {
        setContinuationPendingByTask((current) => {
          const next = { ...current };
          delete next[taskId];
          return next;
        });
      }
    },
    [continueTask],
  );

  const removeQueued = useCallback((taskId: string, messageId: string) => {
    setQueuedFollowUps((current) => {
      const queue = current[taskId] ?? [];
      return {
        ...current,
        [taskId]: queue.filter((entry) => entry.id !== messageId),
      };
    });
  }, []);

  const editQueued = useCallback(
    (taskId: string, messageId: string) => {
      const entry = (queuedFollowUps[taskId] ?? []).find(
        (item) => item.id === messageId,
      );
      if (entry === undefined) return;
      setContinuationDrafts((current) => ({
        ...current,
        [taskId]: entry.input,
      }));
      removeQueued(taskId, messageId);
    },
    [queuedFollowUps, removeQueued],
  );

  const injectQueued = useCallback(
    async (taskId: string, messageId: string) => {
      const entry = (queuedFollowUps[taskId] ?? []).find(
        (item) => item.id === messageId,
      );
      if (entry === undefined) return;
      const steered = await steerTask(taskId, entry.input);
      if (steered) {
        removeQueued(taskId, messageId);
      }
    },
    [queuedFollowUps, removeQueued, steerTask],
  );

  const reorderQueued = useCallback(
    (taskId: string, fromIndex: number, toIndex: number) => {
      setQueuedFollowUps((current) => {
        const queue = [...(current[taskId] ?? [])];
        if (
          fromIndex < 0 ||
          fromIndex >= queue.length ||
          toIndex < 0 ||
          toIndex >= queue.length
        ) {
          return current;
        }
        const [moved] = queue.splice(fromIndex, 1);
        if (moved === undefined) return current;
        queue.splice(toIndex, 0, moved);
        return { ...current, [taskId]: queue };
      });
    },
    [],
  );

  // 队列：当前回答结束后自动发送队首消息。
  useEffect(() => {
    if (activeTaskId === null || activeTask === undefined) return;
    // 调整方向请求在途时不要自动发送队首，避免与转向后的生成抢跑。
    if (steeringRuns[activeTaskId] !== undefined) return;
    const queue = queuedFollowUps[activeTaskId];
    if (queue === undefined || queue.length === 0) return;
    if (activeTask.summary.active_run_id !== null || !latestRunIsTerminal(activeTask)) {
      return;
    }
    const [first, ...rest] = queue;
    if (first === undefined) return;
    setQueuedFollowUps((current) => ({
      ...current,
      [activeTaskId]: rest,
    }));
    void submitQueuedInput(activeTaskId, first.input);
  }, [activeTask, activeTaskId, queuedFollowUps, steeringRuns, submitQueuedInput]);

  const loadEarlierMessages = async () => {
    if (!hasOlderMessages || activeTaskId === null || loadOlderMessages === undefined || olderMessagesPending) return;
    const taskId = activeTaskId;
    setOlderMessagesPendingByTask((current) => ({ ...current, [taskId]: true }));
    setOlderMessagesErrors((current) => {
      const next = { ...current };
      delete next[taskId];
      return next;
    });
    try {
      await loadOlderMessages(taskId);
    } catch (error) {
      setOlderMessagesErrors((current) => ({
        ...current,
        [taskId]: errorMessage(error, "更早消息加载失败"),
      }));
    } finally {
      setOlderMessagesPendingByTask((current) => ({ ...current, [taskId]: false }));
    }
  };
  // Keep the ref pointing at the latest closure so the observer never needs
  // to be re-created when `loadEarlierMessages` identity changes.
  loadEarlierMessagesRef.current = loadEarlierMessages;

  useEffect(() => {
    const node = olderSentinelRef.current;
    if (!hasOlderMessages || node === null) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          void loadEarlierMessagesRef.current();
        }
      },
      { rootMargin: "96px 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasOlderMessages]);

  const handleDraftKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!isSubmitKey(event, sendShortcut)) return;
    event.preventDefault();
    void submitTask();
  };

  const handleContinuationKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!isSubmitKey(event, sendShortcut)) return;
    event.preventDefault();
    const inverted = event.ctrlKey && event.metaKey;
    if (inverted) {
      void sendContinuationWithMode(
        followUpMode === "queue" ? "steer" : "queue",
      );
      return;
    }
    void sendContinuationWithMode(followUpMode);
  };

  if (activeTaskId === null) {
    return (
      <div className="flex h-full min-h-0 min-w-0 items-center justify-center overflow-y-auto px-4 py-10">
        <div className="w-full max-w-2xl -translate-y-[8vh]">
          <h2 className="mb-7 text-center text-3xl font-semibold tracking-tight">
            今天想研究什么？
          </h2>
          <AgentComposer
            value={draftInput}
            onChange={setDraftInput}
            onSubmit={() => void submitTask()}
            onKeyDown={handleDraftKeyDown}
            placeholder="输入研究目标..."
            ariaLabel="研究目标"
            sendAriaLabel="开始研究"
            pending={isSubmitting || importPending}
            sendDisabled={
              (!draftInput.trim() || dataSourceSelectionMissing) &&
              !importPending
            }
            showDataSources
            onDataSourceChange={() => setDraftError(null)}
            onSubmitFiles={
              uploadFiles !== undefined
                ? (files, note) => submitFiles(files, note)
                : undefined
            }
            onAttachmentError={setDraftError}
            models={models}
            hasApiKey={hasApiKey}
            onOpenSettings={onOpenSettings}
            onModelChange={onModelChange}
            selectedModelId={selectedModelId}
          />
          {(draftError || (draftInput.trim() && dataSourceSelectionMissing)) && (
            <Alert variant="destructive" className="mt-2">
              <WarningCircleIcon />
              <AlertDescription>
                {draftError ?? "请至少选择一个数据源"}
              </AlertDescription>
            </Alert>
          )}
          {!connected && (
            <p className="mt-3 text-center text-xs text-muted-foreground">未连接到后端</p>
          )}
        </div>
      </div>
    );
  }

  if (activeTaskHydrating) {
    return <LoadingScreen />;
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      {!connected && activeTask !== undefined && (
        <Alert variant="destructive" className="mx-4 mt-3 shrink-0">
          <WarningCircleIcon />
          <AlertDescription>事件连接已断开，任务状态暂未更新</AlertDescription>
        </Alert>
      )}

      {activeTask !== undefined && (
        <div className="flex shrink-0 flex-col">
          <Marker variant="border" className="px-5 py-2" role="status">
            <MarkerIcon>
              <TaskStatusIcon
                status={activeTask.summary.status}
                buildStatus={latestRun?.summary?.build_result?.status}
              />
            </MarkerIcon>
            <MarkerContent>
              {activeItem !== undefined && activeTask.summary.status === "running"
                ? formatActiveItemStatus(activeItem)
                : buildLabel ?? STATUS_LABELS[activeTask.summary.status]}
            </MarkerContent>
            {isMobile && subagentCount > 0 ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="ml-auto"
                onClick={openSubagentPanel}
                aria-label={`查看 ${subagentCount} 个子任务`}
              >
                {activeSubagentCount > 0 ? (
                  <Spinner data-icon="inline-start" aria-hidden="true" />
                ) : null}
                <Badge variant="secondary">{activeSubagentCount} 个运行中</Badge>
              </Button>
            ) : null}
          </Marker>
          {renderLatestRunSummary(latestRun)}
        </div>
      )}

      {stalled && (
        <Alert
          variant="destructive"
          className="mx-4 mb-2 shrink-0"
          data-slot="stall-hint"
        >
          <WarningCircleIcon />
          <AlertDescription className="flex flex-wrap items-center gap-2">
            <span>
              任务已约 {Math.max(2, Math.floor(stallMs / 60000))} 分钟没有任何新事件，可能已挂起或网络中断。
              可取消后重新提问，等待中的大文件下载将在重试时自动断点续传。
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="ml-auto"
              onClick={() => void cancelStalledRun()}
              aria-label="取消当前任务"
            >
              取消当前任务
            </Button>
          </AlertDescription>
        </Alert>
      )}

      <MessageScrollerProvider autoScroll>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <MessageScroller className="min-w-0 flex-1">
            <MessageScrollerViewport>
              <MessageScrollerContent className="mx-auto w-full max-w-3xl gap-3 px-5 py-6">
                {hasOlderMessages && (
                  <MessageScrollerItem messageId={`older-messages:${activeTaskId}`}>
                    <div
                      ref={olderSentinelRef}
                      className="flex flex-col items-center gap-1"
                    >
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => void loadEarlierMessages()}
                        disabled={olderMessagesPending}
                        aria-label={olderMessagesPending ? "正在加载更早消息" : "加载更早消息"}
                      >
                        {olderMessagesPending ? <Spinner aria-hidden="true" /> : <ArrowUpIcon aria-hidden="true" />}
                        {olderMessagesPending ? "加载中" : "加载更早消息"}
                      </Button>
                      {olderMessagesError && <p role="alert" className="text-xs text-destructive">{olderMessagesError}</p>}
                    </div>
                  </MessageScrollerItem>
                )}

                {items.length === 0 && (
                  <MessageScrollerItem messageId="empty">
                    <Marker variant="separator">
                      <MarkerContent>该任务暂时没有消息</MarkerContent>
                    </Marker>
                  </MessageScrollerItem>
                )}

                <ConversationList
                  items={items}
                  activeRunId={activeRunId}
                  downloadControl={downloadControl}
                />

                {showActiveRunStatus && activeRunId !== null && (
                  <MessageScrollerItem messageId={`live:${activeRunId}:assistant:status`}>
                    <Marker role="status">
                      <MarkerIcon><Spinner aria-hidden="true" /></MarkerIcon>
                      <MarkerContent className="shimmer">正在思考…</MarkerContent>
                    </Marker>
                  </MessageScrollerItem>
                )}

                {activeTask?.summary.status === "completed" && (
                  <MessageScrollerItem messageId={`complete:${activeTaskId}`}>
                    <Marker variant="separator">
                      <MarkerIcon><CheckCircleIcon aria-hidden="true" /></MarkerIcon>
                      <MarkerContent>任务完成</MarkerContent>
                    </Marker>
                  </MessageScrollerItem>
                )}


              </MessageScrollerContent>
            </MessageScrollerViewport>
            <MessageScrollerButton />
          </MessageScroller>

          <div className="shrink-0 bg-background px-4 pb-4 pt-2">
            <div className="mx-auto max-w-3xl">
              {activeQueue.length > 0 && (
                <div className="mb-2">
                  <QueuedMessages
                    entries={activeQueue}
                    steering={
                      activeTaskId !== null && steeringRuns[activeTaskId] !== undefined
                    }
                    onDelete={(messageId) => {
                      if (activeTaskId !== null) {
                        removeQueued(activeTaskId, messageId);
                      }
                    }}
                    onEdit={(messageId) => {
                      if (activeTaskId !== null) {
                        editQueued(activeTaskId, messageId);
                      }
                    }}
                    onInject={(messageId) => {
                      if (activeTaskId !== null) {
                        void injectQueued(activeTaskId, messageId);
                      }
                    }}
                    onReorder={(from, to) => {
                      if (activeTaskId !== null) {
                        reorderQueued(activeTaskId, from, to);
                      }
                    }}
                  />
                </div>
              )}
              <AgentComposer
                value={continuationInput}
                onChange={(value) => {
                  setContinuationDrafts((current) => ({ ...current, [activeTaskId]: value }));
                }}
                onSubmit={() => void sendContinuation()}
                onKeyDown={handleContinuationKeyDown}
                placeholder={
                  !continuationEditable
                    ? continuationDisabledReason
                    : activeRunId !== null
                      ? followUpMode === "queue"
                        ? "输入后续指令，发送后自动排队…"
                        : "输入新指令，将中断当前回答并切换方向…"
                      : "继续提问..."
                }
                ariaLabel="继续提问"
                sendAriaLabel="发送继续问题"
                disabled={!continuationEditable}
                pending={continuationPending || importPending}
                sendDisabled={!continuationSendable || !continuationInput.trim()}
                compact
                className="shadow-md"
                onSubmitFiles={
                  uploadFiles !== undefined
                    ? (files, note) => submitFiles(files, note)
                    : undefined
                }
                onAttachmentError={setDraftError}
                models={models}
                hasApiKey={hasApiKey}
                onOpenSettings={onOpenSettings}
                onModelChange={onModelChange}
                selectedModelId={selectedModelId}
                contextWindow={showContextUsage ? contextWindow : undefined}
                contextTokensUsed={estimatedTokens}
                onCompact={handleCompact}
              />
              {continuationError && <p role="alert" className="mt-2 px-2 text-xs text-destructive">{continuationError}</p>}
            </div>
          </div>
        </div>
      </MessageScrollerProvider>
      {resumeRun !== undefined && <UserInputDialog task={activeTask} onResumeRun={resumeRun} />}
    </div>
  );
}
