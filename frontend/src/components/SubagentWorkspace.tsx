import { ListMagnifyingGlassIcon, SidebarSimpleIcon, XIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { SubagentCard, type CancelSubagent } from "@/components/SubagentCard";
import { Accordion } from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useIsMobile } from "@/hooks/use-mobile";
import { selectActiveTask } from "@/stores/agentSelectors";
import { useAgentStore } from "@/stores/agentStore";
import { subagentPanelEvents, toggleSubagentPanel } from "@/components/subagentPanelControl";
import type { ActivityProjection } from "@/runtime/types";

interface SubagentWorkspaceProps {
  children: ReactNode;
  cancelSubagent?: CancelSubagent;
}

function SubagentList({
  cancelSubagent,
  onClose,
  showHeader = true,
}: {
  cancelSubagent?: CancelSubagent;
  onClose: () => void;
  showHeader?: boolean;
}) {
  const task = useAgentStore(selectActiveTask);
  const subagents = task?.subagentOrder.map((id) => task.subagentsById[id]) ?? [];
  const activitiesBySubagent = new Map<string, ActivityProjection[]>();
  if (task !== undefined) {
    for (const activityId of task.activityOrder) {
      const activity = task.activitiesById[activityId];
      if (activity.subagentId === null) continue;
      const activities = activitiesBySubagent.get(activity.subagentId) ?? [];
      activities.push(activity);
      activitiesBySubagent.set(activity.subagentId, activities);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-muted/20">
      {showHeader ? (
        <div className="flex h-12 shrink-0 items-center justify-between border-b px-4">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold">子任务</h2>
            <Badge variant="secondary">{subagents.length}</Badge>
          </div>
          <Button type="button" variant="ghost" size="icon-sm" onClick={onClose} aria-label="关闭子任务面板">
            <XIcon />
          </Button>
        </div>
      ) : null}
      <ScrollArea className="min-h-0 flex-1">
        <div className="p-3">
          {subagents.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon"><ListMagnifyingGlassIcon /></EmptyMedia>
                <EmptyTitle>暂无子任务</EmptyTitle>
                <EmptyDescription>委派的研究任务会显示在这里。</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <Accordion>
              {subagents.map((subagent) => <SubagentCard key={subagent.subagentId} subagent={subagent} activities={activitiesBySubagent.get(subagent.subagentId) ?? []} cancelSubagent={cancelSubagent} />)}
            </Accordion>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

export function SubagentPanelToggle() {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="hidden md:inline-flex"
            onClick={toggleSubagentPanel}
            aria-label="切换子任务面板"
          />
        }
      >
        <SidebarSimpleIcon />
      </TooltipTrigger>
      <TooltipContent>打开或关闭子任务面板</TooltipContent>
    </Tooltip>
  );
}

export function SubagentWorkspace({ children, cancelSubagent }: SubagentWorkspaceProps) {
  const isMobile = useIsMobile();
  const task = useAgentStore(selectActiveTask);
  const taskId = task?.summary.task_id ?? null;
  const subagentCount = task?.subagentOrder.length ?? 0;
  const seenSubagentTasks = useRef(new Set<string>());
  const [isOpen, setIsOpen] = useState(false);
  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);
  const toggle = useCallback(() => setIsOpen((current) => !current), []);

  useEffect(() => {
    if (
      !isMobile &&
      taskId !== null &&
      subagentCount > 0 &&
      !seenSubagentTasks.current.has(taskId)
    ) {
      seenSubagentTasks.current.add(taskId);
      open();
    }
  }, [isMobile, open, subagentCount, taskId]);

  useEffect(() => {
    window.addEventListener(subagentPanelEvents.open, open);
    window.addEventListener(subagentPanelEvents.close, close);
    window.addEventListener(subagentPanelEvents.toggle, toggle);
    return () => {
      window.removeEventListener(subagentPanelEvents.open, open);
      window.removeEventListener(subagentPanelEvents.close, close);
      window.removeEventListener(subagentPanelEvents.toggle, toggle);
    };
  }, [close, open, toggle]);

  if (isMobile) {
    return (
      <div className="h-full min-h-0 min-w-0">
        {children}
        <Sheet open={isOpen} onOpenChange={setIsOpen}>
          <SheetContent side="right" className="gap-0">
            <SheetHeader className="border-b">
              <SheetTitle>子任务运行状态</SheetTitle>
            </SheetHeader>
            <div className="min-h-0 flex-1">
              <SubagentList
                cancelSubagent={cancelSubagent}
                onClose={close}
                showHeader={false}
              />
            </div>
          </SheetContent>
        </Sheet>
      </div>
    );
  }

  if (!isOpen) return <div className="h-full min-h-0 min-w-0">{children}</div>;

  return (
    <ResizablePanelGroup orientation="horizontal">
      <ResizablePanel defaultSize="68%" minSize="42%"><div className="h-full min-h-0 min-w-0">{children}</div></ResizablePanel>
      <ResizableHandle withHandle />
      <ResizablePanel defaultSize="32%" minSize="18rem" maxSize="50%"><SubagentList cancelSubagent={cancelSubagent} onClose={close} /></ResizablePanel>
    </ResizablePanelGroup>
  );
}
