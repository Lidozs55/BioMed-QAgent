import { useState, useEffect } from "react";
import { useAgentStore } from "../stores/agentStore";
import { useAgentStream } from "../hooks/useAgentStream";
import { useAPI } from "../hooks/useAPI";
import { Bot, User, ChevronDown } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
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

/** 对话面板 — 基于 shadcn Message / MessageScroller / Marker 重构。 */
export function ChatPanel() {
  const { messages, isRunning, isConnected, databases, selectedDatabases, taskId } =
    useAgentStore();
  const { send } = useAgentStream();
  const { fetchArtifacts } = useAPI();
  const [input, setInput] = useState("");
  const [dbOpen, setDbOpen] = useState(false);

  // Fetch artifacts when a task completes
  useEffect(() => {
    if (taskId && !isRunning) {
      fetchArtifacts(taskId).then((arts) => {
        if (arts) {
          const store = useAgentStore.getState();
          arts.forEach((a) => { store.addArtifact(a.name, a.path ?? "", a.size); });
        }
      }).catch(() => {});
    }
  }, [taskId, isRunning, fetchArtifacts]);

  const handleSend = () => {
    const trimmed = input.trim();
    if (!trimmed || isRunning) return;
    const selected = useAgentStore.getState().selectedDatabases;
    send(trimmed, selected);
    setInput("");
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const toggleDb = (id: string) => {
    const store = useAgentStore.getState();
    const current = store.selectedDatabases;
    const next = current.includes(id)
      ? current.filter((x) => x !== id)
      : [...current, id];
    store.setSelectedDatabases(next);
  };

  const toggleAllDbs = () => {
    const store = useAgentStore.getState();
    if (store.selectedDatabases.length === store.databases.length) {
      store.setSelectedDatabases([]);
    } else {
      store.setSelectedDatabases(store.databases.map((db) => db.id));
    }
  };

  const allSelected = databases.length > 0 && selectedDatabases.length === databases.length;

  return (
    <MessageScrollerProvider autoScroll>
      <div className="flex h-full flex-col">
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
                            <User className="size-4" />
                          ) : (
                            <Bot className="size-4" />
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

              {isRunning && (
                <MessageScrollerItem messageId="thinking">
                  <Marker role="status">
                    <MarkerIcon>
                      <Spinner />
                    </MarkerIcon>
                    <MarkerContent>Thinking...</MarkerContent>
                  </Marker>
                </MessageScrollerItem>
              )}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton />
        </MessageScroller>

        {/* 数据源选择器 */}
        {databases.length > 0 && (
          <div className="shrink-0 border-t px-4 py-2">
            <button
              type="button"
              onClick={() => setDbOpen(!dbOpen)}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              <ChevronDown
                size={14}
                className={`transition-transform ${dbOpen ? "rotate-0" : "-rotate-90"}`}
              />
              数据源{" "}
              {selectedDatabases.length > 0 && `(${selectedDatabases.length})`}
            </button>
            {dbOpen && (
              <div className="flex flex-wrap gap-1.5 mt-2">
                <label
                  className={`flex items-center gap-1 text-xs cursor-pointer px-2 py-0.5 rounded border transition-colors ${
                    allSelected
                      ? "bg-primary/10 border-primary/30"
                      : "hover:bg-muted"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleAllDbs}
                    className="size-3 accent-primary"
                  />
                  全部
                </label>
                {databases.map((db) => (
                  <label
                    key={db.id}
                    className={`flex items-center gap-1 text-xs cursor-pointer px-2 py-0.5 rounded border transition-colors ${
                      selectedDatabases.includes(db.id)
                        ? "bg-primary/10 border-primary/30"
                        : "hover:bg-muted"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={selectedDatabases.includes(db.id)}
                      onChange={() => toggleDb(db.id)}
                      className="size-3 accent-primary"
                    />
                    {db.name}
                  </label>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="shrink-0 border-t p-4">
          <div className="flex gap-2">
            <Textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={isConnected ? "输入研究目标..." : "正在连接后端..."}
              disabled={!isConnected || isRunning}
              className="min-h-11 resize-none"
            />
            <Button
              onClick={handleSend}
              disabled={!isConnected || isRunning || !input.trim()}
            >
              {isRunning ? "运行中..." : "发送"}
            </Button>
          </div>
        </div>
      </div>
    </MessageScrollerProvider>
  );
}
