import { useState } from "react";
import { FilesIcon } from "@phosphor-icons/react";

import { ArtifactSheet } from "@/components/ArtifactSheet";
import { Button } from "@/components/ui/button";
import { useTaskPublicationId } from "@/hooks/useTaskPublication";
import type { ArtifactProjection } from "@/runtime/types";
import {
  selectActiveArtifacts,
  selectActiveTask,
} from "@/stores/agentSelectors";
import { useAgentStore } from "@/stores/agentStore";

interface ArtifactFabProps {
  artifacts?: readonly ArtifactProjection[];
  taskId?: string | null;
  /** Immutable Publication ID for the manifest-driven result view. */
  publicationId?: string | null;
}

export function ArtifactFab({
  artifacts: artifactOverride,
  taskId: taskIdOverride,
  publicationId: publicationIdOverride,
}: ArtifactFabProps = {}) {
  const [open, setOpen] = useState(false);
  const activeArtifacts = useAgentStore(selectActiveArtifacts);
  const activeTask = useAgentStore(selectActiveTask);
  const artifacts = artifactOverride ?? activeArtifacts;
  const taskId = taskIdOverride ?? activeTask?.summary.task_id ?? null;
  // Publication report cards own formal results; keep this FAB for unpromoted files only.
  const executionState = useTaskPublicationId(
    publicationIdOverride == null ? taskId : null,
  );
  const resolvedPublicationId = publicationIdOverride ?? executionState.publicationId;

  if (
    taskId === null ||
    resolvedPublicationId !== null ||
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
        publicationId={resolvedPublicationId}
      />
    </>
  );
}
