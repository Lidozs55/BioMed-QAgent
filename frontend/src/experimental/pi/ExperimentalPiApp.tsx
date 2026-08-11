import { PaperPlaneRightIcon, StopIcon, WrenchIcon } from "@phosphor-icons/react";
import { type FormEvent, useEffect, useMemo, useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Marker, MarkerContent } from "@/components/ui/marker";
import { Message, MessageContent, MessageHeader } from "@/components/ui/message";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { Textarea } from "@/components/ui/textarea";

import { ExperimentalPiClient, type ExperimentalPiApi } from "./client";
import {
  applyExperimentalEvent,
  createExperimentalPiState,
  markExperimentalCancelRequested,
  markExperimentalDisconnected,
  recordAcceptedRun,
  setExperimentalConnection,
} from "./state";
import {
  ExperimentalPiWebSocketTransport,
  type ExperimentalPiLiveHandlers,
  type ExperimentalPiLiveTransport,
} from "./transport";

export interface ExperimentalPiAppProps {
  api?: ExperimentalPiApi;
  transportFactory?: (
    handlers: ExperimentalPiLiveHandlers,
  ) => ExperimentalPiLiveTransport;
}

const defaultApi = new ExperimentalPiClient();
const defaultTransportFactory = (handlers: ExperimentalPiLiveHandlers) =>
  new ExperimentalPiWebSocketTransport(handlers);

function statusLabel(status: string): string {
  return {
    running: "运行中",
    cancel_requested: "正在取消",
    completed: "已完成",
    failed: "失败",
    cancelled: "已取消",
  }[status] ?? status;
}

export function ExperimentalPiApp({
  api = defaultApi,
  transportFactory = defaultTransportFactory,
}: ExperimentalPiAppProps) {
  const [state, setState] = useState(createExperimentalPiState);
  const [input, setInput] = useState("");
  const [submissionError, setSubmissionError] = useState<string | null>(null);
  const handlers = useMemo<ExperimentalPiLiveHandlers>(
    () => ({
      onEvent: (event) => setState((current) => applyExperimentalEvent(current, event)),
      onConnection: (connection) =>
        setState((current) => setExperimentalConnection(current, connection)),
      onControl: (frame) => {
        if (frame.type === "error") setSubmissionError(frame.message);
      },
      onDisconnect: () => setState((current) => markExperimentalDisconnected(current)),
    }),
    [],
  );
  const transport = useMemo(
    () => transportFactory(handlers),
    [handlers, transportFactory],
  );

  useEffect(() => {
    void transport.connect().catch((error: unknown) => {
      setSubmissionError(error instanceof Error ? error.message : "实验连接失败");
      setState((current) => markExperimentalDisconnected(current));
    });
    return () => transport.disconnect();
  }, [transport]);

  const activeRun = [...state.runs]
    .reverse()
    .find((run) => run.status === "running" || run.status === "cancel_requested");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const value = input.trim();
    if (value === "" || activeRun !== undefined) return;
    setSubmissionError(null);
    try {
      const accepted =
        state.taskId === null
          ? await api.createTask(value)
          : await api.createRun(state.taskId, value);
      const isFirstTask = state.taskId === null;
      setState((current) => recordAcceptedRun(current, accepted, value));
      setInput("");
      if (isFirstTask) transport.subscribe(accepted.task_id);
    } catch (error) {
      setSubmissionError(error instanceof Error ? error.message : "实验请求失败");
    }
  };

  const cancel = async () => {
    if (state.taskId === null || activeRun === undefined) return;
    try {
      await api.cancelRun(state.taskId, activeRun.runId);
      setState((current) =>
        markExperimentalCancelRequested(current, activeRun.runId),
      );
    } catch (error) {
      setSubmissionError(error instanceof Error ? error.message : "取消失败");
    }
  };

  return (
    <main className="mx-auto flex h-svh w-full max-w-5xl flex-col gap-3 p-4">
      <Card className="min-h-0 flex-1">
        <CardHeader className="flex-row items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <CardTitle>Pi 实验模式</CardTitle>
            <Badge variant="secondary">opt-in</Badge>
          </div>
          <Badge variant="outline">{state.connection}</Badge>
        </CardHeader>
        <CardContent className="flex min-h-0 flex-1 flex-col gap-3">
          <Alert>
            <AlertTitle>实时实验通道</AlertTitle>
            <AlertDescription>
              仅实时展示，不支持断线回放；此处状态不会写入正式 Task/Event Store。
            </AlertDescription>
          </Alert>
          {state.liveGap && (
            <Alert variant="destructive">
              <AlertTitle>实时流已断开</AlertTitle>
              <AlertDescription>可能缺少事件；请新建实验会话继续验证。</AlertDescription>
            </Alert>
          )}
          {submissionError !== null && (
            <Alert variant="destructive">
              <AlertTitle>实验请求失败</AlertTitle>
              <AlertDescription>{submissionError}</AlertDescription>
            </Alert>
          )}
          <div className="min-h-0 flex-1">
            <MessageScrollerProvider autoScroll>
              <MessageScroller>
                <MessageScrollerViewport>
                  <MessageScrollerContent>
                    {state.runs.flatMap((run) => [
                      <MessageScrollerItem key={`${run.runId}:user`} messageId={`${run.runId}:user`} scrollAnchor>
                        <Message align="end">
                          <MessageContent>
                            <Bubble align="end">
                              <BubbleContent>{run.input}</BubbleContent>
                            </Bubble>
                          </MessageContent>
                        </Message>
                      </MessageScrollerItem>,
                      run.reasoning === "" ? null : (
                        <MessageScrollerItem key={`${run.runId}:reasoning`} messageId={`${run.runId}:reasoning`}>
                          <Marker>
                            <MarkerContent>{run.reasoning}</MarkerContent>
                          </Marker>
                        </MessageScrollerItem>
                      ),
                      run.assistant === "" ? null : (
                        <MessageScrollerItem key={`${run.runId}:assistant`} messageId={`${run.runId}:assistant`}>
                          <Message align="start">
                            <MessageContent>
                              <MessageHeader>Pi assistant</MessageHeader>
                              <Bubble variant="ghost">
                                <BubbleContent>{run.assistant}</BubbleContent>
                              </Bubble>
                            </MessageContent>
                          </Message>
                        </MessageScrollerItem>
                      ),
                      run.datasetBuild === null ? null : (
                        <MessageScrollerItem key={`${run.runId}:dataset-build`} messageId={`${run.runId}:dataset-build`}>
                          <Alert variant={run.datasetBuild.status === "spec_rejected" ? "destructive" : "default"}>
                            <AlertTitle>
                              {run.datasetBuild.status === "succeeded"
                                ? "DatasetBuild 已发布"
                                : "DatasetBuild 未发布"}
                            </AlertTitle>
                            <AlertDescription>
                              {run.datasetBuild.status === "succeeded"
                                ? [
                                    run.datasetBuild.publicationId,
                                    run.datasetBuild.manifestId,
                                    run.datasetBuild.artifactId,
                                  ].filter(Boolean).join(" · ")
                                : run.datasetBuild.reasonCodes.join(" · ")}
                            </AlertDescription>
                          </Alert>
                        </MessageScrollerItem>
                      ),
                      ...run.tools.map((tool) => (
                        <MessageScrollerItem key={`${run.runId}:${tool.toolCallId}`} messageId={`${run.runId}:${tool.toolCallId}`}>
                          <Message align="start">
                            <MessageContent>
                              <Bubble variant={tool.status === "error" ? "destructive" : "outline"}>
                                <BubbleContent className="flex flex-col gap-2">
                                  <div className="flex items-center gap-2 font-medium">
                                    <WrenchIcon aria-hidden="true" />
                                    <span>{tool.toolName}</span>
                                    <Badge variant="secondary">{tool.status}</Badge>
                                  </div>
                                  {tool.output !== null && <pre className="whitespace-pre-wrap text-xs">{tool.output}</pre>}
                                </BubbleContent>
                              </Bubble>
                            </MessageContent>
                          </Message>
                        </MessageScrollerItem>
                      )),
                      <MessageScrollerItem key={`${run.runId}:status`} messageId={`${run.runId}:status`}>
                        <Marker variant="separator">
                          <MarkerContent>{statusLabel(run.status)}</MarkerContent>
                        </Marker>
                      </MessageScrollerItem>,
                    ])}
                  </MessageScrollerContent>
                </MessageScrollerViewport>
                <MessageScrollerButton />
              </MessageScroller>
            </MessageScrollerProvider>
          </div>
          <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-2">
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="experimental-pi-input" className="sr-only">实验消息</FieldLabel>
                <Textarea
                  id="experimental-pi-input"
                  aria-label="实验消息"
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  disabled={activeRun !== undefined}
                  placeholder="输入一条 Pi 实验消息"
                />
              </Field>
            </FieldGroup>
            <div className="flex justify-end gap-2">
              {activeRun !== undefined && (
                <Button type="button" variant="outline" onClick={() => void cancel()} disabled={activeRun.status === "cancel_requested"}>
                  <StopIcon data-icon="inline-start" />
                  取消当前轮次
                </Button>
              )}
              <Button type="submit" disabled={input.trim() === "" || activeRun !== undefined}>
                <PaperPlaneRightIcon data-icon="inline-start" />
                发送
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
