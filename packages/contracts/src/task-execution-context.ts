/**
 * Task execution context wire DTO ("carry the frozen Gold contract as durable
 * run context").
 *
 * A run may carry the exact frozen evaluation contract it was admitted under:
 * manifest/case/prompt/runtime-profile hashes plus the expected family,
 * required tables, allowed sources, source selection, success definition, and
 * forbidden shortcuts. The context is evidence binding, not instruction: it is
 * persisted with the run, replayed byte-equivalently across Host restarts, and
 * injected through the Agent system prompt — never merged into the user
 * message and never a way around the deterministic pipeline.
 */
import { APIError } from "./runtime/errors.js";
import {
  assertArray,
  assertFinite,
  assertHex64,
  assertObject,
  assertString,
} from "./runtime/primitives.js";

export const TASK_EXECUTION_CONTEXT_SCHEMA_VERSION = "1.0" as const;
export const FROZEN_EVALUATION_CONTEXT_KIND = "frozen_evaluation" as const;

export interface FrozenEvaluationContextV1 {
  schema_version: "1.0";
  kind: "frozen_evaluation";
  manifest_id: string;
  case_id: string;
  manifest_sha256: string;
  case_spec_sha256: string;
  prompt_sha256: string;
  runtime_profile_sha256: string;
  expected_family: string;
  required_tables: readonly string[];
  allowed_sources: readonly string[];
  source_selection: Readonly<Record<string, readonly string[]>>;
  success_definition: string;
  forbidden_shortcuts: readonly string[];
}

/** Versioned execution-context union carried by ``run_queued`` and ``RunRecord``. */
export type TaskExecutionContext = FrozenEvaluationContextV1;

/**
 * The frozen case facts a context must match when it is admitted for a known
 * frozen case (evaluation runner side).
 */
export interface FrozenCaseReferenceV1 {
  case_id: string;
  prompt_sha256: string;
}

const CONTEXT_KEYS: readonly (keyof FrozenEvaluationContextV1)[] = [
  "schema_version",
  "kind",
  "manifest_id",
  "case_id",
  "manifest_sha256",
  "case_spec_sha256",
  "prompt_sha256",
  "runtime_profile_sha256",
  "expected_family",
  "required_tables",
  "allowed_sources",
  "source_selection",
  "success_definition",
  "forbidden_shortcuts",
];

function assertCleanText(value: string, path: string): string {
  if (value.includes("\uFFFD")) {
    throw new APIError(502, `Expected UTF-8 clean text without U+FFFD at ${path}`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new APIError(502, `Expected well-formed Unicode at ${path}`);
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new APIError(502, `Expected well-formed Unicode at ${path}`);
    }
  }
  return value;
}

function assertBoundedText(value: unknown, path: string): string {
  return assertCleanText(assertString(value, path, true), path);
}

/** Source identifiers are bare names: URLs and paths are hostile wire. */
function assertIdentifier(value: unknown, path: string): string {
  const text = assertBoundedText(value, path);
  if (text.includes("://") || text.includes("/") || text.includes("\\")) {
    throw new APIError(502, `Expected a bare identifier without URL or path syntax at ${path}: "${text}"`);
  }
  return text;
}

function frozenIdentifierArray(value: unknown, path: string): readonly string[] {
  const values = assertArray(value, path, (item, index) =>
    assertIdentifier(item, `${path}[${index}]`),
  );
  return Object.freeze(values);
}

function frozenUniqueIdentifierArray(value: unknown, path: string): readonly string[] {
  const values = frozenIdentifierArray(value, path);
  const seen = new Set<string>();
  for (const item of values) {
    if (seen.has(item)) {
      throw new APIError(502, `Expected unique entries at ${path}, found duplicate "${item}"`);
    }
    seen.add(item);
  }
  return values;
}

function parseSourceSelection(
  value: unknown,
  path: string,
): Readonly<Record<string, readonly string[]>> {
  const obj = assertObject(value, path);
  const result: Record<string, readonly string[]> = {};
  for (const key of Object.keys(obj)) {
    const keyPath = `${path}.${key}`;
    result[assertIdentifier(key, keyPath)] = frozenIdentifierArray(obj[key], keyPath);
  }
  return Object.freeze(result);
}

/**
 * Exact, bounded, UTF-8-clean parser. When ``frozenCase`` is provided the
 * context must match that frozen case (case id and prompt hash) or it is
 * rejected as hostile wire, mirroring the frozen-file cross-check the
 * evaluation runner performs before submitting.
 */
export function parseTaskExecutionContext(
  value: unknown,
  path = "task_execution_context",
  frozenCase?: FrozenCaseReferenceV1,
): TaskExecutionContext {
  const obj = assertObject(value, path);
  const known = new Set<string>(CONTEXT_KEYS);
  for (const key of Object.keys(obj)) {
    if (!known.has(key)) {
      throw new APIError(502, `Unknown field "${key}" at ${path}`);
    }
  }
  const context: FrozenEvaluationContextV1 = {
    schema_version: assertFinite(obj.schema_version, `${path}.schema_version`, [
      TASK_EXECUTION_CONTEXT_SCHEMA_VERSION,
    ] as const),
    kind: assertFinite(obj.kind, `${path}.kind`, [FROZEN_EVALUATION_CONTEXT_KIND] as const),
    manifest_id: assertBoundedText(obj.manifest_id, `${path}.manifest_id`),
    case_id: assertIdentifier(obj.case_id, `${path}.case_id`),
    manifest_sha256: assertHex64(obj.manifest_sha256, `${path}.manifest_sha256`),
    case_spec_sha256: assertHex64(obj.case_spec_sha256, `${path}.case_spec_sha256`),
    prompt_sha256: assertHex64(obj.prompt_sha256, `${path}.prompt_sha256`),
    runtime_profile_sha256: assertHex64(obj.runtime_profile_sha256, `${path}.runtime_profile_sha256`),
    expected_family: assertBoundedText(obj.expected_family, `${path}.expected_family`),
    required_tables: frozenUniqueIdentifierArray(obj.required_tables, `${path}.required_tables`),
    allowed_sources: frozenIdentifierArray(obj.allowed_sources, `${path}.allowed_sources`),
    source_selection: parseSourceSelection(obj.source_selection, `${path}.source_selection`),
    success_definition: assertBoundedText(obj.success_definition, `${path}.success_definition`),
    forbidden_shortcuts: frozenIdentifierArray(obj.forbidden_shortcuts, `${path}.forbidden_shortcuts`),
  };
  if (frozenCase !== undefined) {
    if (context.case_id !== frozenCase.case_id || context.prompt_sha256 !== frozenCase.prompt_sha256) {
      throw new APIError(
        502,
        `Execution context does not match the frozen case at ${path}: ` +
          `expected ${frozenCase.case_id}@${frozenCase.prompt_sha256}, ` +
          `got ${context.case_id}@${context.prompt_sha256}`,
      );
    }
  }
  return Object.freeze(context);
}

/**
 * Deterministic JSON serialization with fixed key order (source_selection
 * keys sorted): two contexts serialize byte-equivalently iff they are equal.
 * Used for request-id idempotency comparison and for the Agent system-prompt
 * section.
 */
export function stableTaskExecutionContextJson(context: TaskExecutionContext): string {
  const ordered: Record<string, unknown> = {};
  for (const key of CONTEXT_KEYS) {
    if (key === "source_selection") {
      const selection: Record<string, unknown> = {};
      for (const group of Object.keys(context.source_selection).sort()) {
        selection[group] = context.source_selection[group];
      }
      ordered[key] = selection;
      continue;
    }
    ordered[key] = context[key];
  }
  return JSON.stringify(ordered, null, 2);
}
