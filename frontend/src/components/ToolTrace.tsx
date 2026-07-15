import { TerminalIcon, XIcon, BroomIcon } from "@phosphor-icons/react";
import { useMemo, useState } from "react";

import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import type { ActivityProjection } from "@/runtime/types";
import { selectActiveActivities, selectActiveTask } from "@/stores/agentSelectors";
import { useAgentStore } from "@/stores/agentStore";

function activityStatus(activity: ActivityProjection): {
  label: string;
  variant: "default" | "secondary" | "destructive" | "outline";
} {
  if (activity.isError) return { label: "错误", variant: "destructive" };
  if (activity.kind === "warning") return { label: "警告", variant: "outline" };
  if (activity.kind === "tool" && activity.status === "started") {
    return { label: "运行中", variant: "default" };
  }
  if (activity.kind === "tool") return { label: "已完成", variant: "secondary" };
  return { label: "已记录", variant: "outline" };
}

export function ToolTrace() {
  const activities = useAgentStore(selectActiveActivities);
  const task = useAgentStore(selectActiveTask);
  const connectionStatus = useAgentStore((state) => state.connectionStatus);
  const [open, setOpen] = useState(false);
  const [hiddenThroughSequence, setHiddenThroughSequence] = useState<
    Record<string, number>
  >({});

  const taskId = task?.summary.task_id ?? null;
  const visibleActivities = useMemo(() => {
    const hiddenThrough = taskId === null ? 0 : hiddenThroughSequence[taskId] ?? 0;
    return activities.filter((activity) => activity.sequence > hiddenThrough);
  }, [activities, hiddenThroughSequence, taskId]);

  const hideVisible = () => {
    if (taskId === null || activities.length === 0) return;
    const latestSequence = activities[activities.length - 1]?.sequence ?? 0;
    setHiddenThroughSequence((current) => ({
      ...current,
      [taskId]: latestSequence,
    }));
  };

  const connectionLabel =
    connectionStatus === "connected"
      ? "已连接"
      : connectionStatus === "connecting" || connectionStatus === "reconnecting"
        ? "连接中"
        : "未连接";

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger
        render={
          <Button
            variant="outline"
            size="icon"
            className="fixed right-4 bottom-4 shadow-lg"
            aria-label="Toggle tool trace"
            title="Toggle tool trace"
          />
        }
      >
        <TerminalIcon data-icon="inline-start" />
      </SheetTrigger>
      <SheetContent side="right" className="min-w-0">
        <SheetHeader>
          <SheetTitle>工具追踪</SheetTitle>
          <SheetDescription>
            {task === undefined ? "未选择任务" : `${task.summary.title} · ${connectionLabel}`}
          </SheetDescription>
        </SheetHeader>
        <ScrollArea className="-mx-6 min-w-0 flex-1 px-6">
          {visibleActivities.length === 0 ? (
            <Empty className="border-0 py-8">
              <EmptyHeader>
                <EmptyTitle>{task === undefined ? "选择任务查看工具调用" : "尚无工具调用"}</EmptyTitle>
                <EmptyDescription>
                  {task === undefined
                    ? "后台任务的活动会在这里显示。"
                    : "该任务还没有可显示的工具活动。"}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="flex min-w-0 flex-col gap-3 py-2">
              {visibleActivities.map((activity) => {
                const status = activityStatus(activity);
                const detail = activity.input ?? activity.output ?? activity.message;
                return (
                  <Card key={activity.activityId} size="sm" className="min-w-0">
                    <CardHeader>
                      <div className="flex min-w-0 items-center justify-between gap-2">
                        <CardTitle
                          className="min-w-0 truncate text-xs"
                          title={activity.name ?? activity.kind}
                        >
                          {activity.name ?? activity.kind}
                        </CardTitle>
                        <Badge variant={status.variant} className="shrink-0">
                          {status.label}
                        </Badge>
                      </div>
                    </CardHeader>
                    {detail && (
                      <CardContent>
                        <pre className="max-w-full whitespace-pre-wrap break-words font-mono text-[0.625rem] leading-relaxed text-muted-foreground">
                          {detail}
                        </pre>
                      </CardContent>
                    )}
                  </Card>
                );
              })}
            </div>
          )}
        </ScrollArea>
        <SheetFooter className="gap-2">
          {visibleActivities.length > 0 && (
            <Button variant="outline" size="sm" onClick={hideVisible}>
              <BroomIcon data-icon="inline-start" />
              清除当前显示
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            onClick={() => setOpen(false)}
          >
            <XIcon data-icon="inline-start" />
            关闭
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
