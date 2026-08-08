import { useState } from "react";
import { FilesIcon } from "@phosphor-icons/react";

import { ArtifactSheet } from "@/components/ArtifactSheet";
import { Button } from "@/components/ui/button";
import { useTaskBuildId } from "@/hooks/useTaskBuild";
import type { ArtifactProjection } from "@/runtime/types";
import {
  selectActiveArtifacts,
  selectActiveTask,
} from "@/stores/agentSelectors";
import { useAgentStore } from "@/stores/agentStore";

interface ArtifactFabProps {
  artifacts?: readonly ArtifactProjection[];
  taskId?: string | null;
  /** V2 build id — opens the manifest-driven build view. */
  buildId?: string | null;
}

export function ArtifactFab({
  artifacts: artifactOverride,
  taskId: taskIdOverride,
  buildId: buildIdOverride,
}: ArtifactFabProps = {}) {
  const [open, setOpen] = useState(false);
  const activeArtifacts = useAgentStore(selectActiveArtifacts);
  const activeTask = useAgentStore(selectActiveTask);
  const artifacts = artifactOverride ?? activeArtifacts;
  const taskId = taskIdOverride ?? activeTask?.summary.task_id ?? null;
  // Resolve the task's V2 build (if any) so the FAB also appears for
  // completed builds whose files live in the builds API, not the legacy
  // artifact store (Phase 7 T1).
  const buildState = useTaskBuildId(
    buildIdOverride == null ? taskId : null,
  );
  const resolvedBuildId = buildIdOverride ?? buildState.buildId;

  if (
    (artifacts.length === 0 && resolvedBuildId === null) ||
    taskId === null
  ) {
    return null;
  }

  const label =
    artifacts.length > 0
      ? `查看 ${artifacts.length} 个产物`
      : "查看构建结果";

  return (
    <>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={() => setOpen(true)}
        aria-label={label}
      >
        <FilesIcon data-icon="inline-start" aria-hidden="true" />
        {artifacts.length > 0 ? artifacts.length : "结果"}
      </Button>
      <ArtifactSheet
        open={open}
        onOpenChange={setOpen}
        artifacts={artifacts}
        taskId={taskId}
        buildId={resolvedBuildId}
      />
    </>
  );
}
