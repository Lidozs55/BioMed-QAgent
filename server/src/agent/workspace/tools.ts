import type { BioMedAgentTool, BioMedToolResult } from "../contracts.js";
import { PermissionDeniedError } from "../permissions/index.js";
import type { TaskWorkspace } from "./index.js";
import { WorkspacePolicyError } from "./types.js";

function objectArguments(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkspacePolicyError("PRECONDITION_FAILED", "Tool arguments must be an object");
  }
  return value as Record<string, unknown>;
}
function stringArgument(value: Record<string, unknown>, name: string): string {
  const argument = value[name];
  if (typeof argument !== "string") {
    throw new WorkspacePolicyError("PRECONDITION_FAILED", `${name} must be text`);
  }
  return argument;
}

function optionalInteger(
  value: Record<string, unknown>,
  name: string,
): number | undefined {
  const argument = value[name];
  if (argument === undefined) return undefined;
  if (!Number.isSafeInteger(argument)) {
    throw new WorkspacePolicyError("PRECONDITION_FAILED", `${name} must be an integer`);
  }
  return argument as number;
}

function stringArray(value: Record<string, unknown>, name: string): string[] {
  const argument = value[name];
  if (!Array.isArray(argument) || argument.some((item) => typeof item !== "string")) {
    throw new WorkspacePolicyError("PRECONDITION_FAILED", `${name} must be a text array`);
  }
  return argument as string[];
}

function success(details: unknown, isError = false): BioMedToolResult {
  return { content: JSON.stringify(details), details, isError };
}

async function executeBounded(
  operation: () => Promise<BioMedToolResult>,
): Promise<BioMedToolResult> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof WorkspacePolicyError) {
      const details = { code: error.code, message: error.message };
      return success(details, true);
    }
    if (error instanceof PermissionDeniedError) {
      const details = {
        code: "PERMISSION_DENIED",
        message: error.message,
        capability: error.request.capability,
        resource: error.request.resource ?? null,
        scope: error.request.scope,
      };
      return success(details, true);
    }
    return success(
      { code: "WORKSPACE_OPERATION_FAILED", message: "Workspace operation failed" },
      true,
    );
  }
}

const pathProperty = { type: "string", minLength: 1 } as const;

export function createWorkspaceTools(workspace: TaskWorkspace): BioMedAgentTool[] {
  return [
    {
      name: "workspace_read",
      label: "Read text",
      description: "Read bounded UTF-8 text from a workspace-relative or absolute path (permission-gated).",
      parameters: {
        type: "object",
        properties: {
          path: pathProperty,
          offset: { type: "integer", minimum: 0 },
          length: { type: "integer", minimum: 1 },
        },
        required: ["path"],
        additionalProperties: false,
      },
      execute: (value) => executeBounded(async () => {
        const args = objectArguments(value);
        return success(await workspace.read({
          path: stringArgument(args, "path"),
          offset: optionalInteger(args, "offset"),
          length: optionalInteger(args, "length"),
        }));
      }),
    },
    {
      name: "workspace_list",
      label: "List paths",
      description: "List bounded entries of a workspace-relative or absolute directory without following escaping links.",
      parameters: {
        type: "object",
        properties: { path: pathProperty, depth: { type: "integer", minimum: 1 } },
        required: ["path"],
        additionalProperties: false,
      },
      execute: (value) => executeBounded(async () => {
        const args = objectArguments(value);
        return success(await workspace.list({
          path: stringArgument(args, "path"),
          depth: optionalInteger(args, "depth"),
        }));
      }),
    },
    {
      name: "workspace_search",
      label: "Search text",
      description: "Search bounded UTF-8 files under a workspace-relative or absolute directory using a literal query.",
      parameters: {
        type: "object",
        properties: { path: pathProperty, query: { type: "string", minLength: 1 } },
        required: ["path", "query"],
        additionalProperties: false,
      },
      execute: (value) => executeBounded(async () => {
        const args = objectArguments(value);
        return success(await workspace.search({
          path: stringArgument(args, "path"),
          query: stringArgument(args, "query"),
        }));
      }),
    },
    {
      name: "workspace_write",
      label: "Write text",
      description: "Atomically write bounded UTF-8 content to a workspace-relative or absolute path (permission-gated).",
      parameters: {
        type: "object",
        properties: { path: pathProperty, content: { type: "string" } },
        required: ["path", "content"],
        additionalProperties: false,
      },
      execute: (value) => executeBounded(async () => {
        const args = objectArguments(value);
        return success(await workspace.write({
          path: stringArgument(args, "path"),
          content: stringArgument(args, "content"),
        }));
      }),
    },
    {
      name: "workspace_edit",
      label: "Edit text",
      description: "Apply an exact bounded replacement to a workspace-relative or absolute path (permission-gated).",
      parameters: {
        type: "object",
        properties: {
          path: pathProperty,
          oldText: { type: "string", minLength: 1 },
          newText: { type: "string" },
          expectedOccurrences: { type: "integer", minimum: 1 },
        },
        required: ["path", "oldText", "newText", "expectedOccurrences"],
        additionalProperties: false,
      },
      execute: (value) => executeBounded(async () => {
        const args = objectArguments(value);
        return success(await workspace.edit({
          path: stringArgument(args, "path"),
          oldText: stringArgument(args, "oldText"),
          newText: stringArgument(args, "newText"),
          expectedOccurrences: optionalInteger(args, "expectedOccurrences") ?? 0,
        }));
      }),
    },
    {
      name: "workspace_exec",
      label: "Execute command",
      description: "Run a bounded executable and argument array when command execution is permitted.",
      parameters: {
        type: "object",
        properties: {
          executable: { type: "string", minLength: 1 },
          args: { type: "array", items: { type: "string" }, maxItems: 100 },
          timeoutMs: { type: "integer", minimum: 1 },
        },
        required: ["executable", "args"],
        additionalProperties: false,
      },
      execute: (value, signal) => executeBounded(async () => {
        const args = objectArguments(value);
        const result = await workspace.exec({
          executable: stringArgument(args, "executable"),
          args: stringArray(args, "args"),
          timeoutMs: optionalInteger(args, "timeoutMs"),
        }, signal);
        return success(result, result.policy !== "allowed" || result.cancelled || result.timedOut);
      }),
    },
  ];
}
