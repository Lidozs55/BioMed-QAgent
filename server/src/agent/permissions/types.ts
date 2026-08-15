/**
 * Permission model (Agent Workspace refactor, plan §4–§19).
 *
 * ``Permission = Capability × Resource × Policy``
 *
 * - Capability: what the agent wants to do (``fs.read`` / ``fs.write`` /
 *   ``fs.edit`` / ``process.exec``).
 * - Resource: the path / command being targeted, classified into a scope.
 * - Policy: the only three outcomes — ``allow`` (execute immediately),
 *   ``ask`` (suspend the tool call for user approval), ``deny`` (return a
 *   structured permission error).
 */

export type PermissionCapability =
  | "fs.read"
  | "fs.write"
  | "fs.edit"
  | "process.exec";

export type PermissionPolicy = "allow" | "ask" | "deny";

export type ResourceScope =
  | "workspace"
  | "task_output"
  | "project"
  | "external";

export type GrantScope = "once" | "run" | "task" | "persistent";

export type PermissionDecision = "allow" | "deny";

/** A resolved permission request handed to the broker. */
export interface PermissionRequest {
  id: string;
  taskId: string;
  runId: string;
  capability: PermissionCapability;
  /** User-facing resource description (path or command). */
  resource?: string;
  /** Canonical absolute resource path (fs capabilities only). */
  canonicalResource?: string;
  /** Command being executed (process.exec only). */
  command?: string;
  /** Working directory of the requested command. */
  cwd?: string;
  scope: ResourceScope;
  createdAt: string;
}

/** Persistent path rule (plan §18). */
export interface FilePermissionRule {
  id: string;
  capability: "fs.read" | "fs.write" | "fs.edit";
  /** Canonical absolute path the rule applies to. */
  path: string;
  recursive: boolean;
  policy: "allow" | "ask" | "deny";
}

/** User-facing permission settings (plan §36, §35). */
export type PermissionPreset = "restricted" | "ask_when_needed" | "full_access";

export interface PermissionSettings {
  schema_version: 1;
  preset: PermissionPreset;
  rules: FilePermissionRule[];
  /** Persistent "always allow commands" override (exec has no path). */
  persistent_exec_allow: boolean;
}

/** Default capability × scope policy matrix for a preset. */
export type PolicyMatrix = Record<PermissionCapability, Record<ResourceScope, PermissionPolicy>>;

export const PRESET_MATRICES: Record<PermissionPreset, PolicyMatrix> = {
  // Plan §7.1: only the agent's own workspace; everything else denied.
  restricted: {
    "fs.read": { workspace: "allow", task_output: "allow", project: "deny", external: "deny" },
    "fs.write": { workspace: "allow", task_output: "deny", project: "deny", external: "deny" },
    "fs.edit": { workspace: "allow", task_output: "deny", project: "deny", external: "deny" },
    "process.exec": { workspace: "deny", task_output: "deny", project: "deny", external: "deny" },
  },
  // Plan §6/§7.2: the recommended default — ask when needed.
  ask_when_needed: {
    "fs.read": { workspace: "allow", task_output: "allow", project: "ask", external: "ask" },
    "fs.write": { workspace: "allow", task_output: "deny", project: "ask", external: "ask" },
    "fs.edit": { workspace: "allow", task_output: "deny", project: "ask", external: "ask" },
    "process.exec": { workspace: "ask", task_output: "ask", project: "ask", external: "ask" },
  },
  // Plan §7.3: explicit user choice; UI must warn about OS account rights.
  full_access: {
    "fs.read": { workspace: "allow", task_output: "allow", project: "allow", external: "allow" },
    "fs.write": { workspace: "allow", task_output: "deny", project: "allow", external: "allow" },
    "fs.edit": { workspace: "allow", task_output: "deny", project: "allow", external: "allow" },
    "process.exec": { workspace: "allow", task_output: "allow", project: "allow", external: "allow" },
  },
};

export const DEFAULT_PERMISSION_SETTINGS: PermissionSettings = {
  schema_version: 1,
  preset: "ask_when_needed",
  rules: [],
  persistent_exec_allow: false,
};

/** Structured error surfaced to the agent when a permission is denied. */
export class PermissionDeniedError extends Error {
  constructor(
    readonly request: PermissionRequest,
    message?: string,
  ) {
    super(message ?? `Permission denied: ${request.capability} ${request.resource ?? ""}`.trim());
    this.name = "PermissionDeniedError";
  }
}
