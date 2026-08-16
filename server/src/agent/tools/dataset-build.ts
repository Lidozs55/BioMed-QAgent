import type {
  BuildResult,
  DatasetBridgeResponse,
  DatasetBuildSpec,
} from "@biomed/contracts";

import type {
  BioMedAgentTool,
  BioMedToolExecutionContext,
  BioMedToolResult,
} from "../contracts.js";
import type { DatasetCoreService } from "../../dataset/service/dataset-core.js";

const MAX_ID = 128;
const MAX_CONTENT = 4_096;

export interface DatasetBuildToolDiagnostic {
  taskId: string;
  runId: string;
  piSessionId: string;
  toolCallId: string;
  toolName: "validate_dataset_build" | "execute_dataset_build";
  requestId?: string;
  buildId?: string;
  code: "ok" | string;
  durationMs: number;
}

export interface DatasetBuildToolOptions {
  client: Pick<DatasetCoreService, "validate" | "execute">;
  taskId: string;
  runId: () => string;
  piSessionId: () => string;
  onDiagnostic?: (diagnostic: DatasetBuildToolDiagnostic) => void;
  onBuildResult?: (result: BuildResult | null) => void;
  now?: () => number;
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("tool arguments must be an object");
  }
  return value as Record<string, unknown>;
}

function specArgument(value: Record<string, unknown>): DatasetBuildSpec {
  return object(value.spec) as unknown as DatasetBuildSpec;
}

function mappingArgument(
  value: Record<string, unknown>,
  name: "source_files" | "mapping_files" | "metadata_files",
): Record<string, string> {
  const mapping = object(value[name]);
  if (Object.values(mapping).some((item) => typeof item !== "string")) {
    throw new TypeError(`${name} must map binding IDs to task-relative references`);
  }
  return mapping as Record<string, string>;
}

function resultFor(response: DatasetBridgeResponse): BioMedToolResult {
  const details = response.ok
    ? { code: "ok", request_id: response.request_id, data: response.data }
    : {
        code: response.error.code,
        request_id: response.request_id,
        message: response.error.message,
        ...response.error.details,
      };
  return {
    content: JSON.stringify(details).slice(0, MAX_CONTENT),
    details,
    isError: !response.ok,
  };
}

function diagnostic(
  options: DatasetBuildToolOptions,
  toolName: DatasetBuildToolDiagnostic["toolName"],
  context: BioMedToolExecutionContext | undefined,
  started: number,
  response: DatasetBridgeResponse | undefined,
  code: string,
  buildId?: string,
): void {
  options.onDiagnostic?.({
    taskId: options.taskId.slice(0, MAX_ID),
    runId: options.runId().slice(0, MAX_ID),
    piSessionId: options.piSessionId().slice(0, MAX_ID),
    toolCallId: (context?.toolCallId ?? "unknown").slice(0, MAX_ID),
    toolName,
    requestId: response?.request_id.slice(0, MAX_ID),
    buildId: buildId?.slice(0, MAX_ID),
    code: code.slice(0, MAX_ID),
    durationMs: Math.max(0, (options.now ?? Date.now)() - started),
  });
}

function caught(error: unknown): BioMedToolResult {
  const code =
    error !== null && typeof error === "object" && "code" in error &&
    typeof error.code === "string"
      ? error.code.slice(0, MAX_ID)
      : "invalid_input";
  const message =
    error instanceof Error && error.message.trim().length > 0
      ? error.message.slice(0, MAX_CONTENT)
      : "Dataset build tool failed";
  return {
    content: JSON.stringify({ code, message }),
    details: { code, message },
    isError: true,
  };
}

function captureBuildResult(
  options: DatasetBuildToolOptions,
  response: DatasetBridgeResponse,
): void {
  if (response.ok) {
    if ("build_result" in response.data) options.onBuildResult?.(response.data.build_result);
    return;
  }
  if (response.error.details.build_result !== undefined) {
    options.onBuildResult?.(response.error.details.build_result);
  }
}

function captureSpecRejected(
  options: DatasetBuildToolOptions,
  response: DatasetBridgeResponse,
  buildId: string,
): void {
  if (response.ok || response.error.code !== "spec_rejected") return;
  const reasonCodes = response.error.details.reason_codes ?? [];
  options.onBuildResult?.({
    status: "spec_rejected",
    valid_row_count: 0,
    successful_sources: [],
    rejected_sources: [],
    available_artifact_roles: [],
    publication_id: null,
    reason_codes: reasonCodes,
    user_summary: response.error.message,
    recommended_next_action: "Correct the DatasetBuildSpec and validate it again.",
    build_id: buildId,
  });
}

export function createDatasetBuildTools(
  options: DatasetBuildToolOptions,
): BioMedAgentTool[] {
  const specSchema = { type: "object", additionalProperties: true } as const;
  const mappingSchema = {
    type: "object",
    additionalProperties: { type: "string", minLength: 1 },
  } as const;
  return [
    {
      name: "validate_dataset_build",
      label: "Validate DatasetBuildSpec",
      description: "Validate the frozen DatasetBuildSpec through the trusted Dataset Core.",
      parameters: {
        type: "object",
        properties: { spec: specSchema },
        required: ["spec"],
        additionalProperties: false,
      },
      async execute(value, signal, context) {
        const started = (options.now ?? Date.now)();
        let response: DatasetBridgeResponse | undefined;
        try {
          response = await options.client.validate({
            taskId: options.taskId,
            runId: options.runId(),
            piSessionId: options.piSessionId(),
            toolCallId: context?.toolCallId ?? "unknown",
            spec: specArgument(object(value)),
            signal,
          });
          if (response.ok) options.onBuildResult?.(null);
          captureSpecRejected(options, response, specArgument(object(value)).build_id);
          diagnostic(
            options,
            "validate_dataset_build",
            context,
            started,
            response,
            response.ok ? "ok" : response.error.code,
          );
          return resultFor(response);
        } catch (error) {
          diagnostic(options, "validate_dataset_build", context, started, response, "bridge_unavailable");
          return caught(error);
        }
      },
    },
    {
      name: "execute_dataset_build",
      label: "Execute DatasetBuildSpec",
      description: "Validate, execute, and publish a dataset through the trusted Dataset Core.",
      parameters: {
        type: "object",
        properties: {
          spec: specSchema,
          source_files: mappingSchema,
          mapping_files: mappingSchema,
          metadata_files: mappingSchema,
        },
        required: ["spec", "source_files", "mapping_files"],
        additionalProperties: false,
      },
      async execute(value, signal, context) {
        const started = (options.now ?? Date.now)();
        let response: DatasetBridgeResponse | undefined;
        let buildId: string | undefined;
        try {
          const args = object(value);
          const spec = specArgument(args);
          buildId = spec.build_id;
          const identity = {
            taskId: options.taskId,
            runId: options.runId(),
            piSessionId: options.piSessionId(),
            toolCallId: context?.toolCallId ?? "unknown",
            spec,
            signal,
          };
          const validation = await options.client.validate(identity);
          if (!validation.ok) {
            response = validation;
            captureSpecRejected(options, validation, buildId);
            diagnostic(options, "execute_dataset_build", context, started, response, validation.error.code, buildId);
            return resultFor(validation);
          }
          options.onBuildResult?.(null);
          response = await options.client.execute({
            ...identity,
            sourceFiles: mappingArgument(args, "source_files"),
            mappingFiles: mappingArgument(args, "mapping_files"),
            metadataFiles: args.metadata_files === undefined
              ? {}
              : mappingArgument(args, "metadata_files"),
          });
          captureBuildResult(options, response);
          diagnostic(
            options,
            "execute_dataset_build",
            context,
            started,
            response,
            response.ok ? "ok" : response.error.code,
            buildId,
          );
          return resultFor(response);
        } catch (error) {
          diagnostic(options, "execute_dataset_build", context, started, response, "bridge_unavailable", buildId);
          return caught(error);
        }
      },
    },
  ];
}
