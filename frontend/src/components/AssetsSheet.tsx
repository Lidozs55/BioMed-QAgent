import { useState } from "react";
import {
  FilesIcon,
  ShieldWarningIcon,
  TreeStructureIcon,
} from "@phosphor-icons/react";

import {
  ArtifactPanel,
  ArtifactSaveAllButton,
} from "@/components/ArtifactPanel";
import PublicationResultsViewer from "@/components/PublicationResultsViewer";
import QuarantinePanel from "@/components/QuarantinePanel";
import SourceAssetsPanel from "@/components/SourceAssetsPanel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useTaskPublicationId } from "@/hooks/useTaskPublication";
import type { ArtifactProjection } from "@/runtime/types";
import {
  selectActiveArtifacts,
  selectActiveTask,
} from "@/stores/agentSelectors";
import { useAgentStore } from "@/stores/agentStore";

export const ASSETS_FORMAL_TAB = "artifacts";
export const ASSETS_UNTRUSTED_TAB = "untrusted";
export const ASSETS_SOURCE_TAB = "sources";

interface AssetsSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 覆盖 store 中的当前任务产物（测试/复用用）。 */
  artifacts?: readonly ArtifactProjection[];
  taskId?: string | null;
  /** 存在 Publication 时，正式产物栏展示 manifest 驱动的发布视图。 */
  publicationId?: string | null;
  /** 初始标签页；需要直接检查未准入/来源登记时可传 untrusted / sources。 */
  defaultTab?:
    | typeof ASSETS_FORMAL_TAB
    | typeof ASSETS_UNTRUSTED_TAB
    | typeof ASSETS_SOURCE_TAB;
}

/**
 * 统一的“资源”入口：正式任务产物、未准入（ua_*）隔离文件和来源/证据登记分栏展示。
 * 未准入文件永远保持“非权威 / 未经准入”标注，不计入正式产物数量，
 * 也不作为 Publication 结果呈现；来源/证据登记保持只读。只要存在活动任务即可打开。
 */
export function AssetsSheet({
  open,
  onOpenChange,
  artifacts: artifactsOverride,
  taskId: taskIdOverride,
  publicationId: publicationIdOverride,
  defaultTab = ASSETS_FORMAL_TAB,
}: AssetsSheetProps) {
  const [tab, setTab] = useState(defaultTab);
  const activeArtifacts = useAgentStore(selectActiveArtifacts);
  const activeTask = useAgentStore(selectActiveTask);
  const artifacts = artifactsOverride ?? activeArtifacts;
  const taskId = taskIdOverride !== undefined ? taskIdOverride : activeTask?.summary.task_id ?? null;
  // Publication 只影响正式产物栏的展示方式；未准入文件始终可见。
  const executionState = useTaskPublicationId(
    publicationIdOverride == null ? taskId : null,
  );
  const resolvedPublicationId = publicationIdOverride ?? executionState.publicationId;

  if (taskId === null) return null;

  const formalCount = artifacts.length;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>资源</SheetTitle>
          <SheetDescription>
            正式产物已验证可用；未准入文件（ua_*）为非权威参考，不进入正式发布；来源/证据登记为只读清单。
          </SheetDescription>
        </SheetHeader>
        <Tabs
          value={tab}
          onValueChange={setTab}
          className="min-h-0 px-4 pb-4"
        >
          <TabsList className="grid h-auto w-full grid-cols-3">
            <TabsTrigger className="min-w-0" value={ASSETS_FORMAL_TAB}>
              <FilesIcon data-icon="inline-start" aria-hidden="true" />
              正式产物
              {formalCount > 0 && (
                <Badge className="hidden sm:inline-flex" variant="secondary">
                  {formalCount}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger className="min-w-0" value={ASSETS_UNTRUSTED_TAB}>
              <ShieldWarningIcon data-icon="inline-start" aria-hidden="true" />
              未准入
              <Badge className="hidden sm:inline-flex" variant="destructive">
                非权威
              </Badge>
            </TabsTrigger>
            <TabsTrigger className="min-w-0" value={ASSETS_SOURCE_TAB}>
              <TreeStructureIcon data-icon="inline-start" aria-hidden="true" />
              来源/证据
            </TabsTrigger>
          </TabsList>
          <TabsContent
            value={ASSETS_FORMAL_TAB}
            className="min-h-0 overflow-y-auto"
          >
            {resolvedPublicationId !== null ? (
              <div className="min-h-0 min-w-0 overflow-y-auto">
                <PublicationResultsViewer
                  publicationId={resolvedPublicationId}
                  taskId={taskId}
                />
              </div>
            ) : formalCount === 0 ? (
              <Empty className="min-h-24 border-0 p-2">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <FilesIcon aria-hidden="true" />
                  </EmptyMedia>
                  <EmptyTitle>暂无正式产物</EmptyTitle>
                  <EmptyDescription>
                    任务产生经验证的产物后会显示在这里；未准入文件请切换到“未准入”标签。
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <>
                <ArtifactPanel artifacts={artifacts} taskId={taskId} />
                <ArtifactSaveAllButton artifacts={artifacts} taskId={taskId} />
              </>
            )}
          </TabsContent>
          <TabsContent
            value={ASSETS_UNTRUSTED_TAB}
            className="min-h-0 overflow-y-auto"
          >
            <QuarantinePanel taskId={taskId} />
          </TabsContent>
          <TabsContent
            value={ASSETS_SOURCE_TAB}
            className="min-h-0 overflow-y-auto"
          >
            <SourceAssetsPanel taskId={taskId} />
          </TabsContent>
        </Tabs>
      </SheetContent>
    </Sheet>
  );
}

/** Composer 工具栏的统一“资源”按钮，聚合正式、未准入和来源/证据三类资产。 */
export function AssetsEntry() {
  const [open, setOpen] = useState(false);
  const activeTask = useAgentStore(selectActiveTask);
  if (activeTask === undefined) return null;

  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="资源"
              onClick={() => setOpen(true)}
            />
          }
        >
          <FilesIcon aria-hidden="true" />
        </TooltipTrigger>
        <TooltipContent>资源：正式、未准入与来源/证据资产</TooltipContent>
      </Tooltip>
      <AssetsSheet open={open} onOpenChange={setOpen} />
    </>
  );
}
