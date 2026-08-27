/**
 * Declaration for solidify-run.mjs (the self-iteration / toolkit engine).
 * The plain Node .mjs script is deliberately untyped; this sidecar declaration
 * lets TypeScript consumers (server/tests/solidify-run.test.ts) type-check the
 * shared pure functions without enabling allowJs project-wide.
 */

export interface SolidStep {
  seq: number;
  runId?: string;
  name: string;
  args?: unknown;
  startedAt?: string;
  completedAt?: string | null;
  isError: boolean | null;
}

export interface SolidFlow {
  runId?: string;
  steps: SolidStep[];
  deterministic: SolidStep[];
  acquire: SolidStep[];
}

export interface ToolDocEntry {
  name: string;
  description: string;
  parametersSource: string;
}

export interface ToolFactoryEntry {
  name: string;
  signature: string;
}

export interface ToolModuleEntry {
  moduleName: string;
  slug: string;
  purpose: string;
  sourcePath: string;
  imports: string[];
  factories: ToolFactoryEntry[];
  tools: ToolDocEntry[];
}

export type StepKind = "deterministic" | "acquire" | "skip";

export function classifyStep(name: string | undefined): StepKind;

export function parameterizeArgs(argumentsValue: unknown): string[];

export function traceFlow(
  eventsLines: string[],
): { flows: SolidFlow[]; lastRunStatus: string | null };

export function renderScriptCandidate(
  run: { runId?: string; deterministic: SolidStep[] },
  meta: { taskId?: string },
): string;

export function renderSkillCandidate(
  run: { deterministic: SolidStep[]; acquire: SolidStep[] },
  meta: { taskId?: string; runId?: string },
): string;

export function scanToolModules(toolsRoot: string): Promise<ToolModuleEntry[]>;

export function renderToolkitDoc(entry: ToolModuleEntry): string;

export function renderToolkitIndex(entries: ToolModuleEntry[]): string;
