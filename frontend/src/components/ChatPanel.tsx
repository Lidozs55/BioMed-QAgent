import { useState, useEffect } from "react";
import { useAgentStore } from "../stores/agentStore";
import { useAgentStream } from "../hooks/useAgentStream";
import { useAPI } from "../hooks/useAPI";
import {
  DownloadIcon,
  FileCodeIcon,
  FileCsvIcon,
  FileTextIcon,
  RobotIcon,
  UserIcon,
} from "@phosphor-icons/react";
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
export function ChatPanel() {
  const { messages, isRunning, isConnected, taskId } = useAgentStore();
  const artifacts = useAgentStore((s) => s.artifacts);
  const { send } = useAgentStream();
  const { createTask, fetchArtifacts, getArtifactUrl } = useAPI();
  const [input, setInput] = useState("");

  const [activeTab, setActiveTab] = useState<TabMode>(() => {
    const s = useAgentStore.getState();
    return s.isRunning || s.messages.length > 0 ? "chat" : "setup";
  });

  // Fetch artifacts when a task completes
  useEffect(() => {
    if (taskId && !isRunning) {
      fetchArtifacts(taskId)
        .then((arts) => {
          if (arts) {
            const store = useAgentStore.getState();
            store.setArtifacts(arts.map((a) => ({
              artifactId: a.artifact_id,
              name: a.name,
              size: a.size,
            })));
          }
        })
        .catch(() => {});
    }
  }, [taskId, isRunning, fetchArtifacts]);

  const handleSetupSend = () => {
    const trimmed = input.trim();
    if (!trimmed || !isConnected || isRunning) return;
    const selected = useAgentStore.getState().selectedDatabases;
    send(trimmed, selected);
    setInput("");
    setActiveTab("chat");
  };

  const handleFixtureRun = async () => {
    const trimmed = input.trim();
    if (!trimmed || isRunning) return;
    const store = useAgentStore.getState();
    const selected = store.selectedDatabases;
    if (
      selected.length !== 2 ||
      !selected.includes("pubmed") ||
      !selected.includes("geo")
    ) {
      store.addTrace({
        kind: "error",
        message: "固定验收案例只能选择 PubMed 和 GEO。",
      });
      return;
    }
    store.addMessage("user", trimmed);
    store.setRunning(true);
    store.setPipelineStage("discovery");
    setActiveTab("chat");
    try {
      const created = await createTask(trimmed, selected);
      store.setTaskId(created.task_id);
      store.setPipelineStage("done");
      store.addMessage(
        "assistant",
        `确定性 Pipeline 已完成，任务 ${created.task_id} 的产物已通过验证。`,
      );
      const arts = await fetchArtifacts(created.task_id);
      store.setArtifacts(arts.map((a) => ({
        artifactId: a.artifact_id,
        name: a.name,
        size: a.size,
      })));
      setActiveTab("results");
    } catch (error) {
      store.setPipelineStage("error");
      store.addTrace({
        kind: "error",
        message: error instanceof Error ? error.message : "任务执行失败",
      });
    } finally {
      store.setRunning(false);
    }
  };

  const handleChatSend = () => {
    const trimmed = input.trim();
    if (!trimmed || isRunning) return;
    const selected = useAgentStore.getState().selectedDatabases;
    send(trimmed, selected);
    setInput("");
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
                disabled={!isConnected}
                className="min-h-20 resize-none"
              />
              <DatabaseSelector />
            </CardContent>
            <CardFooter className="flex flex-col gap-2">
              <Button
                onClick={handleSetupSend}
                disabled={!isConnected || isRunning || !input.trim()}
                className="w-full"
              >
                开始研究
              </Button>
              <Button
                variant="outline"
                onClick={handleFixtureRun}
                disabled={isRunning || !input.trim()}
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
              连接已断开，研究已中断
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
                        key={msg.id}
                        messageId={msg.id}
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
                                          artifact.artifactId,
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
                    placeholder={
                      isConnected ? "输入研究目标..." : "正在连接后端..."
                    }
                    disabled={!isConnected || isRunning}
                    className="min-h-11 resize-none"
                  />
                  <Button
                    onClick={handleChatSend}
                    disabled={!isConnected || isRunning || !input.trim()}
                  >
                    {isRunning ? "运行中..." : "发送"}
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
