import { TerminalIcon, XIcon } from "@phosphor-icons/react";
import { useState } from "react";

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
import { useAgentStore } from "@/stores/agentStore";
import { selectConnectionIsConnected } from "@/stores/agentSelectors";
import { selectCompatTraceItems } from "@/stores/legacyProjectionSelectors";

function statusFor(kind: string) {
  if (kind === "error") return "error";
  if (kind === "warning") return "warning";
  if (kind === "tool_output") return "success";
  return kind === "tool_call" ? "running" : "recorded";
}

export function ToolTrace() {
  const traces = useAgentStore(selectCompatTraceItems);
  const isConnected = useAgentStore(selectConnectionIsConnected);
  const [open, setOpen] = useState(false);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger
        render={
          <Button
            variant="outline"
            size="icon"
            className="fixed bottom-4 right-4 shadow-lg"
            aria-label="Toggle tool trace"
          />
        }
      >
        <TerminalIcon />
      </SheetTrigger>
      <SheetContent side="right">
        <SheetHeader>
          <SheetTitle>工具追踪</SheetTitle>
          <SheetDescription>{isConnected ? "已连接" : "未连接"}</SheetDescription>
        </SheetHeader>
        <ScrollArea className="-mx-6 flex-1 px-6">
          {traces.length === 0 ? (
            <div className="py-8 text-center text-xs text-muted-foreground">
              尚无工具调用
            </div>
          ) : (
            <div className="flex flex-col gap-3 py-2">
              {traces.map((trace) => {
                const status = statusFor(trace.kind);
                return (
                  <Card key={trace.id} size="sm">
                    <CardHeader>
                      <div className="flex w-full items-center justify-between">
                        <CardTitle className="text-xs">
                          {trace.kind}
                          {trace.name ? `: ${trace.name}` : ""}
                        </CardTitle>
                        <Badge
                          variant={
                            status === "error"
                              ? "destructive"
                              : status === "success"
                                ? "secondary"
                                : "outline"
                          }
                        >
                          {status}
                        </Badge>
                      </div>
                    </CardHeader>
                    {(trace.arguments || trace.output || trace.message) && (
                      <CardContent>
                        <pre className="whitespace-pre-wrap break-all font-mono text-[0.625rem] leading-relaxed text-muted-foreground">
                          {trace.arguments ?? trace.output ?? trace.message}
                        </pre>
                      </CardContent>
                    )}
                  </Card>
                );
              })}
            </div>
          )}
        </ScrollArea>
        <SheetFooter>
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
