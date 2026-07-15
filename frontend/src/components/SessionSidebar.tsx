import { DatabaseIcon, FlaskIcon, PlusCircleIcon } from "@phosphor-icons/react";

import { ThemeToggle } from "@/components/ThemeToggle";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";
import { useAgentStore } from "@/stores/agentStore";
import { selectActiveTask } from "@/stores/agentSelectors";
import { selectCompatTaskRows } from "@/stores/legacyProjectionSelectors";

interface SessionSidebarProps {
  onNewDraft: () => void;
  onSelectTask: (taskId: string) => void | Promise<void>;
}

export function SessionSidebar({
  onNewDraft,
  onSelectTask,
}: SessionSidebarProps) {
  const rows = useAgentStore(selectCompatTaskRows);
  const activeTaskId = useAgentStore((state) => state.activeTaskId);
  const activeTask = useAgentStore(selectActiveTask);
  const databases = useAgentStore((state) => state.databases);
  const connectionStatus = useAgentStore((state) => state.connectionStatus);
  const selectedDbNames = databases
    .filter((database) => activeTask?.summary.databases.includes(database.id))
    .map((database) => database.name);

  return (
    <Sidebar>
      <SidebarHeader>
        <div className="flex items-center gap-2 px-2 pt-2">
          <FlaskIcon className="size-5 text-sidebar-foreground" />
          <div className="flex flex-col">
            <span className="text-sm font-semibold text-sidebar-foreground">
              BioMed QAgent
            </span>
            <span className="text-xs text-sidebar-foreground/50">
              v2 — Durable Tasks
            </span>
          </div>
        </div>
      </SidebarHeader>

      <SidebarContent>
        <div className="px-2 pb-2">
          <Button
            variant="outline"
            size="sm"
            className="w-full justify-start gap-2"
            onClick={onNewDraft}
          >
            <PlusCircleIcon data-icon="inline-start" />
            新建研究
          </Button>
        </div>

        <SidebarGroup>
          <SidebarGroupLabel>会话历史</SidebarGroupLabel>
          <SidebarGroupContent>
            {rows.length === 0 ? (
              <p className="px-2 text-xs text-sidebar-foreground/50">
                暂无研究记录
              </p>
            ) : (
              <SidebarMenu>
                {rows.map((row) => (
                  <SidebarMenuItem key={row.taskId}>
                    <SidebarMenuButton
                      isActive={row.taskId === activeTaskId}
                      onClick={() => void onSelectTask(row.taskId)}
                      tooltip={row.topic}
                    >
                      <DatabaseIcon />
                      <span className="truncate">{row.topic}</span>
                      <Badge variant="secondary">{row.status}</Badge>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            )}
          </SidebarGroupContent>
        </SidebarGroup>

        {activeTask && (
          <SidebarGroup>
            <SidebarGroupLabel>当前会话</SidebarGroupLabel>
            <SidebarGroupContent>
              <div className="flex flex-col gap-2 px-2">
                <div className="flex flex-wrap gap-1">
                  {selectedDbNames.length > 0 ? (
                    selectedDbNames.map((name) => (
                      <Badge key={name} variant="secondary">
                        {name}
                      </Badge>
                    ))
                  ) : (
                    <span className="text-xs text-sidebar-foreground/50">
                      未选择数据源
                    </span>
                  )}
                </div>
                <span className="text-xs text-sidebar-foreground/70">
                  {activeTask.summary.status}
                </span>
              </div>
            </SidebarGroupContent>
          </SidebarGroup>
        )}
      </SidebarContent>

      <SidebarFooter>
        <div className="flex items-center justify-between px-2">
          <ThemeToggle />
          <div className="flex items-center gap-1.5">
            <span
              className={cn(
                "size-2 shrink-0 rounded-full",
                connectionStatus === "connected"
                  ? "bg-primary"
                  : "bg-destructive",
              )}
            />
            <span className="text-xs text-sidebar-foreground/70">
              {connectionStatus === "connected" ? "已连接" : "未连接"}
            </span>
          </div>
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
