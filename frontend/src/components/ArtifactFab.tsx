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
  // V2 report cards own completed and loading build results; keep this FAB for legacy files only.
  const buildState = useTaskBuildId(
    buildIdOverride == null ? taskId : null,
  );
  const resolvedBuildId = buildIdOverride ?? buildState.buildId;

  if (
    taskId === null ||
    buildState.status === "loading" ||
    resolvedBuildId !== null ||
    artifacts.length === 0
  ) {
    return null;
  }

  const label = `查看 ${artifacts.length} 个产物`;
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
        {artifacts.length}
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
