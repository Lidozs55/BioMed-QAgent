import { copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { BioMedAgentAdapter, BioMedModelConfig } from "./contracts.js";
import { createExperimentalPiRuntime, type ExperimentalPiRuntime } from "./experimental-pi.js";
import { createFixtureProfileAdapter } from "./fixture-profile.js";
import { PiAgentAdapter } from "./pi-adapter.js";
import { createDatasetBuildTools } from "./tools/dataset-build.js";
import { AppendOnlyTaskAuditSink, createTaskWorkspace } from "./workspace/index.js";
import { createWorkspaceTools } from "./workspace/tools.js";
import { DatasetCoreClient } from "../legacy/dataset-core-client.js";

export interface Phase1ExperimentalRuntimeOptions {
  repositoryRoot: string;
  tasksRoot: string;
  legacyTarget: string;
  bridgeSecret?: string;
  workspaceDevExec: boolean;
  normalAdapter?: BioMedAgentAdapter;
  resolveModel?: () => Promise<BioMedModelConfig>;
}

async function prepareTaskRoot(
  repositoryRoot: string,
  root: string,
  fixtureProfile?: string,
): Promise<void> {
  await Promise.all([
    mkdir(path.join(root, "source_assets"), { recursive: true }),
    mkdir(path.join(root, "staging", "agent"), { recursive: true }),
  ]);
  if (fixtureProfile === undefined) return;
  await Promise.all([
    copyFile(
      path.join(repositoryRoot, "backend", "tests", "fixtures", "gdc", "gdc_expression.tsv"),
      path.join(root, "source_assets", "phase1f-source.tsv"),
    ),
    writeFile(
      path.join(root, "source_assets", "phase1f-task.txt"),
      "Read this local fixture, create and edit a staging note, then run the governed command.\n",
      "utf8",
    ),
  ]);
}

export function createPhase1ExperimentalRuntime(
  options: Phase1ExperimentalRuntimeOptions,
): Promise<ExperimentalPiRuntime> {
  return createExperimentalPiRuntime({
    adapter: options.normalAdapter ?? new PiAgentAdapter({
      environment: process.env,
      resolveModel: options.resolveModel,
    }),
    fixtureProfileAdapter: (profile) => {
      const adapter = createFixtureProfileAdapter(profile, {
        fixturesRoot: path.join(options.repositoryRoot, "tests", "migration", "golden"),
      });
      if (adapter === undefined) throw new Error("fixture_profile is unavailable");
      return adapter;
    },
    workspaceFactory: async ({ taskId, runId, fixtureProfile }) => {
      let currentRunId = runId;
      let currentPiSessionId = "pi_session_pending";
      const root = path.join(options.tasksRoot, taskId);
      await prepareTaskRoot(options.repositoryRoot, root, fixtureProfile);
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
          }),
        ],
        setRunId: (nextRunId: string) => {
          currentRunId = nextRunId;
          workspace.setRunId(nextRunId);
        },
        setPiSessionId: (piSessionId: string) => {
          currentPiSessionId = piSessionId;
        },
        activeCommandCount: () => workspace.activeCommandCount,
        dispose: () => workspace.dispose(),
      };
    },
  });
}
