import type {
  DatasetBridgeResponse,
  DatasetBuildSpec,
} from "@biomed/contracts";

import type {
  BioMedAgentTool,
  BioMedToolExecutionContext,
  BioMedToolResult,
} from "../contracts.js";
import type { DatasetCoreClientLike } from "../../legacy/dataset-core-client.js";

const MAX_ID = 128;
const MAX_CONTENT = 4_096;

export interface DatasetBuildToolDiagnostic {
  toolCallId: string;
  toolName: "validate_dataset_build" | "execute_dataset_build";
  requestId?: string;
  buildId?: string;
  code: "ok" | string;
  durationMs: number;
}

export interface DatasetBuildToolOptions {
  client: DatasetCoreClientLike;
  taskId: string;
  runId: () => string;
  onDiagnostic?: (diagnostic: DatasetBuildToolDiagnostic) => void;
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
  name: "source_files" | "mapping_files",
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
  return {
    content: JSON.stringify({ code, message: "Dataset build tool failed" }),
    details: { code, message: "Dataset build tool failed" },
    isError: true,
  };
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
      description: "Validate the frozen DatasetBuildSpec through the trusted Python Core.",
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
            spec: specArgument(object(value)),
            signal,
          });
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
      description: "Validate, execute, and publish a dataset through the trusted Python Core.",
      parameters: {
        type: "object",
        properties: {
          spec: specSchema,
          source_files: mappingSchema,
          mapping_files: mappingSchema,
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
            spec,
            signal,
          };
          const validation = await options.client.validate(identity);
          if (!validation.ok) {
            response = validation;
            diagnostic(options, "execute_dataset_build", context, started, response, validation.error.code, buildId);
            return resultFor(validation);
          }
          response = await options.client.execute({
            ...identity,
            sourceFiles: mappingArgument(args, "source_files"),
            mappingFiles: mappingArgument(args, "mapping_files"),
          });
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
