import { useEffect } from "react";
import { useAgentStream } from "./hooks/useAgentStream";
import { Sidebar } from "./components/Sidebar";
import { ChatPanel } from "./components/ChatPanel";
import { ToolTrace } from "./components/ToolTrace";

export default function App() {
  const { connect, disconnect } = useAgentStream();

  useEffect(() => {
    connect();
    return () => disconnect();
  }, [connect, disconnect]);

  return (
    <div className="app">
      <Sidebar />
      <div className="app-main">
        <div className="app-header">
          BioMed QAgent v1 — Agent Loop 架构（基于 openai-agents-python）
        </div>
        <div className="app-content">
          <ChatPanel />
          <ToolTrace />
        </div>
      </div>
    </div>
  );
}
