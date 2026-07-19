import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { BackgroundTaskNotifications } from "@/components/BackgroundTaskNotifications";
import {
  ArtifactPanelToggle,
  ArtifactWorkspace,
} from "@/components/ArtifactWorkspace";
import { ChatPanel } from "@/components/ChatPanel";
import { SessionSidebar } from "@/components/SessionSidebar";

import { ToolTrace } from "@/components/ToolTrace";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/sonner";
import { useAgentStream } from "@/hooks/useAgentStream";
import { SettingsPanel } from "@/components/SettingsPanel"
import { ThemeToggle } from "@/components/ThemeToggle";
import { useAPI } from "@/hooks/useAPI"
import { useSettings } from "@/hooks/useSettings"
import { RuntimeController } from "@/runtime/controller";

function errorDescription(reason: unknown): string {
  return reason instanceof Error ? reason.message : "未知错误";
}

export default function App() {
  const transport = useAgentStream();
  const api = useAPI();
    const [showSettings, setShowSettings] = useState(false);
  const settingsState = useSettings();

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
    void controller.start(startup.signal).then(
      ([databases, history, socket]) => {
        if (startup.signal.aborted) return;
        if (databases.status === "rejected") {
          toast.error("数据源加载失败", {
            description: errorDescription(databases.reason),
          });
        }
        if (history.status === "rejected") {
          toast.error("会话历史加载失败", {
            description: errorDescription(history.reason),
          });
        }
        if (socket.status === "rejected") {
          toast.error("实时连接失败", {
            description: errorDescription(socket.reason),
          });
        }
      },
    );
    return () => {
      startup.abort();
      transport.disconnect();
    };
  }, [controller, transport]);

  return (
    <SidebarProvider
      defaultOpen={true}
      className="h-svh min-h-0 overflow-hidden"
    >
      <SessionSidebar
        onNewDraft={() => controller.showNewDraft()}
        onSelectTask={selectTask}
        onRetryHistory={() => controller.refreshTaskHistory()}
        onLoadAll={() => controller.loadAllTasks()}
        onCancelRun={(taskId, runId) => controller.cancelRun(taskId, runId)}
        onDeleteTask={(taskId) => controller.deleteTask(taskId)}
        onOpenSettings={() => setShowSettings(true)}
      />
      <SidebarInset className="min-h-0 min-w-0 overflow-hidden">
        <header className="flex min-w-0 shrink-0 items-center justify-between gap-2 border-b px-4 py-2">
          <SidebarTrigger aria-label="Toggle sidebar" />
          <h1 className="min-w-0 truncate text-lg font-semibold">BioMed Q-Agent</h1>
          <div className="flex shrink-0 items-center gap-2">
            <ArtifactPanelToggle />
            <ToolTrace />
            <ThemeToggle />
          </div>
        </header>
        <main className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
          <div className="min-h-0 min-w-0 flex-1">
            {showSettings ? (
              <SettingsPanel
                settings={settingsState.settings}
                models={settingsState.models}
                vendors={settingsState.vendors}
                loading={settingsState.loading}
                saving={settingsState.saving}
                modelsLoading={settingsState.modelsLoading}
                error={settingsState.error}
                onSave={async (payload) => {
                  await settingsState.updateSettings(payload);
                }}
                onClose={() => setShowSettings(false)}
                onFetchModels={settingsState.fetchModels}
              />
            ) : (
              <ArtifactWorkspace>
                <ChatPanel
                  startTask={(input) => controller.startTask(input)}
                  continueTask={(taskId, input) =>
                    controller.continueTask(taskId, input)
                  }
                  resumeRun={(taskId, runId, input) =>
                    controller.resumeRun(taskId, runId, input)
                  }
                  loadOlderMessages={(taskId) =>
                    controller.loadOlderMessages(taskId)
                  }
                />
              </ArtifactWorkspace>
            )}
          </div>
        </main>
      </SidebarInset>
      <BackgroundTaskNotifications onViewTask={selectTask} />
      <Toaster />
    </SidebarProvider>
  );
}
