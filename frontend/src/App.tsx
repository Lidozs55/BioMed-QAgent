import { GearIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import {
  SubagentPanelToggle,
  SubagentWorkspace,
} from "@/components/SubagentWorkspace";
import { BackgroundTaskNotifications } from "@/components/BackgroundTaskNotifications";
import { ChatPanel } from "@/components/ChatPanel";
import { SessionSidebar } from "@/components/SessionSidebar";
import { SettingsPanel } from "@/components/SettingsPanel";
import { ThemeToggle } from "@/components/ThemeToggle";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/sonner";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAgentStream } from "@/hooks/useAgentStream";
import {
  useAPI,
  type ManagedModelInfo,
  type ModelInfo,
  type ModelSettings,
} from "@/hooks/useAPI";
import { managedModelsToChoices } from "@/lib/modelChoices";
import { errorMessage } from "@/lib/utils";
import { RuntimeController } from "@/runtime/controller";

export default function App() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<ModelSettings | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [managedModels, setManagedModels] = useState<ManagedModelInfo[]>([]);
  const [selectedModelId, setSelectedModelId] = useState("");
  const prevSettingsOpenRef = useRef(settingsOpen);
  const api = useAPI();
  // The transport fires onPermanentGap when replay recovery cannot heal a
  // sequence gap; the controller (created below) rebuilds the task from an
  // authoritative REST snapshot via this indirection.
  const controllerRef = useRef<RuntimeController | null>(null);
  const transport = useAgentStream(
    useCallback((taskId: string) => {
      void controllerRef.current
        ?.hydrateTaskFromGap(taskId)
        .catch(() => undefined);
    }, []),
  );

  const controller = useMemo(
    () => new RuntimeController(api, transport),
    [api, transport],
  );
  useEffect(() => {
    controllerRef.current = controller;
  }, [controller]);
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
            description: errorMessage(databases.reason),
          });
        }
        if (history.status === "rejected") {
          toast.error("会话历史加载失败", {
            description: errorMessage(history.reason),
          });
        }
        if (socket.status === "rejected") {
          toast.error("实时连接失败", {
            description: errorMessage(socket.reason),
          });
        }
      },
    );
    return () => {
      startup.abort();
      transport.disconnect();
    };
  }, [controller, transport]);

  const loadModels = useCallback(async () => {
    try {
      const currentSettings = await api.fetchSettings();
      setSettings(currentSettings);
      setSelectedModelId(currentSettings.model_name);
      const managed = await api.fetchManagedModels().catch(() => []);
      setManagedModels(managed);
      setModels(managedModelsToChoices(managed));
    } catch {
      setModels([]);
    }
  }, [api]);

  // Load models on mount (deferred to avoid sync setState warning)
  useEffect(() => {
    const timer = window.setTimeout(() => void loadModels(), 0);
    return () => window.clearTimeout(timer);
  }, [loadModels]);

  // Reload models when settings dialog closes
  useEffect(() => {
    const prev = prevSettingsOpenRef.current;
    prevSettingsOpenRef.current = settingsOpen;
    if (prev === true && settingsOpen === false) {
      const timer = window.setTimeout(() => void loadModels(), 0);
      return () => window.clearTimeout(timer);
    }
  }, [settingsOpen, loadModels]);

  const handleModelChange = useCallback(
    async (modelId: string) => {
      const model = managedModels.find((entry) => entry.model_id === modelId);
      if (!model) return;
      try {
        const updated = await api.activateManagedModel(model.id);
        setSettings(updated);
        setSelectedModelId(updated.model_name);
        toast.success(`已切换当前模型为 ${model.name}`);
      } catch {
        toast.error("模型切换失败");
      }
    },
    [api, managedModels],
  );

  const exportCache = useCallback(() => {
    const url = api.getCacheExportUrl();
    const link = document.createElement("a");
    link.href = url;
    link.download = "cache_export.zip";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    toast.success("正在导出本地缓存", {
      description: "下载将在浏览器中开始（ZIP 文件）",
    });
  }, [api]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key === ",") {
        event.preventDefault();
        setSettingsOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <SidebarProvider
      defaultOpen={true}
      className="h-svh min-h-0 overflow-hidden"
    >
      <SessionSidebar
        onNewDraft={() => controller.showNewDraft()}
        onSelectTask={selectTask}
        onRetryHistory={() => controller.refreshTaskHistory()}
        onLoadMore={() => controller.loadMoreTasks()}
        onCancelRun={(taskId, runId) => controller.cancelRun(taskId, runId)}
        onDeleteTask={(taskId) => controller.deleteTask(taskId)}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <SidebarInset className="min-h-0 min-w-0 overflow-hidden">
        <header className="flex min-w-0 shrink-0 items-center justify-between gap-2 border-b px-4 py-2">
          <SidebarTrigger aria-label="Toggle sidebar" />
          <h1 className="min-w-0 truncate text-lg font-semibold">BioMed QAgent</h1>
          <div className="flex shrink-0 items-center gap-2">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="打开设置"
                    onClick={() => setSettingsOpen(true)}
                  />
                }
              >
                <GearIcon />
              </TooltipTrigger>
              <TooltipContent>打开设置</TooltipContent>
            </Tooltip>
            <SubagentPanelToggle />
            <ThemeToggle />
          </div>
        </header>
        <main className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
          <div className="min-h-0 min-w-0 flex-1">
            <SubagentWorkspace
              cancelSubagent={async (taskId, runId, subagentId) => {
                try {
                  await controller.cancelSubagent(taskId, runId, subagentId);
                } catch (error) {
                  toast.error("取消子任务失败", {
                    description: errorMessage(error),
                  });
                }
              }}
            >
              <ChatPanel
                startTask={(input) => controller.startTask(input)}
                uploadFiles={(files, note) =>
                  controller.startImportTask(files, note)
                }
                continueTask={(taskId, input) =>
                  controller.continueTask(taskId, input)
                }
                cancelRun={(taskId, runId) => controller.cancelRun(taskId, runId)}
                resumeRun={(taskId, runId, input) =>
                  controller.resumeRun(taskId, runId, input)
                }
                resolvePermission={(taskId, runId, requestId, decision, grantScope, scopeWide) =>
                  controller.resolvePermission(taskId, runId, requestId, decision, grantScope, scopeWide)
                }
                resumeDownload={(taskId, input) =>
                  controller.resumeDownload(taskId, input)
                }
                cancelDownload={(taskId) => controller.cancelDownload(taskId)}
                loadOlderMessages={(taskId) =>
                  controller.loadOlderMessages(taskId)
                }
                compactTask={(taskId) => api.compactTask(taskId)}
                injectTaskContext={(taskId, text) =>
                  api.injectTaskContext(taskId, text)
                }
                models={models}
                hasApiKey={settings?.api_key_configured ?? models.length > 0}
                selectedModelId={selectedModelId}
                onModelChange={handleModelChange}
                onOpenSettings={() => setSettingsOpen(true)}
                contextWindow={settings?.context_window}
                runBlockReason={settings?.run_block_reason}
              />
            </SubagentWorkspace>
          </div>
        </main>
      </SidebarInset>
      <BackgroundTaskNotifications onViewTask={selectTask} />
      <SettingsPanel
        open={settingsOpen}
        onOpenChange={(next) => {
          setSettingsOpen(next);
          if (!next) void controller.refreshDatabases();
        }}
        api={api}
        onExportCache={exportCache}
      />
      <Toaster />
    </SidebarProvider>
  );
}
