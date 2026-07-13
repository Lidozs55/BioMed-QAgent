import { useEffect } from "react";
import { useAgentStream } from "./hooks/useAgentStream";
import { useAPI } from "./hooks/useAPI";
import { useAgentStore } from "./stores/agentStore";
import { SidebarProvider, SidebarInset, SidebarTrigger } from "@/components/ui/sidebar";
import { SessionSidebar } from "@/components/SessionSidebar";
import { ChatPanel } from "@/components/ChatPanel";
import { ToolTrace } from "@/components/ToolTrace";
import { ThemeToggle } from "@/components/ThemeToggle";

export default function App() {
  const { connect, disconnect, send } = useAgentStream();
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
    <SidebarProvider defaultOpen={true}>
      <SessionSidebar />
      <SidebarInset>
        <header className="flex items-center justify-between border-b px-4 py-2">
          <SidebarTrigger aria-label="Toggle sidebar" />
          <h1 className="text-lg font-semibold">BioMed Q-Agent</h1>
          <ThemeToggle />
        </header>
        <main className="flex flex-1 overflow-hidden">
          <div className="flex-1">
            <ChatPanel send={send} />
          </div>
          <ToolTrace />
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}
