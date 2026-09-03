import { SidebarSimpleIcon, XIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import {
  OUTPUT_FORMAL_TAB,
  TaskOutputPanel,
  type TaskOutputTab,
} from "@/components/TaskOutputPanel";
import {
  TASK_OUTPUT_CLOSE_EVENT,
  TASK_OUTPUT_OPEN_EVENT,
  TASK_OUTPUT_TOGGLE_EVENT,
  toggleTaskOutputPanel,
} from "@/components/taskOutputPanelControl";
import { Button } from "@/components/ui/button";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useIsMobile } from "@/hooks/use-mobile";
import { isActiveStatus } from "@/runtime/reducer";
import { useAgentStore } from "@/stores/agentStore";

interface TaskOutputWorkspaceProps {
  children: ReactNode;
}

function OutputPanelHeader({ onClose }: { onClose: () => void }) {
  return (
    <div className="flex h-12 shrink-0 items-center justify-between border-b px-4">
      <h2 className="text-sm font-semibold">任务输出</h2>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        onClick={onClose}
        aria-label="关闭输出面板"
      >
        <XIcon aria-hidden="true" />
      </Button>
    </div>
  );
}

interface OutputPanelBodyProps {
  activeTab: TaskOutputTab;
  onActiveTabChange: (tab: TaskOutputTab) => void;
  onClose: () => void;
}

function OutputPanelBody({
  activeTab,
  onActiveTabChange,
  onClose,
}: OutputPanelBodyProps) {
  return (
    <div
      className="flex h-full min-h-0 min-w-0 flex-col bg-muted/20"
      role="region"
      aria-label="任务输出面板"
    >
      <OutputPanelHeader onClose={onClose} />
      <div className="min-h-0 min-w-0 flex-1">
        <TaskOutputPanel
          activeTab={activeTab}
          onActiveTabChange={onActiveTabChange}
        />
      </div>
    </div>
  );
}

export function OutputPanelToggle() {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={toggleTaskOutputPanel}
            aria-label="切换输出面板"
          />
        }
      >
        <SidebarSimpleIcon aria-hidden="true" />
      </TooltipTrigger>
      <TooltipContent>打开或关闭任务输出</TooltipContent>
    </Tooltip>
  );
}

export function TaskOutputWorkspace({ children }: TaskOutputWorkspaceProps) {
  const isMobile = useIsMobile();
  const [isOpen, setIsOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<TaskOutputTab>(OUTPUT_FORMAL_TAB);
  const handledCompletionsRef = useRef(new Set<string>());
  const open = useCallback((event?: Event) => {
    if (event instanceof CustomEvent) {
      const detail = event.detail as { tab?: TaskOutputTab } | undefined;
      if (detail?.tab !== undefined) setActiveTab(detail.tab);
    }
    setIsOpen(true);
  }, []);
  const close = useCallback(() => setIsOpen(false), []);
  const toggle = useCallback(() => setIsOpen((current) => !current), []);

  useEffect(() => useAgentStore.subscribe((state, previousState) => {
    const taskId = state.activeTaskId;
    if (
      taskId === null ||
      previousState.activeTaskId !== taskId ||
      state.hydratingTaskId === taskId ||
      previousState.hydratingTaskId === taskId
    ) {
      return;
    }
    const task = state.tasksById[taskId];
    const previousTask = previousState.tasksById[taskId];
    if (
      task === undefined ||
      previousTask === undefined ||
      !isActiveStatus(previousTask.summary.status) ||
      task.summary.status !== "completed"
    ) {
      return;
    }

    const runId = previousTask.summary.active_run_id
      ?? task.runOrder[task.runOrder.length - 1]
      ?? "unknown";
    const completionKey = `${taskId}:${runId}:completed`;
    if (handledCompletionsRef.current.has(completionKey)) return;
    handledCompletionsRef.current.add(completionKey);
    open();
  }), [open]);

  useEffect(() => {
    window.addEventListener(TASK_OUTPUT_OPEN_EVENT, open);
    window.addEventListener(TASK_OUTPUT_CLOSE_EVENT, close);
    window.addEventListener(TASK_OUTPUT_TOGGLE_EVENT, toggle);
    return () => {
      window.removeEventListener(TASK_OUTPUT_OPEN_EVENT, open);
      window.removeEventListener(TASK_OUTPUT_CLOSE_EVENT, close);
      window.removeEventListener(TASK_OUTPUT_TOGGLE_EVENT, toggle);
    };
  }, [close, open, toggle]);

  if (isMobile) {
    return (
      <div className="h-full min-h-0 min-w-0">
        {children}
        <Sheet open={isOpen} onOpenChange={setIsOpen}>
          <SheetContent side="right" className="w-full gap-0 sm:max-w-xl">
            <SheetHeader className="border-b">
              <SheetTitle>任务输出</SheetTitle>
            </SheetHeader>
            <div className="min-h-0 min-w-0 flex-1">
              <TaskOutputPanel
                activeTab={activeTab}
                onActiveTabChange={setActiveTab}
              />
            </div>
          </SheetContent>
        </Sheet>
      </div>
    );
  }

  if (!isOpen) {
    return <div className="h-full min-h-0 min-w-0">{children}</div>;
  }

  return (
    <ResizablePanelGroup orientation="horizontal">
      <ResizablePanel defaultSize="60%" minSize="32%">
        <div className="h-full min-h-0 min-w-0">{children}</div>
      </ResizablePanel>
      <ResizableHandle withHandle />
      <ResizablePanel defaultSize="40%" minSize="24rem" maxSize="68%">
        <OutputPanelBody
          activeTab={activeTab}
          onActiveTabChange={setActiveTab}
          onClose={close}
        />
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
