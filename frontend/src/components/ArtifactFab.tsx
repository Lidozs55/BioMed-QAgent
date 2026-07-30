import { useState } from "react";
import { FilesIcon } from "@phosphor-icons/react";

import { ArtifactSheet } from "@/components/ArtifactSheet";
import { Button } from "@/components/ui/button";
import type { ArtifactProjection } from "@/runtime/types";
import {
  selectActiveArtifacts,
  selectActiveTask,
} from "@/stores/agentSelectors";
import { useAgentStore } from "@/stores/agentStore";

interface ArtifactFabProps {
  artifacts?: readonly ArtifactProjection[];
  taskId?: string | null;
}

export function ArtifactFab({
  artifacts: artifactOverride,
  taskId: taskIdOverride,
}: ArtifactFabProps = {}) {
  const [open, setOpen] = useState(false);
  const activeArtifacts = useAgentStore(selectActiveArtifacts);
  const activeTask = useAgentStore(selectActiveTask);
  const artifacts = artifactOverride ?? activeArtifacts;
  const taskId = taskIdOverride ?? activeTask?.summary.task_id ?? null;

  if (artifacts.length === 0 || taskId === null) return null;

  return (
    <>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={() => setOpen(true)}
        aria-label={`查看 ${artifacts.length} 个产物`}
      >
        <FilesIcon data-icon="inline-start" aria-hidden="true" />
        {artifacts.length}
      </Button>
      <ArtifactSheet
        open={open}
        onOpenChange={setOpen}
        artifacts={artifacts}
        taskId={taskId}
      />
    </>
  );
}
