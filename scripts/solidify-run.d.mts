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

export interface SkillEntry {
  name: string;
  slug: string;
  description: string;
  sourcePath: string;
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

export function parseFrontmatter(text: string): { description: string; body: string };

export function scanSkills(skillsRoot: string): Promise<SkillEntry[]>;

export function renderToolkitDoc(filepath: string, skillsRoot: string): Promise<string>;

export function renderToolkitIndex(entries: SkillEntry[]): string;