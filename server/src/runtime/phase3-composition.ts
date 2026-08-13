import path from "node:path";

import type { BioMedAgentAdapter, BioMedModelConfig } from "../agent/contracts.js";
import { PiAgentAdapter } from "../agent/pi-adapter.js";
import { createDatasetBuildTools } from "../agent/tools/dataset-build.js";
import {
  AppendOnlyTaskAuditSink,
  createTaskWorkspace,
} from "../agent/workspace/index.js";
import { createWorkspaceTools } from "../agent/workspace/tools.js";
import { DatasetCoreClient } from "../legacy/dataset-core-client.js";
import {
  createDurableAgentRuntime,
  type DurableAgentRuntime,
} from "./durable-agent-runtime.js";

export interface Phase3RuntimeOptions {
  tasksRoot: string;
  legacyTarget: string;
  bridgeSecret?: string;
  workspaceDevExec: boolean;
  adapter?: BioMedAgentAdapter;
  resolveModel?: () => Promise<BioMedModelConfig>;
}

export function createPhase3Runtime(
  options: Phase3RuntimeOptions,
): Promise<DurableAgentRuntime> {
  return createDurableAgentRuntime({
    tasksRoot: options.tasksRoot,
    legacyBaseUrl: options.legacyTarget,
    adapter: options.adapter ?? new PiAgentAdapter({
      environment: process.env,
      resolveModel: options.resolveModel,
    }),
    workspaceFactory: async ({ taskId, runId }) => {
      let currentRunId = runId;
      let currentPiSessionId = "pi_session_pending";
      let buildResult: import("@biomed/contracts").BuildResult | null = null;
      const root = path.join(options.tasksRoot, taskId);
      const workspace = await createTaskWorkspace({
        taskId,
        runId,
        root,
        audit: new AppendOnlyTaskAuditSink(root),
        ...(options.workspaceDevExec
          ? { developmentExec: { enabled: true as const } }
          : {}),
      });
      const client = new DatasetCoreClient({
        baseUrl: options.legacyTarget,
        secret: options.bridgeSecret,
      });
      return {
        root,
        tools: [
          ...createWorkspaceTools(workspace),
          ...createDatasetBuildTools({
            client,
            taskId,
            runId: () => currentRunId,
            piSessionId: () => currentPiSessionId,
            onDiagnostic: (diagnostic) => {
              console.info("tool.dataset_build", diagnostic);
            },
            onBuildResult: (result) => {
              buildResult = result;
            },
          }),
        ],
        setRunId: (nextRunId: string) => {
          currentRunId = nextRunId;
          workspace.setRunId(nextRunId);
        },
        setPiSessionId: (piSessionId: string) => {
          currentPiSessionId = piSessionId;
        },
        consumeBuildResult: () => {
          const result = buildResult;
          buildResult = null;
          return result;
        },
        dispose: () => workspace.dispose(),
      };
    },
  });
}
