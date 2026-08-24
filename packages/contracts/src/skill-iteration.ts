import { APIError } from "./runtime/errors.js";
import {
  assertArray,
  assertFinite,
  assertHex64,
  assertNonNegativeInt,
  assertObject,
  assertPositiveInt,
  assertString,
} from "./runtime/primitives.js";

export type SkillCategory = "discovery" | "acquisition" | "processing" | "analysis";
export type SkillIterationConfidence = "explicit" | "repeated" | "tentative";

export interface SkillIterationTarget {
  name: string;
  description: string;
  category: SkillCategory;
  source_digest: string;
}

export interface SkillIterationHistoryTask {
  task_id: string;
  title: string;
  updated_at: string;
  message_count: number;
}

export interface SkillIterationSignal {
  category: "interaction" | "data_processing" | "output" | "constraint";
  requirement: string;
  action: string;
  confidence: SkillIterationConfidence;
  evidence_refs: string[];
}

export interface SkillIterationDataProcessingPreference {
  stage: string;
  method: string;
  applies_when: string;
  verification: string;
  evidence_refs: string[];
}

export interface SkillIterationContext {
  schema_version: "1.0";
  targets: SkillIterationTarget[];
  history_tasks: SkillIterationHistoryTask[];
  defaults: { max_tasks: number; max_messages_per_task: number };
  privacy_notice: string;
}

export interface StartSkillIterationRequest {
  schema_version: "1.0";
  target_skill: string;
  task_ids: string[];
  user_focus: string;
}

export interface SkillIterationCandidate {
  schema_version: "1.0";
  iteration_id: string;
  status: "candidate";
  created_at: string;
  target_skill: string;
  source_digest: string;
  model_id: string;
  history_task_ids: string[];
  history_message_count: number;
  summary: string;
  signals: SkillIterationSignal[];
  data_processing_preferences: SkillIterationDataProcessingPreference[];
  proposed_skill_markdown: string;
  warnings: string[];
}

function schemaVersion(value: unknown, path: string): "1.0" {
  if (value !== "1.0") throw new APIError(502, "Expected 1.0 at " + path);
  return "1.0";
}

function stringArray(value: unknown, path: string): string[] {
  return assertArray(value, path, (item, index) =>
    assertString(item, path + "[" + index + "]", true));
}

function parseTarget(value: unknown, path: string): SkillIterationTarget {
  const object = assertObject(value, path);
  return {
    name: assertString(Reflect.get(object, "name"), path + ".name", true),
    description: assertString(Reflect.get(object, "description"), path + ".description", true),
    category: assertFinite(
      Reflect.get(object, "category"),
      path + ".category",
      ["discovery", "acquisition", "processing", "analysis"] as const,
    ),
    source_digest: assertHex64(Reflect.get(object, "source_digest"), path + ".source_digest"),
  };
}

function parseHistoryTask(value: unknown, path: string): SkillIterationHistoryTask {
  const object = assertObject(value, path);
  return {
    task_id: assertString(Reflect.get(object, "task_id"), path + ".task_id", true),
    title: assertString(Reflect.get(object, "title"), path + ".title", true),
    updated_at: assertString(Reflect.get(object, "updated_at"), path + ".updated_at", true),
    message_count: assertNonNegativeInt(Reflect.get(object, "message_count"), path + ".message_count"),
  };
}

function parseSignal(value: unknown, path: string): SkillIterationSignal {
  const object = assertObject(value, path);
  return {
    category: assertFinite(
      Reflect.get(object, "category"),
      path + ".category",
      ["interaction", "data_processing", "output", "constraint"] as const,
    ),
    requirement: assertString(Reflect.get(object, "requirement"), path + ".requirement", true),
    action: assertString(Reflect.get(object, "action"), path + ".action", true),
    confidence: assertFinite(
      Reflect.get(object, "confidence"),
      path + ".confidence",
      ["explicit", "repeated", "tentative"] as const,
    ),
    evidence_refs: stringArray(Reflect.get(object, "evidence_refs"), path + ".evidence_refs"),
  };
}

function parseDataProcessingPreference(
  value: unknown,
  path: string,
): SkillIterationDataProcessingPreference {
  const object = assertObject(value, path);
  return {
    stage: assertString(Reflect.get(object, "stage"), path + ".stage", true),
    method: assertString(Reflect.get(object, "method"), path + ".method", true),
    applies_when: assertString(
      Reflect.get(object, "applies_when"),
      path + ".applies_when",
      true,
    ),
    verification: assertString(
      Reflect.get(object, "verification"),
      path + ".verification",
      true,
    ),
    evidence_refs: stringArray(Reflect.get(object, "evidence_refs"), path + ".evidence_refs"),
  };
}

export function parseSkillIterationContext(value: unknown): SkillIterationContext {
  const object = assertObject(value, "skill iteration context");
  const defaults = assertObject(Reflect.get(object, "defaults"), "skill iteration context.defaults");
  return {
    schema_version: schemaVersion(
      Reflect.get(object, "schema_version"),
      "skill iteration context.schema_version",
    ),
    targets: assertArray(
      Reflect.get(object, "targets"),
      "skill iteration context.targets",
      (item, index) => parseTarget(item, "skill iteration context.targets[" + index + "]"),
    ),
    history_tasks: assertArray(
      Reflect.get(object, "history_tasks"),
      "skill iteration context.history_tasks",
      (item, index) => parseHistoryTask(item, "skill iteration context.history_tasks[" + index + "]"),
    ),
    defaults: {
      max_tasks: assertPositiveInt(
        Reflect.get(defaults, "max_tasks"),
        "skill iteration context.defaults.max_tasks",
      ),
      max_messages_per_task: assertPositiveInt(
        Reflect.get(defaults, "max_messages_per_task"),
        "skill iteration context.defaults.max_messages_per_task",
      ),
    },
    privacy_notice: assertString(
      Reflect.get(object, "privacy_notice"),
      "skill iteration context.privacy_notice",
      true,
    ),
  };
}

export function parseSkillIterationCandidate(value: unknown): SkillIterationCandidate {
  const object = assertObject(value, "skill iteration candidate");
  const status = Reflect.get(object, "status");
  if (status !== "candidate") {
    throw new APIError(502, "Expected candidate at skill iteration candidate.status");
  }
  return {
    schema_version: schemaVersion(
      Reflect.get(object, "schema_version"),
      "skill iteration candidate.schema_version",
    ),
    iteration_id: assertString(
      Reflect.get(object, "iteration_id"),
      "skill iteration candidate.iteration_id",
      true,
    ),
    status,
    created_at: assertString(
      Reflect.get(object, "created_at"),
      "skill iteration candidate.created_at",
      true,
    ),
    target_skill: assertString(
      Reflect.get(object, "target_skill"),
      "skill iteration candidate.target_skill",
      true,
    ),
    source_digest: assertHex64(
      Reflect.get(object, "source_digest"),
      "skill iteration candidate.source_digest",
    ),
    model_id: assertString(
      Reflect.get(object, "model_id"),
      "skill iteration candidate.model_id",
      true,
    ),
    history_task_ids: stringArray(
      Reflect.get(object, "history_task_ids"),
      "skill iteration candidate.history_task_ids",
    ),
    history_message_count: assertNonNegativeInt(
      Reflect.get(object, "history_message_count"),
      "skill iteration candidate.history_message_count",
    ),
    summary: assertString(Reflect.get(object, "summary"), "skill iteration candidate.summary", true),
    signals: assertArray(
      Reflect.get(object, "signals"),
      "skill iteration candidate.signals",
      (item, index) => parseSignal(item, "skill iteration candidate.signals[" + index + "]"),
    ),
    data_processing_preferences: assertArray(
      Reflect.get(object, "data_processing_preferences"),
      "skill iteration candidate.data_processing_preferences",
      (item, index) => parseDataProcessingPreference(
        item,
        "skill iteration candidate.data_processing_preferences[" + index + "]",
      ),
    ),
    proposed_skill_markdown: assertString(
      Reflect.get(object, "proposed_skill_markdown"),
      "skill iteration candidate.proposed_skill_markdown",
      true,
    ),
    warnings: stringArray(Reflect.get(object, "warnings"), "skill iteration candidate.warnings"),
  };
}
