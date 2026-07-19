import { useMemo, useState } from "react";
import {
  ArrowUpIcon,
  CheckCircleIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";

import { AgentComposer } from "@/components/AgentComposer";
import { ExecutionSummary } from "@/components/ExecutionSummary";
import { MarkdownContent } from "@/components/MarkdownContent";
import { TaskStatusIcon } from "@/components/taskStatus";
import { UserInputDialog } from "@/components/UserInputDialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker";
import { Message, MessageContent } from "@/components/ui/message";
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
  ResumeRunInput,
  StartTaskInput,
  TaskRunAccepted,
} from "@/runtime/contracts";
import {
  selectActiveMessages,
  selectActiveTask,
  selectConnectionIsConnected,
} from "@/stores/agentSelectors";
import { useAgentStore } from "@/stores/agentStore";

interface ChatPanelProps {
  startTask: (input: StartTaskInput) => Promise<TaskRunAccepted>;
  uploadFiles?: (files: File[], note: string) => Promise<unknown>;
  continueTask?: (
    taskId: string,
    input: { input: string },
  ) => Promise<TaskRunAccepted>;
  resumeRun?: (
    taskId: string,
    runId: string,
    input: ResumeRunInput,
  ) => Promise<void>;
  loadOlderMessages?: (taskId: string) => Promise<void>;
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
  resumeRun,
  loadOlderMessages,
}: ChatPanelProps) {
  const activeTaskId = useAgentStore((state) => state.activeTaskId);
  const activeTask = useAgentStore(selectActiveTask);
  const messages = useAgentStore(selectActiveMessages);
  const connected = useAgentStore(selectConnectionIsConnected);
  const draftInput = useAgentStore((state) => state.draft.input);
  const selectedDatabases = useAgentStore(
    (state) => state.draft.selectedDatabaseIds,
  );
  const draftError = useAgentStore((state) => state.draft.error);
  const setDraftInput = useAgentStore((state) => state.setDraftInput);
  const setDraftError = useAgentStore((state) => state.setDraftError);

  const [submittingDraftKey, setSubmittingDraftKey] = useState<string | null>(null);
  const [importPending, setImportPending] = useState(false);
  const [continuationDrafts, setContinuationDrafts] = useState<Record<string, string>>({});
  const [continuationPendingByTask, setContinuationPendingByTask] = useState<Record<string, boolean>>({});
  const [continuationErrors, setContinuationErrors] = useState<Record<string, string>>({});
  const [olderMessagesPendingByTask, setOlderMessagesPendingByTask] = useState<Record<string, boolean>>({});
  const [olderMessagesErrors, setOlderMessagesErrors] = useState<Record<string, string>>({});

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
  const continuationCanSend =
    continuationEditable &&
    activeTask.summary.active_run_id === null &&
    latestRunIsTerminal(activeTask) &&
    !continuationPending;
  const activeRunId = activeTask?.summary.active_run_id ?? null;
  const activeRunHasAssistantMessage =
    activeRunId !== null &&
    messages.some(
      (message) => message.runId === activeRunId && message.role === "assistant",
    );
  const showActiveRunStatus =
    activeTask?.summary.mode === "agent" &&
    (activeTask.summary.status === "queued" ||
      activeTask.summary.status === "running" ||
      activeTask.summary.status === "finalizing") &&
    activeRunId !== null &&
    !activeRunHasAssistantMessage;
  const activeRunError = useMemo(() => {
    if (activeTask === undefined) return null;
    const latestRunId = activeTask.runOrder[activeTask.runOrder.length - 1];
    return latestRunId === undefined
      ? null
      : activeTask.runsById[latestRunId]?.error ?? null;
  }, [activeTask]);

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
        setDraftError(error instanceof Error ? error.message : "任务提交失败");
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
      setDraftError(error instanceof Error ? error.message : "文件导入失败");
      throw error;
    } finally {
      setImportPending(false);
    }
  };

  const sendContinuation = async () => {
    if (!continuationCanSend || activeTaskId === null || continueTask === undefined) return;
    const taskId = activeTaskId;
    const input = continuationInput.trim();
    if (!input) return;
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
        [taskId]: error instanceof Error ? error.message : "继续提问失败",
      }));
    } finally {
      setContinuationPendingByTask((current) => ({ ...current, [taskId]: false }));
    }
  };

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
        [taskId]: error instanceof Error ? error.message : "更早消息加载失败",
      }));
    } finally {
      setOlderMessagesPendingByTask((current) => ({ ...current, [taskId]: false }));
    }
  };

  const handleDraftKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void submitTask();
  };

  const handleContinuationKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void sendContinuation();
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

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      {!connected && activeTask !== undefined && (
        <Alert variant="destructive" className="mx-4 mt-3 shrink-0">
          <WarningCircleIcon />
          <AlertDescription>事件连接已断开，任务状态暂未更新</AlertDescription>
        </Alert>
      )}

      {activeTask !== undefined && (
        <Marker variant="border" className="shrink-0 px-5 py-2" role="status">
          <MarkerIcon>
            <TaskStatusIcon status={activeTask.summary.status} />
          </MarkerIcon>
          <MarkerContent>{STATUS_LABELS[activeTask.summary.status]}</MarkerContent>
        </Marker>
      )}

      <MessageScrollerProvider autoScroll>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <MessageScroller className="min-w-0 flex-1">
            <MessageScrollerViewport>
              <MessageScrollerContent className="mx-auto w-full max-w-3xl gap-7 px-5 py-6">
                {hasOlderMessages && (
                  <MessageScrollerItem messageId={`older-messages:${activeTaskId}`}>
                    <div className="flex flex-col items-center gap-1">
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

                {messages.length === 0 && (
                  <MessageScrollerItem messageId="empty">
                    <Marker variant="separator">
                      <MarkerContent>该任务暂时没有消息</MarkerContent>
                    </Marker>
                  </MessageScrollerItem>
                )}

                {messages.map((message) => (
                  <MessageScrollerItem
                    key={message.messageId}
                    messageId={message.messageId}
                    scrollAnchor={message.role === "user"}
                  >
                    {message.role === "user" ? (
                      <Message align="end">
                        <MessageContent>
                          <Bubble variant="outline" align="end">
                            <BubbleContent>
                              <MarkdownContent content={message.content} />
                            </BubbleContent>
                          </Bubble>
                        </MessageContent>
                      </Message>
                    ) : (
                      <Message data-message-role="assistant">
                        <MessageContent className="pt-0.5 text-sm leading-7">
                          <Bubble variant="ghost" className="w-full">
                            <BubbleContent className="w-full">
                              <MarkdownContent
                                content={message.content}
                                streaming={
                                  message.runId !== null &&
                                  Object.values(
                                    activeTask?.assistantStreamsByRunId[
                                      message.runId
                                    ]?.streamsById ?? {},
                                  ).some((stream) => stream.active)
                                }
                              />
                              {activeTask !== undefined && message.runId !== null && (
                                <ExecutionSummary
                                  task={activeTask}
                                  runId={message.runId}
                                  active={activeTask.summary.active_run_id === message.runId}
                                />
                              )}
                            </BubbleContent>
                          </Bubble>
                        </MessageContent>
                      </Message>
                    )}
                  </MessageScrollerItem>
                ))}

                {showActiveRunStatus && activeRunId !== null && (
                  <MessageScrollerItem messageId={`live:${activeRunId}:assistant:status`}>
                    <Message data-message-role="assistant-status">
                      <MessageContent>
                        <Bubble variant="ghost" className="w-full">
                          <BubbleContent className="w-full">
                            <Marker role="status">
                              <MarkerIcon><Spinner aria-hidden="true" /></MarkerIcon>
                              <MarkerContent className="shimmer">正在思考…</MarkerContent>
                            </Marker>
                            {activeTask !== undefined && (
                              <ExecutionSummary
                                task={activeTask}
                                runId={activeRunId}
                                active
                              />
                            )}
                          </BubbleContent>
                        </Bubble>
                      </MessageContent>
                    </Message>
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

                {activeTask?.summary.status === "failed" && activeRunError !== null && (
                  <MessageScrollerItem messageId={`failure:${activeTaskId}`}>
                    <Alert variant="destructive" role="alert">
                      <WarningCircleIcon />
                      <AlertDescription>{activeRunError}</AlertDescription>
                    </Alert>
                  </MessageScrollerItem>
                )}
              </MessageScrollerContent>
            </MessageScrollerViewport>
            <MessageScrollerButton />
          </MessageScroller>

          <div className="shrink-0 bg-background px-4 pb-4 pt-2">
            <div className="mx-auto max-w-3xl">
              <AgentComposer
                value={continuationInput}
                onChange={(value) => {
                  setContinuationDrafts((current) => ({ ...current, [activeTaskId]: value }));
                }}
                onSubmit={() => void sendContinuation()}
                onKeyDown={handleContinuationKeyDown}
                placeholder={continuationEditable ? "继续提问..." : continuationDisabledReason}
                ariaLabel="继续提问"
                sendAriaLabel="发送继续问题"
                disabled={!continuationEditable}
                pending={continuationPending}
                sendDisabled={!continuationCanSend || !continuationInput.trim()}
                compact
                className="shadow-md"
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
