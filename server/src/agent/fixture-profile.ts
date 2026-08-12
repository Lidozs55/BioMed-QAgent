import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { DatasetBuildSpec } from "@biomed/contracts";

import type {
  BioMedAgentAdapter,
  BioMedAgentEvent,
  BioMedAgentSession,
  BioMedAgentTool,
  BioMedToolResult,
  BioMedSessionConfig,
} from "./contracts.js";

export const FIXTURE_PROFILES = {
  dataset_success: "dataset_success",
  spec_rejected: "spec_rejected",
  workspace: "workspace",
  workspace_cancel: "workspace_cancel",
} as const;

export type FixtureProfile = keyof typeof FIXTURE_PROFILES;

export interface FixtureProfileOptions {
  fixturesRoot?: string;
  startDelayMs?: number;
}

function fixtureProfile(value: string): FixtureProfile {
  if (!Object.hasOwn(FIXTURE_PROFILES, value)) {
    throw new Error(`fixture_profile is not supported: ${value.slice(0, 128)}`);
  }
  return value as FixtureProfile;
}

function requiredTool(tools: readonly BioMedAgentTool[], name: string): BioMedAgentTool {
  const tool = tools.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`Fixture profile requires ${name}`);
  return tool;
}

async function* invoke(
  tool: BioMedAgentTool,
  toolCallId: string,
  args: unknown,
  signal?: AbortSignal,
): AsyncIterable<BioMedAgentEvent> {
  yield {
    type: "tool_started",
    toolCallId,
    toolName: tool.name,
    arguments: args,
  };
  const result = await tool.execute(args, signal, { toolCallId });
  yield {
    type: "tool_completed",
    toolCallId,
    toolName: tool.name,
    result: result.details ?? result.content,
    isError: result.isError === true,
  };
}

function toolEvents(
  tool: BioMedAgentTool,
  toolCallId: string,
  args: unknown,
): BioMedAgentEvent {
  return { type: "tool_started", toolCallId, toolName: tool.name, arguments: args };
}

function completedEvent(
  tool: BioMedAgentTool,
  toolCallId: string,
  result: BioMedToolResult,
): BioMedAgentEvent {
  return {
    type: "tool_completed",
    toolCallId,
    toolName: tool.name,
    result: result.details ?? result.content,
    isError: result.isError === true,
  };
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

class FixtureProfileAdapter implements BioMedAgentAdapter {
  constructor(
    private readonly profile: FixtureProfile,
    private readonly options: Required<FixtureProfileOptions>,
  ) {}

  async createSession(config: BioMedSessionConfig): Promise<BioMedAgentSession> {
    const profile = this.profile;
    const startDelayMs = this.options.startDelayMs;
    const tools = config.tools ?? [];
    const fixture = profile === "dataset_success" || profile === "spec_rejected"
      ? JSON.parse(await readFile(
          path.join(
            this.options.fixturesRoot,
            profile === "dataset_success" ? "succeeded" : "spec_rejected",
            "fixture.json",
          ),
          "utf8",
        )) as { spec: DatasetBuildSpec }
      : undefined;
    let activeController: AbortController | undefined;
    let disposed = false;
    let turnCount = 0;
    let publicationSummary = "No publication was produced.";
    return {
      piSessionId: `fixture-${profile}-${config.taskId}`,
      taskId: config.taskId,
      runId: config.runId,
      async *run(): AsyncIterable<BioMedAgentEvent> {
        if (disposed) throw new Error("Fixture session is disposed");
        const controller = new AbortController();
        activeController = controller;
        turnCount += 1;
        await delay(startDelayMs);
        yield { type: "turn_started" };
        try {
          if ((profile === "dataset_success" || profile === "spec_rejected") && turnCount > 1) {
            yield { type: "assistant_delta", delta: publicationSummary };
            yield { type: "turn_completed" };
            return;
          }
          if (profile === "workspace" || profile === "workspace_cancel") {
            for await (const event of invoke(
              requiredTool(tools, "workspace_read"),
              "fixture-read",
              { path: "source_assets/phase1f-task.txt" },
              controller.signal,
            )) yield event;
            for await (const event of invoke(
              requiredTool(tools, "workspace_write"),
              "fixture-write",
              { path: "staging/agent/note.txt", content: "fixture note: draft" },
              controller.signal,
            )) yield event;
            for await (const event of invoke(
              requiredTool(tools, "workspace_edit"),
              "fixture-edit",
              {
                path: "staging/agent/note.txt",
                oldText: "draft",
                newText: "observed",
                expectedOccurrences: 1,
              },
              controller.signal,
            )) yield event;
            for (const [toolCallId, target] of [
              ["fixture-protected-artifact", "artifacts/formal.txt"],
              ["fixture-protected-state", "state/runtime.txt"],
            ] as const) {
              for await (const event of invoke(
                requiredTool(tools, "workspace_edit"),
                toolCallId,
                {
                  path: target,
                  oldText: "formal",
                  newText: "forbidden",
                  expectedOccurrences: 1,
                },
                controller.signal,
              )) yield event;
            }
            const command = profile === "workspace_cancel"
              ? { executable: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], timeoutMs: 30_000 }
              : { executable: process.execPath, args: ["-e", "console.log('fixture-command-ok')"], timeoutMs: 5_000 };
            for await (const event of invoke(
              requiredTool(tools, "workspace_exec"),
              "fixture-exec",
              command,
              controller.signal,
            )) yield event;
            if (controller.signal.aborted) {
              yield { type: "turn_cancelled", reason: "user requested" };
              return;
            }
            yield { type: "assistant_delta", delta: "Workspace fixture observed structured tool results." };
            yield { type: "turn_completed" };
            return;
          }
          if (fixture === undefined) throw new Error(`Fixture profile ${profile} is unavailable`);
          const readTool = requiredTool(tools, "workspace_read");
          const readArgs = { path: "source_assets/phase1f-source.tsv" };
          yield toolEvents(readTool, "fixture-source-read", readArgs);
          const sourceRead = await readTool.execute(
            readArgs,
            controller.signal,
            { toolCallId: "fixture-source-read" },
          );
          yield completedEvent(readTool, "fixture-source-read", sourceRead);

          const validateTool = requiredTool(tools, "validate_dataset_build");
          const validateArgs = { spec: fixture.spec };
          yield toolEvents(validateTool, "fixture-validate", validateArgs);
          const validation = await validateTool.execute(
            validateArgs,
            controller.signal,
            { toolCallId: "fixture-validate" },
          );
          yield completedEvent(validateTool, "fixture-validate", validation);
          if (validation.isError === true) {
            const details = record(validation.details);
            const reasons = Array.isArray(details.reason_codes)
              ? details.reason_codes.join(",")
              : "unknown";
            publicationSummary = `SPEC_REJECTED (${reasons}); no build, artifact, or publication was produced.`;
            yield { type: "assistant_delta", delta: publicationSummary };
            yield { type: "turn_completed" };
            return;
          }

          const executeTool = requiredTool(tools, "execute_dataset_build");
          const executeArgs = {
            spec: fixture.spec,
            source_files: { binding_gdc: "source_assets/phase1f-source.tsv" },
            mapping_files: {},
          };
          yield toolEvents(executeTool, "fixture-execute", executeArgs);
          const execution = await executeTool.execute(
            executeArgs,
            controller.signal,
            { toolCallId: "fixture-execute" },
          );
          yield completedEvent(executeTool, "fixture-execute", execution);
          if (execution.isError === true) {
            const code = String(record(execution.details).code ?? "failure");
            publicationSummary = `DatasetBuild did not succeed (${code}); no success is claimed.`;
            yield { type: "assistant_delta", delta: publicationSummary };
            yield { type: "turn_completed" };
            return;
          }
          const data = record(record(execution.details).data);
          const result = record(data.build_result);
          const manifest = record(data.manifest);
          const artifacts = Array.isArray(data.artifacts)
            ? data.artifacts.map(record)
            : [];
          publicationSummary = [
            `DatasetBuild ${String(result.build_id ?? fixture.spec.build_id)} SUCCEEDED.`,
            `Publication ${String(data.publication_id ?? result.publication_id)}.`,
            `Manifest ${String(manifest.manifest_id)}.`,
            `Artifact ${String(artifacts[0]?.artifact_id)}.`,
          ].join(" ");
          yield { type: "assistant_delta", delta: publicationSummary };
          yield { type: "turn_completed" };
        } finally {
          if (activeController === controller) activeController = undefined;
        }
      },
      async cancel(): Promise<void> {
        activeController?.abort();
      },
      async dispose(): Promise<void> {
        disposed = true;
        activeController?.abort();
        await config.cleanup?.();
      },
    };
  }
}

export function createFixtureProfileAdapter(
  profile: string | null | undefined,
  options: FixtureProfileOptions = {},
): BioMedAgentAdapter | undefined {
  if (profile === undefined || profile === null) return undefined;
  const repositoryRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
  );
  return new FixtureProfileAdapter(fixtureProfile(profile), {
    fixturesRoot: options.fixturesRoot ?? path.join(repositoryRoot, "tests", "migration", "golden"),
    startDelayMs: options.startDelayMs ?? 75,
  });
}
