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
import { TaskOutputCharts } from "@/components/TaskOutputCharts";
import SourceAssetsPanel from "@/components/SourceAssetsPanel";
import { Badge } from "@/components/ui/badge";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { useTaskPublicationId } from "@/hooks/useTaskPublication";
import type { ArtifactProjection } from "@/runtime/types";
import {
  selectActiveArtifacts,
  selectActiveTask,
} from "@/stores/agentSelectors";
import { useAgentStore } from "@/stores/agentStore";

export const OUTPUT_FORMAL_TAB = "artifacts";
export const OUTPUT_SOURCE_TAB = "sources";
export const OUTPUT_UNTRUSTED_TAB = "untrusted";
export type TaskOutputTab =
  | typeof OUTPUT_FORMAL_TAB
  | typeof OUTPUT_SOURCE_TAB
  | typeof OUTPUT_UNTRUSTED_TAB;

interface TaskOutputPanelProps {
  artifacts?: readonly ArtifactProjection[];
  taskId?: string | null;
  publicationId?: string | null;
  defaultTab?: TaskOutputTab;
  activeTab?: TaskOutputTab;
  onActiveTabChange?: (tab: TaskOutputTab) => void;
}

/**
 * Task-scoped output surface. Formal Publication artifacts, read-only source
 * registrations, and untrusted quarantine files stay in separate trust tabs.
 */
export function TaskOutputPanel({
  artifacts: artifactsOverride,
  taskId: taskIdOverride,
  publicationId: publicationIdOverride,
  defaultTab = OUTPUT_FORMAL_TAB,
  activeTab,
  onActiveTabChange,
}: TaskOutputPanelProps) {
  const activeArtifacts = useAgentStore(selectActiveArtifacts);
  const activeTask = useAgentStore(selectActiveTask);
  const artifacts = artifactsOverride ?? activeArtifacts;
  const taskId = taskIdOverride !== undefined
    ? taskIdOverride
    : activeTask?.summary.task_id ?? null;
  const publicationState = useTaskPublicationId(
    publicationIdOverride == null ? taskId : null,
  );
  const publicationId = publicationIdOverride ?? publicationState.publicationId;

  if (taskId === null) {
    return (
      <Empty className="min-h-48">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <FilesIcon aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>选择任务查看输出</EmptyTitle>
          <EmptyDescription>
            选择任务后，这里会显示正式产物、来源证据和未准入文件。
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  const formalCount = artifacts.length;

  return (
    <Tabs
      value={activeTab}
      defaultValue={defaultTab}
      onValueChange={(value) => onActiveTabChange?.(value as TaskOutputTab)}
      className="h-full min-h-0 min-w-0 gap-0"
    >
      <div className="shrink-0 overflow-x-auto border-b px-3 py-2">
        <TabsList className="grid h-auto min-w-[26rem] w-full grid-cols-3">
          <TabsTrigger value={OUTPUT_FORMAL_TAB}>
            <FilesIcon data-icon="inline-start" aria-hidden="true" />
            正式产物
            {formalCount > 0 && (
              <Badge variant="secondary">{formalCount}</Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value={OUTPUT_SOURCE_TAB}>
            <TreeStructureIcon data-icon="inline-start" aria-hidden="true" />
            来源/证据
          </TabsTrigger>
          <TabsTrigger value={OUTPUT_UNTRUSTED_TAB}>
            <ShieldWarningIcon data-icon="inline-start" aria-hidden="true" />
            未准入
          </TabsTrigger>
        </TabsList>
      </div>
      <TabsContent
        value={OUTPUT_FORMAL_TAB}
        className="min-h-0 overflow-y-auto p-3"
      >
        {publicationId !== null ? (
          <div className="flex min-h-0 flex-col gap-3">
            <TaskOutputCharts />
            <PublicationResultsViewer
              publicationId={publicationId}
              taskId={taskId}
            />
          </div>
        ) : formalCount === 0 ? (
          <div className="flex min-h-0 flex-col gap-3">
            <TaskOutputCharts />
            <Empty className="min-h-48 border-0">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <FilesIcon aria-hidden="true" />
                </EmptyMedia>
                <EmptyTitle>暂无正式产物</EmptyTitle>
                <EmptyDescription>
                  任务完成后，经过验证的输出会显示在这里。
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          </div>
        ) : (
          <div className="flex min-h-0 flex-col gap-3">
            <TaskOutputCharts />
            <ArtifactPanel artifacts={artifacts} taskId={taskId} />
            <ArtifactSaveAllButton artifacts={artifacts} taskId={taskId} />
          </div>
        )}
      </TabsContent>
      <TabsContent
        value={OUTPUT_SOURCE_TAB}
        className="min-h-0 overflow-y-auto p-3"
      >
        <SourceAssetsPanel taskId={taskId} />
      </TabsContent>
      <TabsContent
        value={OUTPUT_UNTRUSTED_TAB}
        className="min-h-0 overflow-y-auto p-3"
      >
        <QuarantinePanel taskId={taskId} />
      </TabsContent>
    </Tabs>
  );
}
