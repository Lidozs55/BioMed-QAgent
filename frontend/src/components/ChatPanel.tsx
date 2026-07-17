import { useMemo, useState } from "react";

import {
  ArrowUpIcon,
  DownloadIcon,
  RobotIcon,
  UserIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";

import { AgentProgress } from "@/components/AgentProgress";
import { DatabaseSelector } from "@/components/DatabaseSelector";
import ResultsViewer from "@/components/ResultsViewer";
import { UserInputDialog } from "@/components/UserInputDialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group";
import { Marker, MarkerContent } from "@/components/ui/marker";
import { Message, MessageAvatar, MessageContent } from "@/components/ui/message";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { formatSize, getExtension, fileType } from "@/lib/fileUtils";
import type { ResumeRunInput, StartTaskInput, TaskRunAccepted } from "@/runtime/contracts";
import {
  selectActiveArtifacts,
  selectActiveMessages,
  selectActiveTask,
  selectConnectionIsConnected,
} from "@/stores/agentSelectors";
import { useAgentStore } from "@/stores/agentStore";
import { useAPI } from "@/hooks/useAPI";

type TabMode = "setup" | "chat" | "results";

interface ChatPanelProps {
  startTask: (input: StartTaskInput) => Promise<TaskRunAccepted>;
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

function latestRunIsTerminal(task: NonNullable<ReturnType<typeof selectActiveTask>>) {
  const latestRunId = task.runOrder[task.runOrder.length - 1];
  const latestRun = latestRunId === undefined ? undefined : task.runsById[latestRunId];
  return latestRun !== undefined && TERMINAL_STATUSES.has(latestRun.status);
}

function draftKey(input: string, databases: readonly string[]): string {
  return JSON.stringify({ input, databases });
}

export function ChatPanel({
  startTask,
  continueTask,
  resumeRun,
  loadOlderMessages,
}: ChatPanelProps) {
  const activeTaskId = useAgentStore((state) => state.activeTaskId);
  const activeTask = useAgentStore(selectActiveTask);
  const messages = useAgentStore(selectActiveMessages);
  const artifacts = useAgentStore(selectActiveArtifacts);
  const connected = useAgentStore(selectConnectionIsConnected);
  const draftInput = useAgentStore((state) => state.draft.input);
  const selectedDatabases = useAgentStore(
    (state) => state.draft.selectedDatabaseIds,
  );
  const draftError = useAgentStore((state) => state.draft.error);
  const setDraftInput = useAgentStore((state) => state.setDraftInput);
  const setDraftError = useAgentStore((state) => state.setDraftError);
  const { getArtifactUrl } = useAPI();

  const [activeTab, setActiveTab] = useState<TabMode>(
    activeTaskId === null ? "setup" : "chat",
  );
  const [submittingDraftKey, setSubmittingDraftKey] = useState<string | null>(
    null,
  );
  const [continuationDrafts, setContinuationDrafts] = useState<
    Record<string, string>
  >({});
  const [continuationPendingByTask, setContinuationPendingByTask] = useState<
    Record<string, boolean>
  >({});
  const [continuationErrors, setContinuationErrors] = useState<
    Record<string, string>
  >({});
  const [olderMessagesPendingByTask, setOlderMessagesPendingByTask] = useState<
    Record<string, boolean>
  >({});
  const [olderMessagesErrors, setOlderMessagesErrors] = useState<
    Record<string, string>
  >({});

  const continuationInput =
    activeTaskId === null ? "" : continuationDrafts[activeTaskId] ?? "";
  const continuationError =
    activeTaskId === null ? null : continuationErrors[activeTaskId] ?? null;
  const currentDraftKey = draftKey(draftInput, selectedDatabases);
  const isSubmitting = submittingDraftKey === currentDraftKey;
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
  const visibleTab: TabMode =
    activeTaskId === null
      ? "setup"
      : activeTab === "setup"
        ? "chat"
        : activeTab;

  const continuationEnabled =
    activeTask !== undefined &&
    activeTask.summary.mode === "agent" &&
    activeTask.summary.active_run_id === null &&
    latestRunIsTerminal(activeTask) &&
    continueTask !== undefined &&
    !continuationPending;

  const continuationDisabledReason = useMemo(() => {
    if (activeTask === undefined) return "选择已完成的 Agent 任务后继续提问";
    if (activeTask.summary.mode !== "agent") return "固定验收任务不支持继续提问";
    if (activeTask.summary.active_run_id !== null) {
      switch (activeTask.summary.status) {
        case "queued":
          return "任务排队中，请等待执行槽";
        case "running":
          return "任务运行中，请等待当前回答";
        case "finalizing":
          return "任务收尾中，请稍候";
        case "cancel_requested":
          return "任务正在取消，请稍候";
        case "awaiting_user_input":
          return "等待确认计划，请在弹窗中决策";
      }
    }
    return "选择已完成的 Agent 任务后继续提问";
  }, [activeTask]);

  const submitTask = async (mode: StartTaskInput["mode"]) => {
    const input = draftInput.trim();
    if (!input || isSubmitting) return;
    const submissionKey = draftKey(input, selectedDatabases);
    setDraftError(null);
    setSubmittingDraftKey(submissionKey);
    try {
      await startTask({ input, databases: selectedDatabases, mode });
      const currentDraft = useAgentStore.getState().draft;
      if (
        draftKey(currentDraft.input, currentDraft.selectedDatabaseIds) ===
        submissionKey
      ) {
        setDraftInput("");
        setActiveTab("chat");
      }
    } catch (error) {
      const currentDraft = useAgentStore.getState().draft;
      if (
        draftKey(currentDraft.input, currentDraft.selectedDatabaseIds) ===
        submissionKey
      ) {
        setDraftError(error instanceof Error ? error.message : "任务提交失败");
      }
    } finally {
      setSubmittingDraftKey((current) =>
        current === submissionKey ? null : current,
      );
    }
  };

  const runFixture = () => {
    if (!draftInput.trim() || isSubmitting) return;
    if (
      selectedDatabases.length !== 2 ||
      !selectedDatabases.includes("pubmed") ||
      !selectedDatabases.includes("geo")
    ) {
      setDraftError("固定验收案例只能选择 PubMed 和 GEO。");
      return;
    }
    void submitTask("fixture");
  };

  const sendContinuation = async () => {
    if (!continuationEnabled || activeTaskId === null || continueTask === undefined) {
      return;
    }
    const taskId = activeTaskId;
    const input = continuationInput.trim();
    if (!input) return;
    setContinuationPendingByTask((current) => ({
      ...current,
      [taskId]: true,
    }));
    setContinuationErrors((current) => {
      const next = { ...current };
      delete next[taskId];
      return next;
    });
    try {
      await continueTask(taskId, { input });
      setContinuationDrafts((current) => ({ ...current, [taskId]: "" }));
    } catch (error) {
      setContinuationErrors((current) => ({
        ...current,
        [taskId]: error instanceof Error ? error.message : "继续提问失败",
      }));
    } finally {
      setContinuationPendingByTask((current) => ({
        ...current,
        [taskId]: false,
      }));
    }
  };

  const loadEarlierMessages = async () => {
    if (
      !hasOlderMessages ||
      activeTaskId === null ||
      loadOlderMessages === undefined ||
      olderMessagesPending
    ) {
      return;
    }
    const taskId = activeTaskId;
    setOlderMessagesPendingByTask((current) => ({
      ...current,
      [taskId]: true,
    }));
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
        [taskId]:
          error instanceof Error ? error.message : "更早消息加载失败",
      }));
    } finally {
      setOlderMessagesPendingByTask((current) => ({
        ...current,
        [taskId]: false,
      }));
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      event.key !== "Enter" ||
      event.shiftKey ||
      event.nativeEvent.isComposing
    ) {
      return;
    }
    event.preventDefault();
    if (visibleTab === "setup") {
      void submitTask("agent");
    } else {
      void sendContinuation();
    }
  };

  return (
    <div className="flex h-full min-w-0 flex-col">
      <Tabs
        value={visibleTab}
        onValueChange={(value) => setActiveTab(value as TabMode)}
        className="flex h-full min-w-0 flex-col"
      >
        <TabsList className="mx-4 mt-2 shrink-0">
          <TabsTrigger value="setup">设置</TabsTrigger>
          <TabsTrigger value="chat">对话</TabsTrigger>
          <TabsTrigger value="results">结果</TabsTrigger>
        </TabsList>

        <TabsContent value="setup" className="min-w-0 p-4">
          <Card>
            <CardHeader>
              <CardTitle>研究设置</CardTitle>
              <CardDescription>配置研究目标和数据源</CardDescription>
            </CardHeader>
            <FieldGroup className="px-6 pb-4">
              <Field data-invalid={draftError !== null}>
                <FieldLabel htmlFor="research-goal">研究目标</FieldLabel>
                <Textarea
                  id="research-goal"
                  value={draftInput}
                  onChange={(event) => setDraftInput(event.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="输入研究目标..."
                  aria-invalid={draftError !== null}
                  className="min-h-20 resize-none"
                />
                <FieldDescription>
                  新建任务使用独立草稿，不会被后台任务切换覆盖。
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel>数据源</FieldLabel>
                <DatabaseSelector
                  onToggle={() => setDraftError(null)}
                  disabled={isSubmitting}
                />
              </Field>
              {draftError && (
                <Alert variant="destructive">
                  <WarningCircleIcon />
                  <AlertDescription>{draftError}</AlertDescription>
                </Alert>
              )}
            </FieldGroup>
            <CardFooter className="flex flex-col gap-2">
              <Button
                onClick={() => void submitTask("agent")}
                disabled={isSubmitting || !draftInput.trim()}
                className="w-full"
              >
                {isSubmitting && <Spinner data-icon="inline-start" aria-hidden="true" />}
                开始研究
              </Button>
              <Button
                variant="outline"
                onClick={runFixture}
                disabled={isSubmitting || !draftInput.trim()}
                className="w-full"
              >
                运行固定验收案例
              </Button>
              {!connected && (
                <p className="text-xs text-muted-foreground">未连接到后端</p>
              )}
            </CardFooter>
          </Card>
        </TabsContent>

        <TabsContent value="chat" className="flex min-w-0 flex-1 flex-col">
          {!connected && activeTask !== undefined && (
            <Alert variant="destructive" className="mx-4 mt-2">
              <WarningCircleIcon />
              <AlertDescription>事件连接已断开，任务状态暂未更新</AlertDescription>
            </Alert>
          )}

          <div className="min-w-0 shrink-0 px-4 pt-2">
            <AgentProgress task={activeTask} />
          </div>

          <MessageScrollerProvider autoScroll>
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              <MessageScroller className="min-w-0 flex-1">
                <MessageScrollerViewport>
                  <MessageScrollerContent>
                    {hasOlderMessages && activeTaskId !== null && (
                      <MessageScrollerItem
                        messageId={`older-messages:${activeTaskId}`}
                      >
                        <div className="flex flex-col items-center gap-1">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => void loadEarlierMessages()}
                            disabled={olderMessagesPending}
                            aria-label={
                              olderMessagesPending
                                ? "正在加载更早消息"
                                : "加载更早消息"
                            }
                          >
                            {olderMessagesPending ? (
                              <Spinner
                                data-icon="inline-start"
                                aria-hidden="true"
                              />
                            ) : (
                              <ArrowUpIcon
                                data-icon="inline-start"
                                aria-hidden="true"
                              />
                            )}
                            {olderMessagesPending ? "加载中" : "加载更早消息"}
                          </Button>
                          {olderMessagesError && (
                            <p
                              role="alert"
                              className="break-words text-xs text-destructive"
                            >
                              {olderMessagesError}
                            </p>
                          )}
                        </div>
                      </MessageScrollerItem>
                    )}

                    {messages.length === 0 && (
                      <MessageScrollerItem messageId="empty">
                        <Marker variant="separator">
                          <MarkerContent>
                            {activeTask === undefined
                              ? "输入研究目标开始对话，例如："
                              : "该任务暂时没有消息"}
                            {activeTask === undefined && (
                              <>
                                <br />
                                分析健脾散结方对胰腺癌肝转移的影响
                              </>
                            )}
                          </MarkerContent>
                        </Marker>
                      </MessageScrollerItem>
                    )}

                    {messages.map((message) => (
                      <MessageScrollerItem
                        key={message.messageId}
                        messageId={message.messageId}
                        scrollAnchor={message.role === "user"}
                      >
                        <Message align={message.role === "user" ? "end" : "start"}>
                          <MessageAvatar>
                            <Avatar>
                              <AvatarFallback>
                                {message.role === "user" ? (
                                  <UserIcon />
                                ) : (
                                  <RobotIcon />
                                )}
                              </AvatarFallback>
                            </Avatar>
                          </MessageAvatar>
                          <MessageContent>
                            <Bubble>
                              <BubbleContent>{message.content}</BubbleContent>
                            </Bubble>
                          </MessageContent>
                        </Message>
                      </MessageScrollerItem>
                    ))}

                    {activeTaskId !== null && artifacts.length > 0 && (
                      <MessageScrollerItem messageId="artifacts">
                        <Accordion>
                          {artifacts.map((artifact) => {
                            const { Icon } = fileType(artifact.name);
                            const extension = getExtension(artifact.name);
                            return (
                              <AccordionItem key={artifact.artifact_id} value={artifact.artifact_id}>
                                <AccordionTrigger>
                                  <div className="flex min-w-0 items-center gap-2">
                                    <Icon aria-hidden="true" className="shrink-0 text-muted-foreground" />
                                    <span className="min-w-0 truncate text-sm" title={artifact.name}>
                                      {artifact.name}
                                    </span>
                                    <Badge variant="outline" className="shrink-0">
                                      {formatSize(artifact.size)}
                                    </Badge>
                                    {extension && (
                                      <Badge variant="secondary" className="shrink-0">
                                        {extension.toUpperCase()}
                                      </Badge>
                                    )}
                                  </div>
                                </AccordionTrigger>
                                <AccordionContent>
                                  <Card size="sm">
                                    <CardHeader>
                                      <CardTitle className="truncate text-sm" title={artifact.name}>
                                        {artifact.name}
                                      </CardTitle>
                                      <CardDescription>
                                        产物文件 · {formatSize(artifact.size)}
                                      </CardDescription>
                                    </CardHeader>
                                    <CardFooter>
                                      <a
                                        href={getArtifactUrl(activeTaskId, artifact.artifact_id)}
                                        download={artifact.name}
                                        className={buttonVariants({ variant: "outline", size: "sm" })}
                                      >
                                        <DownloadIcon data-icon="inline-start" />
                                        下载文件
                                      </a>
                                    </CardFooter>
                                  </Card>
                                </AccordionContent>
                              </AccordionItem>
                            );
                          })}
                        </Accordion>
                      </MessageScrollerItem>
                    )}
                  </MessageScrollerContent>
                </MessageScrollerViewport>
                <MessageScrollerButton />
              </MessageScroller>

              <div className="min-w-0 shrink-0 border-t p-4">
                <InputGroup className="min-h-11" data-disabled={!continuationEnabled}>
                  <InputGroupAddon align="block-start">
                    <span className="truncate text-xs text-muted-foreground">
                      {continuationEnabled ? "继续提问" : continuationDisabledReason}
                    </span>
                  </InputGroupAddon>
                  <InputGroupTextarea
                    value={continuationInput}
                    onChange={(event) => {
                      if (activeTaskId === null) return;
                      setContinuationDrafts((current) => ({
                        ...current,
                        [activeTaskId]: event.target.value,
                      }));
                    }}
                    onKeyDown={handleKeyDown}
                    placeholder={
                      continuationEnabled
                        ? "输入对当前任务的继续问题..."
                        : continuationDisabledReason
                    }
                    disabled={!continuationEnabled}
                    aria-label="继续提问"
                    className="min-h-11"
                  />
                  <InputGroupAddon align="inline-end">
                    <InputGroupButton
                      size="sm"
                      variant="default"
                      onClick={() => void sendContinuation()}
                      disabled={!continuationEnabled || !continuationInput.trim()}
                      aria-label={continuationPending ? "提交中" : "发送继续问题"}
                    >
                      {continuationPending && (
                        <Spinner data-icon="inline-start" aria-hidden="true" />
                      )}
                      {continuationPending ? "提交中" : "发送"}
                    </InputGroupButton>
                  </InputGroupAddon>
                </InputGroup>
                {continuationError && (
                  <p role="alert" className="mt-2 break-words text-xs text-destructive">
                    {continuationError}
                  </p>
                )}
              </div>
            </div>
          </MessageScrollerProvider>
        </TabsContent>

        <TabsContent value="results" className="min-w-0 flex-1 p-4">
          <ResultsViewer />
        </TabsContent>
      </Tabs>
      {resumeRun !== undefined && (
        <UserInputDialog task={activeTask} onResumeRun={resumeRun} />
      )}
    </div>
  );
}
