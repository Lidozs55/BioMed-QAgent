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
import { coreEventToPayload } from "../dataset/service/events.js";
import { createDatasetCoreService } from "../dataset/service/dataset-core.js";
import { TypeScriptDatasetCore } from "../dataset/service/ts-core.js";
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
  /** DATASET_CORE architecture flag (M2): python = legacy bridge, ts = TS core. */
  datasetCore?: "python" | "ts";
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
    workspaceFactory: async ({ taskId, runId, recordRunEvent }) => {
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
      const datasetCore = options.datasetCore ?? "python";
      const tsCore = new TypeScriptDatasetCore({
        taskId,
        taskRoot: root,
        eventSink: async (event, buildId) => {
          await recordRunEvent(coreEventToPayload(event, buildId));
        },
      });
      const service = createDatasetCoreService({
        datasetCore,
        tsCore: datasetCore === "ts" ? tsCore : null,
        pythonClient: datasetCore === "python"
          ? new DatasetCoreClient({
              baseUrl: options.legacyTarget,
              secret: options.bridgeSecret,
            })
          : null,
      });
      return {
        root,
        tools: [
          ...createWorkspaceTools(workspace),
          ...createDatasetBuildTools({
            client: service,
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
