import { useState } from "react"
import { useAgentStore } from "@/stores/agentStore"
import { useAPI } from "@/hooks/useAPI"
import { ThemeToggle } from "@/components/ThemeToggle"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
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
import { FlaskConical, Database, PlusCircle, Trash2, DownloadIcon } from "lucide-react"

export function SessionSidebar() {
  const sessions = useAgentStore((s) => s.sessions)
  const currentSessionId = useAgentStore((s) => s.currentSessionId)
  const isConnected = useAgentStore((s) => s.isConnected)
  const isRunning = useAgentStore((s) => s.isRunning)
  const databases = useAgentStore((s) => s.databases)
  const selectedDatabases = useAgentStore((s) => s.selectedDatabases)
  const pipelineStage = useAgentStore((s) => s.pipelineStage)
  const artifacts = useAgentStore((s) => s.artifacts)
  const taskId = useAgentStore((s) => s.taskId)
  const reset = useAgentStore((s) => s.reset)
  const deleteSession = useAgentStore((s) => s.deleteSession)
  const loadSession = useAgentStore((s) => s.loadSession)

  const { getArtifactUrl } = useAPI()

  const [deleteTarget, setDeleteTarget] = useState<{
    taskId: string
    topic: string
  } | null>(null)

  const currentSession = sessions.find((s) => s.taskId === currentSessionId)
  const selectedDbNames = databases
    .filter((db) => selectedDatabases.includes(db.id))
    .map((db) => db.name)

  /** Format bytes to human-readable size */
  function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / 1048576).toFixed(1)} MB`
  }

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
        {/* 新建研究 button */}
        <div className="px-2 pb-2">
          <Button
            variant="outline"
            size="sm"
            className="w-full justify-start gap-2"
            onClick={() => {
              reset()
            }}
          >
            <PlusCircle className="size-4" />
            新建研究
          </Button>
        </div>

        <SidebarGroup>
          <SidebarGroupLabel>会话历史</SidebarGroupLabel>
          <SidebarGroupContent>
            {sessions.length === 0 ? (
              <p className="px-2 text-xs text-sidebar-foreground/50">
                暂无研究记录
              </p>
            ) : (
              <SidebarMenu>
                {sessions.map((session) => (
                  <SidebarMenuItem key={session.taskId}>
                    <SidebarMenuButton
                      isActive={session.taskId === currentSessionId}
                      onClick={() => loadSession(session.taskId)}
                      tooltip={session.topic}
                    >
                      <Database className="size-4 shrink-0" />
                      <span className="truncate">{session.topic}</span>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="ml-auto size-6 shrink-0"
                        onClick={(e) => {
                          e.stopPropagation()
                          setDeleteTarget({
                            taskId: session.taskId,
                            topic: session.topic,
                          })
                        }}
                      >
                        <Trash2 className="size-3.5 text-sidebar-foreground/50" />
                      </Button>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            )}
          </SidebarGroupContent>
        </SidebarGroup>

        {currentSession && (
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

        {/* Artifacts section */}
        {artifacts.length > 0 && (
          <SidebarGroup>
            <SidebarGroupLabel>产出文件</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {artifacts.map((artifact) => (
                  <SidebarMenuItem key={artifact.name}>
                    <SidebarMenuButton
                      render={
                        // biome-ignore lint/a11y/useAnchorContent: children rendered by SidebarMenuButton's useRender merge
                        <a
                          href={getArtifactUrl(taskId ?? "", artifact.artifactId)}
                          download={artifact.name}
                          aria-label={`下载 ${artifact.name}`}
                        />
                      }
                      tooltip={artifact.name}
                    >
                      <span className="truncate text-xs">{artifact.name}</span>
                      <span className="ml-auto shrink-0 text-xs text-sidebar-foreground/50">
                        {formatSize(artifact.size)}
                      </span>
                      <DownloadIcon className="size-3 shrink-0 text-sidebar-foreground/50" />
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}
      </SidebarContent>

      <SidebarFooter>
        <div className="flex flex-col gap-2 px-2">
          <div className="flex items-center justify-between">
            <ThemeToggle />
            <div className="flex items-center gap-1.5">
              <span
                className={cn(
                  "size-2 shrink-0 rounded-full",
                  isConnected ? "bg-emerald-500" : "bg-red-500"
                )}
              />
              <span className="text-xs text-sidebar-foreground/70">
                {isConnected ? "已连接" : "未连接"}
              </span>
            </div>
          </div>
          {/* Agent running status */}
          <div className="flex items-center justify-between">
            <span className="text-xs text-sidebar-foreground/50">Agent 状态</span>
            <Badge
              variant={
                isRunning
                  ? "default"
                  : pipelineStage === "error"
                    ? "destructive"
                    : "secondary"
              }
              className={cn(
                "text-xs",
                isRunning && "bg-amber-500 hover:bg-amber-600 text-white",
                pipelineStage === "error" && "bg-red-500 hover:bg-red-600 text-white",
                !isRunning && pipelineStage !== "error" && "bg-emerald-500 hover:bg-emerald-600 text-white"
              )}
            >
              {isRunning
                ? "运行中"
                : pipelineStage === "error"
                  ? "异常"
                  : "空闲"}
            </Badge>
          </div>
        </div>
      </SidebarFooter>

      {/* Delete confirmation Dialog */}
      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>确认删除会话</DialogTitle>
            <DialogDescription>
              确认删除会话「{deleteTarget?.topic}」？
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (deleteTarget) {
                  deleteSession(deleteTarget.taskId)
                  setDeleteTarget(null)
                }
              }}
            >
              确认删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Sidebar>
  )
}
