import { useState, useRef, useEffect } from "react";
import { useAgentStore } from "../stores/agentStore";
import { useAgentStream } from "../hooks/useAgentStream";

/** 对话面板 — 用户输入 + Agent 回复展示。 */
export function ChatPanel() {
  const { messages, isRunning, isConnected } = useAgentStore();
  const { send } = useAgentStream();
  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSend = () => {
    const trimmed = input.trim();
    if (!trimmed || isRunning) return;
    send(trimmed);
    setInput("");
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="chat-panel">
      <div className="chat-messages">
        {messages.length === 0 && (
          <div style={{ color: "var(--text-secondary)", textAlign: "center", marginTop: "40%" }}>
            输入研究目标开始对话，例如：
            <br />
            <code style={{ color: "var(--accent)" }}>
              分析健脾散结方对胰腺癌肝转移的影响
            </code>
          </div>
        )}
        {messages.map((msg) => (
          <div key={msg.id} className={`chat-message ${msg.role}`}>
            <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", margin: 0, fontFamily: "inherit" }}>
              {msg.content}
            </pre>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      <div className="chat-input-area">
        <textarea
          className="chat-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={isConnected ? "输入研究目标..." : "正在连接后端..."}
          disabled={!isConnected || isRunning}
          rows={1}
        />
        <button
          className="chat-send-btn"
          onClick={handleSend}
          disabled={!isConnected || isRunning || !input.trim()}
        >
          {isRunning ? "运行中..." : "发送"}
        </button>
      </div>
    </div>
  );
}
