import { useState } from "react";
import { useAgentStore } from "../stores/agentStore";
import { useAgentStream } from "../hooks/useAgentStream";
import { Bot, User } from "lucide-react";
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
  const { messages, isRunning, isConnected } = useAgentStore();
  const { send } = useAgentStream();
  const [input, setInput] = useState("");

  const handleSend = () => {
    const trimmed = input.trim();
    if (!trimmed || isRunning) return;
    send(trimmed);
    setInput("");
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

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
