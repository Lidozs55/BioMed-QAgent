import { useEffect, useMemo } from "react";

import { ChatPanel } from "@/components/ChatPanel";
import { SessionSidebar } from "@/components/SessionSidebar";
import { ThemeToggle } from "@/components/ThemeToggle";
import { ToolTrace } from "@/components/ToolTrace";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { useAgentStream } from "@/hooks/useAgentStream";
import { useAPI } from "@/hooks/useAPI";
import { RuntimeController, startRuntime } from "@/runtime/controller";

export default function App() {
  const transport = useAgentStream();
  const api = useAPI();
  const controller = useMemo(
    () => new RuntimeController(api, transport),
    [api, transport],
  );

  useEffect(() => {
    const startup = new AbortController();
    void startRuntime({ api, transport, signal: startup.signal });
    return () => {
      startup.abort();
      transport.disconnect();
    };
  }, [api, transport]);

  return (
    <SidebarProvider defaultOpen={true}>
      <SessionSidebar
        onNewDraft={() => controller.showNewDraft()}
        onSelectTask={(taskId) => controller.selectTask(taskId)}
      />
      <SidebarInset>
        <header className="flex items-center justify-between border-b px-4 py-2">
          <SidebarTrigger aria-label="Toggle sidebar" />
          <h1 className="text-lg font-semibold">BioMed Q-Agent</h1>
          <ThemeToggle />
        </header>
        <main className="flex flex-1 overflow-hidden">
          <div className="flex-1">
            <ChatPanel startTask={(input) => controller.startTask(input)} />
          </div>
          <ToolTrace />
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}
