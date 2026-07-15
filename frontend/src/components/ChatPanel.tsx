import { useState } from "react";
import { useAgentStore } from "../stores/agentStore";
import { useAPI } from "../hooks/useAPI";
import type { StartTaskInput, TaskRunAccepted } from "@/runtime/contracts";
import {
  selectActiveArtifacts,
  selectActiveMessages,
  selectActiveTaskIsBusy,
  selectConnectionIsConnected,
} from "@/stores/agentSelectors";
import {
  DownloadIcon,
  FileCodeIcon,
  FileCsvIcon,
  FileTextIcon,
  RobotIcon,
  UserIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button, buttonVariants } from "@/components/ui/button";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker";
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
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "@/components/ui/accordion";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DatabaseSelector } from "./DatabaseSelector";
import ResearchPipeline from "./ResearchPipeline";
import ResultsViewer from "./ResultsViewer";

type TabMode = "setup" | "chat" | "results";

interface ChatPanelProps {
  startTask: (input: StartTaskInput) => Promise<TaskRunAccepted>;
}

/** Format bytes to human-readable size */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

/** Get file extension from filename */
function getExtension(name: string): string {
  const idx = name.lastIndexOf(".");
  if (idx === -1) return "";
  return name.slice(idx + 1).toLowerCase();
}

/** Choose icon based on file extension */
function getFileIcon(name: string) {
  const ext = getExtension(name);
  switch (ext) {
    case "csv":
    case "tsv":
      return FileCsvIcon;
    case "txt":
    case "md":
      return FileTextIcon;
    case "json":
    case "jsonl":
      return FileCodeIcon;
    default:
      return FileTextIcon;
  }
}

/** 研究工作台 — 设置 / 对话 / 结果 三模式切换。 */
export function ChatPanel({ startTask }: ChatPanelProps) {
  const messages = useAgentStore(selectActiveMessages);
  const isRunning = useAgentStore(selectActiveTaskIsBusy);
  const isConnected = useAgentStore(selectConnectionIsConnected);
  const taskId = useAgentStore((state) => state.activeTaskId);
  const artifacts = useAgentStore(selectActiveArtifacts);
  const fixtureError = useAgentStore((state) => state.draft.error);
  const setFixtureError = useAgentStore((state) => state.setDraftError);
  const selectedDatabases = useAgentStore(
    (state) => state.draft.selectedDatabaseIds,
  );
  const { getArtifactUrl } = useAPI();
  const input = useAgentStore((state) => state.draft.input);
  const setInput = useAgentStore((state) => state.setDraftInput);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const [activeTab, setActiveTab] = useState<TabMode>("setup");

  const submitTask = async (mode: StartTaskInput["mode"]) => {
    const trimmed = input.trim();
    if (!trimmed || isSubmitting) return;
    setFixtureError(null);
    setIsSubmitting(true);
    try {
      await startTask({
        input: trimmed,
        databases: selectedDatabases,
        mode,
      });
      setInput("");
      setActiveTab("chat");
    } catch (error) {
      setFixtureError(error instanceof Error ? error.message : "任务提交失败");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSetupSend = () => {
    void submitTask("agent");
  };

  const handleFixtureRun = () => {
    const trimmed = input.trim();
    if (!trimmed || isSubmitting) return;
    setFixtureError(null);
    if (
      selectedDatabases.length !== 2 ||
      !selectedDatabases.includes("pubmed") ||
      !selectedDatabases.includes("geo")
    ) {
      const message = "固定验收案例只能选择 PubMed 和 GEO。";
      setFixtureError(message);
      return;
    }
    void submitTask("fixture");
  };

  const handleChatSend = () => {
    if (taskId === null) handleSetupSend();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (activeTab === "setup") {
        handleSetupSend();
      } else {
        handleChatSend();
      }
    }
  };

  return (
    <div className="flex h-full flex-col">
      <Tabs
        value={activeTab}
        onValueChange={(v) => setActiveTab(v as TabMode)}
        className="flex h-full flex-col"
      >
        <TabsList className="shrink-0 mx-4 mt-2">
          <TabsTrigger value="setup">设置</TabsTrigger>
          <TabsTrigger value="chat">对话</TabsTrigger>
          <TabsTrigger value="results">结果</TabsTrigger>
        </TabsList>

        {/* ── 设置 Tab ─────────────────────────────────────────── */}
        <TabsContent value="setup" className="p-4">
          <Card>
            <CardHeader>
              <CardTitle>研究设置</CardTitle>
              <CardDescription>配置研究目标和数据源</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <Textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="输入研究目标..."
                disabled={isSubmitting}
                className="min-h-20 resize-none"
              />
              <DatabaseSelector
                onToggle={() => setFixtureError(null)}
                disabled={isSubmitting}
              />
              {fixtureError && (
                <Alert variant="destructive">
                  <WarningCircleIcon />
                  <AlertDescription>{fixtureError}</AlertDescription>
                </Alert>
              )}
            </CardContent>
            <CardFooter className="flex flex-col gap-2">
              <Button
                onClick={handleSetupSend}
                disabled={isSubmitting || !input.trim()}
                className="w-full"
              >
                开始研究
              </Button>
              <Button
                variant="outline"
                onClick={handleFixtureRun}
                disabled={isSubmitting || !input.trim()}
                className="w-full"
              >
                运行固定验收案例
              </Button>
              {!isConnected && (
                <p className="text-xs text-muted-foreground">
                  未连接到后端
                </p>
              )}
            </CardFooter>
          </Card>
        </TabsContent>

        {/* ── 对话 Tab ─────────────────────────────────────────── */}
        <TabsContent value="chat" className="flex flex-col flex-1">
          {/* Disconnection banner */}
          {!isConnected && isRunning && (
            <div className="mx-4 mt-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
              事件连接已断开，任务状态暂未更新
            </div>
          )}

          {/* Research pipeline */}
          <div className="shrink-0 px-4 pt-2">
            <ResearchPipeline />
          </div>

          <MessageScrollerProvider autoScroll>
            <div className="flex flex-1 min-h-0 flex-col">
              <MessageScroller className="flex-1">
                <MessageScrollerViewport>
                  <MessageScrollerContent>
                    {messages.length === 0 && (
                      <MessageScrollerItem messageId="empty">
                        <Marker variant="separator">
                          <MarkerContent>
                            输入研究目标开始对话，例如：
                            <br />
                            分析健脾散结方对胰腺癌肝转移的影响
                          </MarkerContent>
                        </Marker>
                      </MessageScrollerItem>
                    )}

                    {messages.map((msg) => (
                      <MessageScrollerItem
                        key={msg.messageId}
                        messageId={msg.messageId}
                        scrollAnchor={msg.role === "user"}
                      >
                        <Message align={msg.role === "user" ? "end" : "start"}>
                          <MessageAvatar>
                            <Avatar>
                              <AvatarFallback>
                                {msg.role === "user" ? (
                                  <UserIcon className="size-4" />
                                ) : (
                                  <RobotIcon className="size-4" />
                                )}
                              </AvatarFallback>
                            </Avatar>
                          </MessageAvatar>
                          <MessageContent>
                            <Bubble>
                              <BubbleContent>{msg.content}</BubbleContent>
                            </Bubble>
                          </MessageContent>
                        </Message>
                      </MessageScrollerItem>
                    ))}

                    {/* Inline artifact cards */}
                    {artifacts.length > 0 && (
                      <MessageScrollerItem messageId="artifacts">
                        <Accordion>
                          {artifacts.map((artifact) => {
                            const Icon = getFileIcon(artifact.name);
                            const ext = getExtension(artifact.name);
                            return (
                              <AccordionItem key={artifact.name} value={artifact.name}>
                                <AccordionTrigger>
                                  <div className="flex items-center gap-2">
                                    <Icon className="size-4 shrink-0 text-muted-foreground" />
                                    <span className="truncate text-sm">
                                      {artifact.name}
                                    </span>
                                    <Badge variant="outline" className="ml-1 shrink-0">
                                      {formatSize(artifact.size)}
                                    </Badge>
                                    {ext && (
                                      <Badge variant="secondary" className="shrink-0">
                                        {ext.toUpperCase()}
                                      </Badge>
                                    )}
                                  </div>
                                </AccordionTrigger>
                                <AccordionContent>
                                  <Card size="sm">
                                    <CardHeader>
                                      <CardTitle className="text-sm">
                                        {artifact.name}
                                      </CardTitle>
                                      <CardDescription>
                                        产物文件 · {formatSize(artifact.size)}
                                      </CardDescription>
                                    </CardHeader>
                                    <CardFooter>
                                      <a
                                        href={getArtifactUrl(
                                          taskId ?? "",
                                          artifact.artifact_id,
                                        )}
                                        download={artifact.name}
                                        className={buttonVariants({
                                          variant: "outline",
                                          size: "sm",
                                        })}
                                      >
                                        <DownloadIcon
                                          data-icon="inline-start"
                                        />
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

                    {isRunning && (
                      <MessageScrollerItem messageId="thinking">
                        <Marker role="status">
                          <MarkerIcon>
                            <Spinner />
                          </MarkerIcon>
                          <MarkerContent>思考中...</MarkerContent>
                        </Marker>
                      </MessageScrollerItem>
                    )}
                  </MessageScrollerContent>
                </MessageScrollerViewport>
                <MessageScrollerButton />
              </MessageScroller>

              {/* 对话输入 */}
              <div className="shrink-0 border-t p-4">
                <div className="flex gap-2">
                  <Textarea
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="当前会话的继续提问将在下一版开放"
                    disabled={taskId !== null || isSubmitting}
                    className="min-h-11 resize-none"
                  />
                  <Button
                    onClick={handleChatSend}
                    disabled={taskId !== null || isSubmitting || !input.trim()}
                  >
                    {isSubmitting ? "提交中..." : "发送"}
                  </Button>
                </div>
              </div>
            </div>
          </MessageScrollerProvider>
        </TabsContent>

        {/* ── 结果 Tab ─────────────────────────────────────────── */}
        <TabsContent value="results" className="flex-1 p-4">
          <ResultsViewer />
        </TabsContent>
      </Tabs>
    </div>
  );
}
