import { useAgentStore } from "@/stores/agentStore"
import { ThemeToggle } from "@/components/ThemeToggle"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarFooter,
  SidebarHeader,
} from "@/components/ui/sidebar"
import { FlaskConical, Database } from "lucide-react"

export function SessionSidebar() {
  const sessions = useAgentStore((s) => s.sessions)
  const currentSessionId = useAgentStore((s) => s.currentSessionId)
  const isConnected = useAgentStore((s) => s.isConnected)
  const databases = useAgentStore((s) => s.databases)
  const selectedDatabases = useAgentStore((s) => s.selectedDatabases)
  const pipelineStage = useAgentStore((s) => s.pipelineStage)
  const setCurrentSession = useAgentStore((s) => s.setCurrentSession)

  const currentSession = sessions.find((s) => s.taskId === currentSessionId)
  const selectedDbNames = databases
    .filter((db) => selectedDatabases.includes(db.id))
    .map((db) => db.name)

  return (
    <Sidebar>
      <SidebarHeader>
        <div className="flex items-center gap-2 px-2 pt-2">
          <FlaskConical className="size-5 text-sidebar-foreground" />
          <div className="flex flex-col">
            <span className="text-sm font-semibold text-sidebar-foreground">
              BioMed QAgent
            </span>
            <span className="text-xs text-sidebar-foreground/50">
              v1 — Agent Loop
            </span>
          </div>
        </div>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Session History</SidebarGroupLabel>
          <SidebarGroupContent>
            {sessions.length === 0 ? (
              <p className="px-2 text-xs text-sidebar-foreground/50">
                No research sessions yet
              </p>
            ) : (
              <SidebarMenu>
                {sessions.map((session) => (
                  <SidebarMenuItem key={session.taskId}>
                    <SidebarMenuButton
                      isActive={session.taskId === currentSessionId}
                      onClick={() => setCurrentSession(session.taskId)}
                    >
                      <Database className="size-4 shrink-0" />
                      <span className="truncate">{session.topic}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            )}
          </SidebarGroupContent>
        </SidebarGroup>

        {currentSession && (
          <SidebarGroup>
            <SidebarGroupLabel>Current Session</SidebarGroupLabel>
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
                      No databases selected
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1.5">
                  <span
                    className={cn(
                      "size-2 shrink-0 rounded-full",
                      pipelineStage === "done" && "bg-emerald-500",
                      pipelineStage === "error" && "bg-red-500",
                      pipelineStage === "idle" && "bg-sidebar-foreground/30",
                      pipelineStage !== "done" &&
                        pipelineStage !== "error" &&
                        pipelineStage !== "idle" &&
                        "bg-amber-500"
                    )}
                  />
                  <span className="text-xs capitalize text-sidebar-foreground/70">
                    {pipelineStage}
                  </span>
                </div>
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
                isConnected ? "bg-emerald-500" : "bg-red-500"
              )}
            />
            <span className="text-xs text-sidebar-foreground/70">
              {isConnected ? "Connected" : "Disconnected"}
            </span>
          </div>
        </div>
      </SidebarFooter>
    </Sidebar>
  )
}
