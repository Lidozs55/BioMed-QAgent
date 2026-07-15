import { useCallback, useEffect, useMemo } from "react";

import { BackgroundTaskNotifications } from "@/components/BackgroundTaskNotifications";
import { ChatPanel } from "@/components/ChatPanel";
import { SessionSidebar } from "@/components/SessionSidebar";
import { ThemeToggle } from "@/components/ThemeToggle";
import { ToolTrace } from "@/components/ToolTrace";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/sonner";
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
  const selectTask = useCallback(
    (taskId: string) => controller.selectTask(taskId),
    [controller],
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
        onSelectTask={selectTask}
        onLoadMore={() => controller.loadMoreTasks()}
        onCancelRun={(taskId, runId) => controller.cancelRun(taskId, runId)}
        onDeleteTask={(taskId) => controller.deleteTask(taskId)}
      />
      <SidebarInset className="min-w-0">
        <header className="flex min-w-0 items-center justify-between gap-2 border-b px-4 py-2">
          <SidebarTrigger aria-label="Toggle sidebar" />
          <h1 className="min-w-0 truncate text-lg font-semibold">BioMed Q-Agent</h1>
          <ThemeToggle />
        </header>
        <main className="flex min-w-0 flex-1 overflow-hidden">
          <div className="min-w-0 flex-1">
            <ChatPanel
              startTask={(input) => controller.startTask(input)}
              continueTask={(taskId, input) =>
                controller.continueTask(taskId, input)
              }
            />
          </div>
          <ToolTrace />
        </main>
      </SidebarInset>
      <BackgroundTaskNotifications onViewTask={selectTask} />
      <Toaster />
    </SidebarProvider>
  );
}
