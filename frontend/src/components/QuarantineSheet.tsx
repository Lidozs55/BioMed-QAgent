import { useState } from "react";
import { ShieldWarningIcon } from "@phosphor-icons/react";

import QuarantinePanel from "@/components/QuarantinePanel";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { selectActiveTask } from "@/stores/agentSelectors";
import { useAgentStore } from "@/stores/agentStore";

export function QuarantineSheet() {
  const [open, setOpen] = useState(false);
  const task = useAgentStore(selectActiveTask);
  const taskId = task?.summary.task_id ?? null;

  if (taskId === null) return null;

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="查看未准入文件"
              onClick={() => setOpen(true)}
            />
          }
        >
          <ShieldWarningIcon aria-hidden="true" />
        </TooltipTrigger>
        <TooltipContent>未准入文件</TooltipContent>
      </Tooltip>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>未准入文件</SheetTitle>
          <SheetDescription>本地保存的非权威参考，不会进入正式发布。</SheetDescription>
        </SheetHeader>
        <div className="px-4 pb-4">
          <QuarantinePanel taskId={taskId} />
        </div>
      </SheetContent>
    </Sheet>
  );
}
