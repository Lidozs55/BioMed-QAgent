import { useEffect } from "react";
import { useAgentStream } from "./hooks/useAgentStream";
import { useAPI } from "./hooks/useAPI";
import { useAgentStore } from "./stores/agentStore";
import { Sidebar } from "./components/Sidebar";
import { ChatPanel } from "./components/ChatPanel";
import { ToolTrace } from "./components/ToolTrace";
import { ThemeToggle } from "./components/ThemeToggle";

export default function App() {
  const { connect, disconnect } = useAgentStream();
  const { fetchDatabases } = useAPI();
  const setDatabases = useAgentStore((s) => s.setDatabases);

  useEffect(() => {
    connect();
    return () => disconnect();
  }, [connect, disconnect]);

  useEffect(() => {
    fetchDatabases()
      .then((dbs) => {
        if (dbs) setDatabases(dbs);
      })
      .catch(() => {});
  }, [fetchDatabases, setDatabases]);

  return (
    <div className="app">
      <Sidebar />
      <div className="app-main">
        <div className="app-header">
          <span>BioMed QAgent v1 — Agent Loop 架构（基于 openai-agents-python）</span>
          <ThemeToggle />
        </div>
        <div className="app-content">
          <ChatPanel />
          <ToolTrace />
        </div>
      </div>
    </div>
  );
}
