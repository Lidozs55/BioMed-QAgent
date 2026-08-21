import { realpath, readFile, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type { BuildResult } from "@biomed/contracts";

export type TrustedEvidenceFactState = "present" | "missing" | "conflicting" | "receipt_only";
export type FactState = TrustedEvidenceFactState;

export interface TrustedEvidenceFact {
  state: TrustedEvidenceFactState;
  source_refs: readonly string[];
}

export interface TrustedEvidenceIdentity extends TrustedEvidenceFact {
  product_commit: string | null;
  request_id: string | null;
  task_id: string | null;
  run_id: string | null;
  missing_fields: readonly ("product_commit" | "request_id" | "task_id" | "run_id")[];
  conflicting_fields: readonly ("product_commit" | "request_id" | "task_id" | "run_id")[];
}

export interface TrustedEvidenceTerminal extends TrustedEvidenceFact {
  task_status: string | null;
  run_status: string | null;
  terminal_status: string | null;
}

export interface TrustedEvidenceSourceAsset extends TrustedEvidenceFact {
  receipt_ids: readonly string[];
  asset_ids: readonly string[];
  source_ids: readonly string[];
}

export interface TrustedEvidenceBuild extends TrustedEvidenceFact {
  build_id: string | null;
  build_ids: readonly string[];
  publication_id: string | null;
  result: BuildResult | null;
}

export interface TrustedEvidencePublication extends TrustedEvidenceFact {
  publication_id: string | null;
  publication_ids: readonly string[];
  manifest_sha256: string | null;
  authoritative: boolean;
  consistent_with_build: boolean;
}

export interface TrustedEvidenceArtifactItem {
  artifact_id: string;
  name: string | null;
  expected_sha256: string | null;
  expected_size_bytes: number | null;
  downloaded_sha256: string | null;
  downloaded_size_bytes: number | null;
  state: TrustedEvidenceFactState;
  source_refs: readonly string[];
}

export interface TrustedEvidenceArtifacts extends TrustedEvidenceFact {
  items: readonly TrustedEvidenceArtifactItem[];
  expected_count: number;
  downloaded_count: number;
  verified_count: number;
  all_verified: boolean;
}

export interface TrustedEvidenceFinalAnswer extends TrustedEvidenceFact {
  content: string | null;
  source: "snapshot_message" | "assistant_delta" | null;
  publication_referenced: boolean;
  referenced_publication_ids: readonly string[];
}

export interface TrustedEvidenceHil extends TrustedEvidenceFact {
  pending: boolean;
  blocking: boolean;
  request_ids: readonly string[];
}

export interface TrustedEvidenceSemanticProduct extends TrustedEvidenceFact {
  projected: false;
}

export interface TrustedEvidenceReproducibility extends TrustedEvidenceFact {
  product_commit_matches_target: boolean | null;
  publication_authoritative: boolean;
  all_publication_artifacts_verified: boolean;
}

export type TrustedEvidenceGapCode =
  | "identity.missing"
  | "identity.conflicting"
  | "terminal.missing"
  | "terminal.conflicting"
  | "terminal.not_completed"
  | "trusted_input.source_asset_receipt_missing"
  | "trusted_input.source_asset_receipt_conflicting"
  | "semantic_product.not_projected"
  | "build.missing"
  | "build.receipt_only"
  | "build.conflicting"
  | "build.malformed"
  | "publication.missing"
  | "publication.receipt_only"
  | "publication.conflicting"
  | "publication.build_result_mismatch"
  | "artifact.receipts_missing"
  | "artifact.download_verification_missing"
  | "artifact.hash_mismatch"
  | "artifact.size_mismatch"
  | "artifact.conflicting"
  | "final_answer.missing"
  | "final_answer.publication_reference_missing"
  | "hil.pending"
  | "reproducibility.product_commit_missing"
  | "reproducibility.product_commit_mismatch"
  | "reproducibility.artifact_verification_missing";

export interface TrustedEvidenceGap {
  code: TrustedEvidenceGapCode;
  stage:
    | "identity"
    | "terminal"
    | "trusted_input"
    | "semantic_product"
    | "build"
    | "publication"
    | "artifact"
    | "final_answer"
    | "hil"
    | "reproducibility";
  message: string;
  source_refs: readonly string[];
}

export interface ProjectTrustedEvidenceChainInput {
  accepted: unknown;
  evidence: unknown;
  hil?: unknown;
  accepted_ref?: string;
  evidence_ref?: string;
  hil_ref?: string;
  target_product_commit?: string;
}

export interface TrustedEvidenceChainProjection {
  schema_version: "1.0";
  accepted_identity: TrustedEvidenceIdentity;
  terminal: TrustedEvidenceTerminal;
  source_assets: TrustedEvidenceSourceAsset;
  semantic_product: TrustedEvidenceSemanticProduct;
  build: TrustedEvidenceBuild;
  publication: TrustedEvidencePublication;
  artifacts: TrustedEvidenceArtifacts;
  final_answer: TrustedEvidenceFinalAnswer;
  hil: TrustedEvidenceHil;
  reproducibility: TrustedEvidenceReproducibility;
  gaps: readonly TrustedEvidenceGap[];
  evidence_refs: readonly string[];
}

export interface LoadTrustedEvidenceChainFilesInput {
  evidence_root: string;
  accepted_ref: string;
  evidence_ref: string;
  hil_ref?: string;
  target_product_commit?: string;
}

interface JsonObject {
  [key: string]: unknown;
}

interface Candidate {
  value: string;
  ref: string;
}

interface IdentityCandidates {
  product_commit: Candidate[];
  request_id: Candidate[];
  task_id: Candidate[];
  run_id: Candidate[];
}

interface SelectedIdentity {
  values: Record<keyof IdentityCandidates, string | null>;
  conflicts: Set<keyof IdentityCandidates>;
  refs: string[];
}

interface EventRecord {
  value: JsonObject;
  ref: string;
  sequence: number;
  task_id: string | null;
  run_id: string | null;
  payload: JsonObject;
}

interface ParsedBuildCandidate {
  build_id: string | null;
  task_id: string | null;
  run_id: string | null;
  result: BuildResult | null;
  ref: string;
}

interface PublicationCandidate {
  publication_id: string;
  manifest_sha256: string | null;
  run_id: string | null;
  task_id: string | null;
  authoritative: boolean;
  ref: string;
}

interface ArtifactCandidate {
  artifact_id: string;
  name: string | null;
  sha256: string | null;
  size_bytes: number | null;
  produced: boolean;
  downloaded: boolean;
  ref: string;
}

const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MAX_ARRAY_LENGTH = 20_000;
const MAX_OBJECT_KEYS = 512;
const MAX_TEXT_LENGTH = 65_536;
const MAX_JSON_NODES = 300_000;
const MAX_DEPTH = 12;
const SHA256 = /^[0-9a-f]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const EVENT_TYPES = new Set([
  "assistant_delta",
  "artifact_produced",
  "publication_created",
  "run_completed",
  "run_failed",
  "run_cancelled",
  "run_interrupted",
  "run_queued",
  "run_started",
  "run_finalizing",
  "user_input_required",
  "user_input_resumed",
  "task_completed",
  "task_failed",
  "task_cancelled",
]);

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_TEXT_LENGTH ? value : null;
}

function id(value: unknown): string | null {
  const valueText = text(value);
  return valueText !== null && SAFE_ID.test(valueText) ? valueText : null;
}

function sha(value: unknown): string | null {
  return typeof value === "string" && SHA256.test(value) ? value : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function object(value: unknown): JsonObject {
  return isObject(value) ? value : {};
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function ensureBoundedJson(value: unknown, path: string, seen: Set<object> = new Set(), depth = 0, counter = { value: 0 }): void {
  if (depth > MAX_DEPTH) throw new TypeError(`${path} exceeds maximum JSON depth`);
  counter.value += 1;
  if (counter.value > MAX_JSON_NODES) throw new TypeError(`${path} exceeds maximum JSON nodes`);
  if (typeof value === "string") {
    if (value.length > MAX_TEXT_LENGTH) throw new TypeError(`${path} exceeds maximum text length`);
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (seen.has(value)) throw new TypeError(`${path} contains a cyclic JSON value`);
  seen.add(value);
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY_LENGTH) throw new TypeError(`${path} exceeds maximum bounded array length`);
    value.forEach((entry, index) => ensureBoundedJson(entry, `${path}[${index}]`, seen, depth + 1, counter));
  } else {
    const objectValue = value as JsonObject;
    const keys = Object.keys(objectValue);
    if (keys.length > MAX_OBJECT_KEYS) throw new TypeError(`${path} exceeds maximum object field count`);
    for (const key of keys) ensureBoundedJson(objectValue[key], `${path}.${key}`, seen, depth + 1, counter);
  }
  seen.delete(value);
}

function safeReference(value: string, label: string): string {
  if (
    value.length === 0 ||
    value.length > 512 ||
    value.includes("\u0000") ||
    isAbsolute(value) ||
    value.includes("\\") ||
    value.split("/").includes("..")
  ) {
    throw new TypeError(`${label} escapes evidence root`);
  }
  return value;
}

function addCandidate(
  candidates: IdentityCandidates,
  field: keyof IdentityCandidates,
  value: unknown,
  ref: string,
): void {
  const valueText = field === "product_commit" ? sha(value) ?? text(value) : id(value) ?? text(value);
  if (valueText !== null) candidates[field].push({ value: valueText, ref });
}

function collectIdentityFromObject(
  candidates: IdentityCandidates,
  value: unknown,
  ref: string,
  includeNestedIdentity: boolean,
): void {
  const source = object(value);
  for (const field of ["product_commit", "request_id", "task_id", "run_id"] as const) {
    addCandidate(candidates, field, source[field], ref);
  }
  if (includeNestedIdentity && isObject(source.identity)) {
    collectIdentityFromObject(candidates, source.identity, `${ref}.identity`, false);
  }
}

function identityCandidates(): IdentityCandidates {
  return { product_commit: [], request_id: [], task_id: [], run_id: [] };
}

function selectIdentity(candidates: IdentityCandidates): SelectedIdentity {
  const values = {} as Record<keyof IdentityCandidates, string | null>;
  const conflicts = new Set<keyof IdentityCandidates>();
  const refs: string[] = [];
  for (const field of ["product_commit", "request_id", "task_id", "run_id"] as const) {
    const entries = candidates[field].slice().sort((left, right) => left.value.localeCompare(right.value) || left.ref.localeCompare(right.ref));
    const distinct = sortedUnique(entries.map((entry) => entry.value));
    values[field] = distinct[0] ?? null;
    refs.push(...entries.map((entry) => entry.ref));
    if (distinct.length > 1) conflicts.add(field);
  }
  return { values, conflicts, refs: sortedUnique(refs) };
}

function mergeIdentityCandidates(...sources: IdentityCandidates[]): IdentityCandidates {
  const merged = identityCandidates();
  for (const source of sources) {
    for (const field of ["product_commit", "request_id", "task_id", "run_id"] as const) {
      merged[field].push(...source[field]);
    }
  }
  return merged;
}

function eventSequence(value: JsonObject, fallback: number): number {
  const sequence = nonNegativeInteger(value.sequence);
  return sequence ?? fallback;
}

function parseEvents(evidence: JsonObject, evidenceRef: string): EventRecord[] {
  const values = array(evidence.events);
  if (values.length === 0) return [];
  return values.flatMap((entry, index) => {
    const value = object(entry);
    const type = text(value.type) ?? text(object(value.payload).type);
    if (type === null || !EVENT_TYPES.has(type)) return [];
    const payload = object(value.payload);
    return [{
      value,
      ref: `${evidenceRef}.events#${eventSequence(value, index)}`,
      sequence: eventSequence(value, index),
      task_id: id(value.task_id),
      run_id: id(value.run_id),
      payload,
    }];
  }).sort((left, right) => left.sequence - right.sequence || left.ref.localeCompare(right.ref));
}

function eventMatches(
  event: EventRecord,
  selected: SelectedIdentity,
): { selected: boolean; identity_conflict: boolean } {
  const expectedTask = selected.values.task_id;
  const expectedRun = selected.values.run_id;
  const payloadTask = id(event.payload.task_id);
  const payloadRun = id(event.payload.run_id);
  const taskMismatch = expectedTask !== null && event.task_id !== null && event.task_id !== expectedTask;
  const runMismatch = expectedRun !== null && event.run_id !== null && event.run_id !== expectedRun;
  if (taskMismatch && (expectedRun === null || event.run_id !== expectedRun)) return { selected: false, identity_conflict: false };
  if (runMismatch) return { selected: false, identity_conflict: false };
  if (expectedTask !== null && payloadTask !== null && payloadTask !== expectedTask) {
    if (expectedRun === null || event.run_id === expectedRun) return { selected: true, identity_conflict: true };
    return { selected: false, identity_conflict: false };
  }
  if (expectedRun !== null && payloadRun !== null && payloadRun !== expectedRun) {
    return { selected: true, identity_conflict: true };
  }
  return { selected: true, identity_conflict: taskMismatch };
}

function eventType(event: EventRecord): string | null {
  return text(event.payload.type) ?? text(event.value.type);
}

function selectedEvents(
  events: readonly EventRecord[],
  selected: SelectedIdentity,
): { events: EventRecord[]; identityConflictRefs: string[] } {
  const matching: EventRecord[] = [];
  const identityConflictRefs: string[] = [];
  for (const event of events) {
    const match = eventMatches(event, selected);
    if (!match.selected) continue;
    matching.push(event);
    if (match.identity_conflict) identityConflictRefs.push(event.ref);
  }
  return { events: matching, identityConflictRefs: sortedUnique(identityConflictRefs) };
}

function statusForEvent(event: EventRecord): { task: string | null; run: string | null } {
  switch (eventType(event)) {
    case "run_queued": return { task: null, run: "queued" };
    case "run_started": return { task: null, run: "running" };
    case "run_finalizing": return { task: null, run: "finalizing" };
    case "user_input_required": return { task: null, run: "awaiting_user_input" };
    case "user_input_resumed": return { task: null, run: "running" };
    case "run_completed": return { task: null, run: "completed" };
    case "run_failed": return { task: null, run: "failed" };
    case "run_cancelled": return { task: null, run: "cancelled" };
    case "run_interrupted": return { task: null, run: "interrupted" };
    case "task_completed": return { task: "completed", run: null };
    case "task_failed": return { task: "failed", run: null };
    case "task_cancelled": return { task: "cancelled", run: null };
    default: return { task: null, run: null };
  }
}

function distinctStatuses(values: readonly string[]): string[] {
  return sortedUnique(values.filter((value) => value.length > 0));
}

function factState(values: readonly string[], conflict: boolean): TrustedEvidenceFactState {
  if (conflict) return "conflicting";
  return values.length > 0 ? "present" : "missing";
}

function projectTerminal(
  evidence: JsonObject,
  evidenceRef: string,
  selected: SelectedIdentity,
  matchingEvents: readonly EventRecord[],
  eventIdentityConflictRefs: readonly string[],
): TrustedEvidenceTerminal {
  const taskStatuses: { value: string; ref: string }[] = [];
  const runStatuses: { value: string; ref: string }[] = [];
  const terminalStatuses: { value: string; ref: string }[] = [];
  const snapshot = object(evidence.snapshot);
  const snapshotTask = object(snapshot.task);
  const terminal = object(evidence.terminal);
  const terminalTask = object(terminal.task);
  const terminalRun = object(terminal.run);
  const addStatus = (target: { value: string; ref: string }[], value: unknown, ref: string): void => {
    const status = text(value);
    if (status !== null) target.push({ value: status, ref });
  };
  addStatus(taskStatuses, snapshotTask.status, `${evidenceRef}.snapshot.task.status`);
  addStatus(taskStatuses, terminalTask.status, `${evidenceRef}.terminal.task.status`);
  addStatus(runStatuses, object(array(snapshot.runs).find((entry) => id(object(entry).run_id) === selected.values.run_id)).status, `${evidenceRef}.snapshot.runs`);
  addStatus(runStatuses, terminalRun.status, `${evidenceRef}.terminal.run.status`);
  addStatus(terminalStatuses, terminal.status, `${evidenceRef}.terminal.status`);
  for (const event of matchingEvents) {
    const statuses = statusForEvent(event);
    if (statuses.task !== null) taskStatuses.push({ value: statuses.task, ref: event.ref });
    if (statuses.run !== null) {
      runStatuses.push({ value: statuses.run, ref: event.ref });
      if (["run_completed", "run_failed", "run_cancelled", "run_interrupted"].includes(eventType(event) ?? "")) {
        terminalStatuses.push({ value: statuses.run, ref: event.ref });
      }
    }
  }
  const taskValues = distinctStatuses(taskStatuses.map((entry) => entry.value));
  const runValues = distinctStatuses(runStatuses.map((entry) => entry.value));
  const terminalValues = distinctStatuses(terminalStatuses.map((entry) => entry.value));
  const conflict = eventIdentityConflictRefs.length > 0 || taskValues.length > 1 || terminalValues.length > 1;
  const refs = sortedUnique([
    ...taskStatuses.map((entry) => entry.ref),
    ...runStatuses.map((entry) => entry.ref),
    ...terminalStatuses.map((entry) => entry.ref),
  ]);
  const taskStatus = taskValues[0] ?? null;
  const runStatus = runValues[0] ?? null;
  const terminalStatus = terminalValues[0] ?? (runStatus === "completed" || taskStatus === "completed" ? "completed" : null);
  return {
    state: factState([...taskValues, ...runValues, ...terminalValues], conflict),
    source_refs: refs.length > 0 ? refs : [evidenceRef],
    task_status: taskStatus,
    run_status: runStatus,
    terminal_status: terminalStatus,
  };
}

function parseBuildResult(value: unknown): BuildResult | null {
  const source = object(value);
  const status = source.status;
  if (status !== "succeeded" && status !== "partial_success" && status !== "no_data" && status !== "spec_rejected") return null;
  const validRowCount = nonNegativeInteger(source.valid_row_count);
  const successfulSources = array(source.successful_sources).map(text);
  const rejectedSources = array(source.rejected_sources).map(text);
  const roles = array(source.available_artifact_roles).map(text);
  const reasonCodes = array(source.reason_codes).map(text);
  if (
    validRowCount === null || successfulSources.some((entry) => entry === null) ||
    rejectedSources.some((entry) => entry === null) || roles.some((entry) => entry === null) ||
    reasonCodes.some((entry) => entry === null) || text(source.user_summary) === null ||
    text(source.recommended_next_action) === null ||
    (source.publication_id !== null && id(source.publication_id) === null)
  ) return null;
  const result: BuildResult = {
    schema_version: source.schema_version === "1.0" ? "1.0" : undefined,
    status,
    valid_row_count: validRowCount,
    successful_sources: successfulSources as string[],
    rejected_sources: rejectedSources as string[],
    available_artifact_roles: roles as string[],
    publication_id: source.publication_id === null ? null : id(source.publication_id),
    reason_codes: reasonCodes as string[],
    user_summary: text(source.user_summary) ?? "",
    recommended_next_action: text(source.recommended_next_action) ?? "",
  };
  const buildId = source.build_id === null || source.build_id === undefined ? null : id(source.build_id);
  if (source.build_id !== undefined && source.build_id !== null && buildId === null) return null;
  result.build_id = buildId;
  if (Array.isArray(source.binding_failures)) {
    const failures = source.binding_failures.flatMap((entry) => {
      const failure = object(entry);
      const bindingId = id(failure.binding_id);
      const reasonCode = text(failure.reason_code);
      const message = text(failure.message);
      return bindingId !== null && reasonCode !== null && message !== null
        ? [{ schema_version: failure.schema_version === "1.0" ? "1.0" as const : undefined, binding_id: bindingId, reason_code: reasonCode, message }]
        : [];
    });
    if (failures.length !== source.binding_failures.length) return null;
    result.binding_failures = failures;
  }
  return result;
}

function buildResultAt(value: unknown): BuildResult | null {
  if (!isObject(value)) return null;
  for (const key of ["build_result", "result", "terminal_result"] as const) {
    const candidate = parseBuildResult(value[key]);
    if (candidate !== null) return candidate;
  }
  return parseBuildResult(value);
}

function candidateIdentityMatches(
  candidate: ParsedBuildCandidate,
  selected: SelectedIdentity,
  knownBuildIds: ReadonlySet<string>,
  taskBuildContext: boolean,
): boolean {
  if (candidate.task_id !== null && selected.values.task_id !== null && candidate.task_id !== selected.values.task_id) return false;
  if (candidate.run_id !== null && selected.values.run_id !== null && candidate.run_id !== selected.values.run_id) return false;
  if (candidate.task_id !== null || candidate.run_id !== null || taskBuildContext) return true;
  return candidate.build_id !== null && knownBuildIds.has(candidate.build_id);
}

function collectBuildCandidates(
  evidence: JsonObject,
  evidenceRef: string,
  selected: SelectedIdentity,
  matchingEvents: readonly EventRecord[],
): { candidates: ParsedBuildCandidate[]; malformedRefs: string[] } {
  const candidates: ParsedBuildCandidate[] = [];
  const malformedRefs: string[] = [];
  const knownBuildIds = new Set<string>();
  const add = (candidate: ParsedBuildCandidate, taskBuildContext = false): void => {
    if (candidate.build_id !== null) knownBuildIds.add(candidate.build_id);
    if (candidate.result?.build_id !== null && candidate.result?.build_id !== undefined) knownBuildIds.add(candidate.result.build_id);
    if (candidateIdentityMatches(candidate, selected, knownBuildIds, taskBuildContext)) candidates.push(candidate);
  };
  for (const event of matchingEvents) {
    const type = eventType(event);
    if (type !== "run_completed" && type !== "task_completed") continue;
    const payload = event.payload;
    const resultValue = payload.build_result;
    if (resultValue === null || resultValue === undefined) continue;
    const result = parseBuildResult(resultValue);
    const buildId = id(event.value.build_id) ?? id(payload.build_id) ?? (result?.build_id ?? null);
    if (result === null) malformedRefs.push(event.ref);
    add({ build_id: buildId, task_id: event.task_id, run_id: event.run_id, result, ref: event.ref });
  }
  const snapshot = object(evidence.snapshot);
  const snapshotRun = array(snapshot.runs).map(object).find((run) => id(run.run_id) === selected.values.run_id);
  if (snapshotRun !== undefined) {
    const resultValue = object(object(snapshotRun.summary).build_result);
    if (Object.keys(resultValue).length > 0) {
      const result = parseBuildResult(resultValue);
      if (result === null) malformedRefs.push(`${evidenceRef}.snapshot.runs`);
      add({ build_id: result?.build_id ?? null, task_id: id(snapshotRun.task_id), run_id: id(snapshotRun.run_id), result, ref: `${evidenceRef}.snapshot.runs` });
    }
  }
  const terminalRun = object(object(evidence.terminal).run);
  const terminalSummary = object(terminalRun.summary);
  const terminalBuildValue = terminalSummary.build_result;
  const terminalResult = parseBuildResult(terminalBuildValue);
  if (terminalResult !== null) {
    add({ build_id: terminalResult.build_id ?? null, task_id: id(terminalRun.task_id), run_id: id(terminalRun.run_id), result: terminalResult, ref: `${evidenceRef}.terminal.run.summary` });
  } else if (terminalBuildValue !== undefined && terminalBuildValue !== null) {
    malformedRefs.push(`${evidenceRef}.terminal.run.summary.build_result`);
  }
  for (const key of ["task_builds", "builds"] as const) {
    const taskContext = key === "task_builds";
    const value = evidence[key];
    const entries = Array.isArray(value)
      ? value
      : isObject(value) ? Object.values(value) : [];
    for (const [index, entryValue] of entries.entries()) {
      const entry = object(entryValue);
      const result = buildResultAt(entry);
      const buildId = id(entry.build_id) ?? id(entry.id) ?? (result?.build_id ?? null);
      if (result === null && buildId === null) continue;
      if (result === null && Object.keys(entry).some((keyName) => ["build_result", "result", "terminal_result"].includes(keyName))) {
        malformedRefs.push(`${evidenceRef}.${key}[${index}]`);
      }
      add({ build_id: buildId, task_id: id(entry.task_id) ?? id(object(entry.detail).task_id), run_id: id(entry.run_id) ?? id(object(entry.detail).run_id), result, ref: `${evidenceRef}.${key}[${index}]` }, taskContext);
    }
  }
  return { candidates, malformedRefs: sortedUnique(malformedRefs) };
}

function projectBuild(
  evidence: JsonObject,
  evidenceRef: string,
  selected: SelectedIdentity,
  matchingEvents: readonly EventRecord[],
): { fact: TrustedEvidenceBuild; malformedRefs: string[] } {
  const collected = collectBuildCandidates(evidence, evidenceRef, selected, matchingEvents);
  const candidates = collected.candidates;
  const buildIds = sortedUnique(candidates.flatMap((candidate) => candidate.build_id === null ? [] : [candidate.build_id]));
  const results = candidates.filter((candidate): candidate is ParsedBuildCandidate & { result: BuildResult } => candidate.result !== null);
  const resultKeys = sortedUnique(results.map((candidate) => stableStringify(candidate.result)));
  const refs = sortedUnique(candidates.map((candidate) => candidate.ref));
  const conflict = collected.malformedRefs.length > 0 || resultKeys.length > 1;
  const result = results[0]?.result ?? null;
  const publicationIds = sortedUnique(results.flatMap((candidate) => candidate.result.publication_id === null ? [] : [candidate.result.publication_id]));
  if (candidates.length === 0) {
    return { fact: { state: "missing", source_refs: [], build_id: null, build_ids: [], publication_id: null, result: null }, malformedRefs: collected.malformedRefs };
  }
  if (conflict) {
    return { fact: { state: "conflicting", source_refs: sortedUnique([...refs, ...collected.malformedRefs]), build_id: buildIds[0] ?? null, build_ids: buildIds, publication_id: publicationIds[0] ?? null, result }, malformedRefs: collected.malformedRefs };
  }
  if (result === null) {
    return { fact: { state: "receipt_only", source_refs: refs, build_id: buildIds[0] ?? null, build_ids: buildIds, publication_id: null, result: null }, malformedRefs: collected.malformedRefs };
  }
  return { fact: { state: "present", source_refs: refs, build_id: result.build_id ?? buildIds[0] ?? null, build_ids: buildIds, publication_id: result.publication_id, result }, malformedRefs: collected.malformedRefs };
}

function collectPublicationCandidates(
  evidence: JsonObject,
  evidenceRef: string,
  selected: SelectedIdentity,
  matchingEvents: readonly EventRecord[],
  build: TrustedEvidenceBuild,
): PublicationCandidate[] {
  const candidates: PublicationCandidate[] = [];
  const add = (candidate: PublicationCandidate): void => {
    if (selected.values.task_id !== null && candidate.task_id !== null && candidate.task_id !== selected.values.task_id) return;
    if (selected.values.run_id !== null && candidate.run_id !== null && candidate.run_id !== selected.values.run_id) return;
    candidates.push(candidate);
  };
  for (const event of matchingEvents) {
    if (eventType(event) !== "publication_created") continue;
    const payload = event.payload;
    const publicationId = id(payload.publication_id);
    if (publicationId === null) continue;
    add({
      publication_id: publicationId,
      manifest_sha256: sha(payload.manifest_sha256),
      run_id: id(payload.run_id) ?? event.run_id,
      task_id: event.task_id,
      authoritative: true,
      ref: event.ref,
    });
  }
  const snapshot = object(evidence.snapshot);
  const snapshotPublications = Array.isArray(snapshot.publications) ? snapshot.publications : [];
  for (const [index, value] of snapshotPublications.entries()) {
    const publication = object(value);
    const publicationId = id(publication.publication_id);
    if (publicationId === null) continue;
    add({ publication_id: publicationId, manifest_sha256: sha(publication.manifest_sha256), run_id: id(publication.run_id), task_id: id(publication.task_id), authoritative: sha(publication.manifest_sha256) !== null, ref: `${evidenceRef}.snapshot.publications[${index}]` });
  }
  const terminal = object(evidence.terminal);
  for (const [key, value] of [["terminal.publications", terminal.publications], ["publications", evidence.publications]] as const) {
    for (const [index, entryValue] of array(value).entries()) {
      const publication = object(entryValue);
      const publicationId = id(publication.publication_id);
      if (publicationId === null) continue;
      add({ publication_id: publicationId, manifest_sha256: sha(publication.manifest_sha256), run_id: id(publication.run_id), task_id: id(publication.task_id), authoritative: sha(publication.manifest_sha256) !== null, ref: `${evidenceRef}.${key}[${index}]` });
    }
  }
  const terminalCurrent = id(terminal.current_publication_id);
  const snapshotCurrent = id(snapshot.current_publication_id);
  if (terminalCurrent !== null) add({ publication_id: terminalCurrent, manifest_sha256: null, run_id: null, task_id: selected.values.task_id, authoritative: false, ref: `${evidenceRef}.terminal.current_publication_id` });
  if (snapshotCurrent !== null) add({ publication_id: snapshotCurrent, manifest_sha256: null, run_id: null, task_id: selected.values.task_id, authoritative: false, ref: `${evidenceRef}.snapshot.current_publication_id` });
  if (build.publication_id !== null) add({ publication_id: build.publication_id, manifest_sha256: null, run_id: selected.values.run_id, task_id: selected.values.task_id, authoritative: false, ref: `${evidenceRef}.build_result.publication_id` });
  return candidates;
}

function projectPublication(
  evidence: JsonObject,
  evidenceRef: string,
  selected: SelectedIdentity,
  matchingEvents: readonly EventRecord[],
  build: TrustedEvidenceBuild,
): TrustedEvidencePublication {
  const candidates = collectPublicationCandidates(evidence, evidenceRef, selected, matchingEvents, build);
  const ids = sortedUnique(candidates.map((candidate) => candidate.publication_id));
  if (candidates.length === 0) {
    return { state: "missing", source_refs: [], publication_id: null, publication_ids: [], manifest_sha256: null, authoritative: false, consistent_with_build: true };
  }
  const grouped = new Map<string, PublicationCandidate[]>();
  for (const candidate of candidates) grouped.set(candidate.publication_id, [...(grouped.get(candidate.publication_id) ?? []), candidate]);
  const groupConflicts = [...grouped.entries()].flatMap(([, group]) => {
    const manifests = sortedUnique(group.flatMap((candidate) => candidate.manifest_sha256 === null ? [] : [candidate.manifest_sha256]));
    return manifests.length > 1 ? [group] : [];
  });
  const authoritative = candidates.filter((candidate) => candidate.authoritative);
  const buildPublicationId = build.publication_id;
  const consistentWithBuild = buildPublicationId === null || candidates.some((candidate) => candidate.publication_id === buildPublicationId && candidate.authoritative);
  const mismatch = buildPublicationId !== null && authoritative.length > 0 && !consistentWithBuild;
  const conflict = groupConflicts.length > 0 || mismatch;
  const selectedId = buildPublicationId ?? id(object(evidence.snapshot).current_publication_id) ?? authoritative.at(-1)?.publication_id ?? ids[0] ?? null;
  const selectedGroup = selectedId === null ? [] : grouped.get(selectedId) ?? [];
  const manifestValues = sortedUnique(selectedGroup.flatMap((candidate) => candidate.manifest_sha256 === null ? [] : [candidate.manifest_sha256]));
  const refs = sortedUnique(candidates.map((candidate) => candidate.ref));
  return {
    state: conflict ? "conflicting" : authoritative.length > 0 ? "present" : "receipt_only",
    source_refs: refs,
    publication_id: selectedId,
    publication_ids: ids,
    manifest_sha256: manifestValues[0] ?? null,
    authoritative: authoritative.length > 0,
    consistent_with_build: consistentWithBuild,
  };
}

function normalizeArtifact(value: unknown): { artifact_id: string; name: string | null; sha256: string | null; size_bytes: number | null } | null {
  const source = object(value);
  const artifactId = id(source.artifact_id) ?? id(source.id);
  if (artifactId === null) return null;
  return {
    artifact_id: artifactId,
    name: text(source.name),
    sha256: sha(source.sha256),
    size_bytes: nonNegativeInteger(source.size_bytes) ?? nonNegativeInteger(source.size),
  };
}

function artifactMatches(left: { name: string | null; sha256: string | null; size_bytes: number | null }, right: { name: string | null; sha256: string | null; size_bytes: number | null }): boolean {
  if (left.sha256 !== null && right.sha256 !== null && left.sha256 !== right.sha256) return false;
  if (left.size_bytes !== null && right.size_bytes !== null && left.size_bytes !== right.size_bytes) return false;
  if (left.name !== null && right.name !== null && left.name !== right.name) return false;
  return (left.sha256 !== null && right.sha256 !== null) || (left.size_bytes !== null && right.size_bytes !== null) || (left.name !== null && right.name !== null);
}

function projectArtifacts(
  evidence: JsonObject,
  evidenceRef: string,
  matchingEvents: readonly EventRecord[],
): TrustedEvidenceArtifacts {
  const candidates: ArtifactCandidate[] = [];
  const add = (value: unknown, ref: string, kind: "produced" | "listed" | "downloaded"): void => {
    const artifact = normalizeArtifact(value);
    if (artifact === null) return;
    candidates.push({ ...artifact, produced: kind === "produced", downloaded: kind === "downloaded", ref });
  };
  for (const event of matchingEvents) {
    if (eventType(event) === "artifact_produced") add(object(event.payload).artifact, event.ref, "produced");
  }
  const addStableCollection = (value: unknown, collection: "artifact_list" | "artifact_hashes", kind: "listed" | "downloaded"): void => {
    for (const entry of array(value)) {
      const normalized = normalizeArtifact(entry);
      if (normalized === null) continue;
      add(entry, `${evidenceRef}.${collection}.${normalized.artifact_id}`, kind);
    }
  };
  addStableCollection(evidence.artifact_list, "artifact_list", "listed");
  addStableCollection(evidence.artifact_hashes, "artifact_hashes", "downloaded");
  const groups: ArtifactCandidate[][] = [];
  for (const candidate of candidates) {
    let group = groups.find((entries) => entries.some((entry) => entry.artifact_id === candidate.artifact_id || artifactMatches(entry, candidate)));
    if (group === undefined) {
      group = [];
      groups.push(group);
    }
    group.push(candidate);
  }
  const items: TrustedEvidenceArtifactItem[] = [];
  let conflictCount = 0;
  for (const group of groups) {
    const ids = sortedUnique(group.map((entry) => entry.artifact_id));
    const primary = group.slice().sort((left, right) => left.artifact_id.localeCompare(right.artifact_id) || left.ref.localeCompare(right.ref))[0];
    const expectedEntries = group.filter((entry) => !entry.downloaded);
    const downloadedEntries = group.filter((entry) => entry.downloaded);
    const expectedShaValues = sortedUnique(expectedEntries.flatMap((entry) => entry.sha256 === null ? [] : [entry.sha256]));
    const expectedSizeValues = sortedUnique(expectedEntries.flatMap((entry) => entry.size_bytes === null ? [] : [String(entry.size_bytes)]));
    const downloadedShaValues = sortedUnique(downloadedEntries.flatMap((entry) => entry.sha256 === null ? [] : [entry.sha256]));
    const downloadedSizeValues = sortedUnique(downloadedEntries.flatMap((entry) => entry.size_bytes === null ? [] : [String(entry.size_bytes)]));
    const metadataConflict = expectedShaValues.length > 1 || expectedSizeValues.length > 1;
    const hashMismatch = expectedShaValues.length > 0 && downloadedShaValues.length > 0 && !downloadedShaValues.some((value) => expectedShaValues.includes(value));
    const sizeMismatch = expectedSizeValues.length > 0 && downloadedSizeValues.length > 0 && !downloadedSizeValues.some((value) => expectedSizeValues.includes(value));
    const downloaded = group.some((entry) => entry.downloaded && entry.sha256 !== null && entry.size_bytes !== null);
    const verified = downloaded && !metadataConflict && !hashMismatch && !sizeMismatch && expectedShaValues.length > 0 && expectedSizeValues.length > 0;
    const state: TrustedEvidenceFactState = metadataConflict || hashMismatch || sizeMismatch
      ? "conflicting"
      : verified ? "present" : "receipt_only";
    if (state === "conflicting") conflictCount += 1;
    items.push({
      artifact_id: ids[0] ?? primary.artifact_id,
      name: primary.name,
      expected_sha256: expectedShaValues[0] ?? null,
      expected_size_bytes: expectedSizeValues.length > 0 ? Number(expectedSizeValues[0]) : null,
      downloaded_sha256: downloadedShaValues[0] ?? null,
      downloaded_size_bytes: downloadedSizeValues.length > 0 ? Number(downloadedSizeValues[0]) : null,
      state,
      source_refs: sortedUnique(group.map((entry) => entry.ref)),
    });
  }
  items.sort((left, right) => left.artifact_id.localeCompare(right.artifact_id));
  const verifiedCount = items.filter((item) => item.state === "present").length;
  const downloadedCount = items.filter((item) => item.downloaded_sha256 !== null && item.downloaded_size_bytes !== null).length;
  const allVerified = items.length > 0 && verifiedCount === items.length;
  const state: TrustedEvidenceFactState = items.length === 0
    ? "missing"
    : conflictCount > 0 ? "conflicting" : allVerified ? "present" : "receipt_only";
  return { state, source_refs: sortedUnique(candidates.map((candidate) => candidate.ref)), items, expected_count: items.length, downloaded_count: downloadedCount, verified_count: verifiedCount, all_verified: allVerified };
}

function exactPublicationOccurrences(content: string, publicationIds: readonly string[]): string[] {
  return publicationIds.filter((publicationId) => {
    const escaped = publicationId.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    return new RegExp(`(^|[^A-Za-z0-9_-])${escaped}(?=$|[^A-Za-z0-9_-])`, "u").test(content);
  }).sort((left, right) => left.localeCompare(right));
}

function projectFinalAnswer(
  evidence: JsonObject,
  evidenceRef: string,
  selected: SelectedIdentity,
  publicationIds: readonly string[],
  matchingEvents: readonly EventRecord[],
): TrustedEvidenceFinalAnswer {
  const snapshot = object(evidence.snapshot);
  const messages = array(snapshot.messages).map(object)
    .filter((message) => message.role === "assistant" && id(message.run_id) === selected.values.run_id && text(message.content) !== null)
    .sort((left, right) => (nonNegativeInteger(left.ordinal) ?? 0) - (nonNegativeInteger(right.ordinal) ?? 0) || text(left.created_at)?.localeCompare(text(right.created_at) ?? "") || String(left.message_id).localeCompare(String(right.message_id)));
  let content: string | null = null;
  let source: "snapshot_message" | "assistant_delta" | null = null;
  let refs: string[] = [];
  if (messages.length > 0) {
    const message = messages[messages.length - 1];
    content = text(message.content);
    source = "snapshot_message";
    refs = [`${evidenceRef}.snapshot.messages`];
  } else {
    const deltas = matchingEvents.filter((event) => eventType(event) === "assistant_delta")
      .sort((left, right) => left.sequence - right.sequence || left.ref.localeCompare(right.ref));
    if (deltas.length > 0) {
      content = deltas.map((event) => text(event.payload.delta) ?? "").join("");
      source = "assistant_delta";
      refs = deltas.map((event) => event.ref);
    }
  }
  const referenced = content === null ? [] : exactPublicationOccurrences(content, publicationIds);
  const state: TrustedEvidenceFactState = content !== null && referenced.length > 0 ? "present" : "missing";
  return { state, source_refs: sortedUnique(refs), content, source, publication_referenced: referenced.length > 0, referenced_publication_ids: referenced };
}

function parseHilValue(value: unknown): { request_id: string | null; status: string | null; blocking: boolean | null; refDetail: string } | null {
  const source = object(value);
  const nested = isObject(source.hil_request) ? source.hil_request : source;
  const requestId = id(nested.request_id) ?? id(source.request_id);
  const status = text(nested.status) ?? text(source.status);
  const blocking = typeof nested.blocking === "boolean" ? nested.blocking : typeof source.blocking === "boolean" ? source.blocking : null;
  if (requestId === null && status === null && blocking === null) return null;
  return { request_id: requestId, status, blocking, refDetail: "hil" };
}

function projectHil(
  evidence: JsonObject,
  evidenceRef: string,
  hil: unknown,
  hilRef: string,
  matchingEvents: readonly EventRecord[],
): TrustedEvidenceHil {
  const records: { request_id: string | null; pending: boolean; blocking: boolean; ref: string }[] = [];
  const add = (value: unknown, ref: string, defaultPending = false): void => {
    const parsed = parseHilValue(value);
    if (parsed === null) return;
    records.push({ request_id: parsed.request_id, pending: parsed.status === "pending" || defaultPending, blocking: parsed.blocking ?? defaultPending, ref });
  };
  add(hil, hilRef);
  add(object(evidence.terminal).hil_request, `${evidenceRef}.terminal.hil_request`);
  for (const event of matchingEvents) {
    if (eventType(event) === "user_input_required") {
      add(event.payload.hil_request ?? event.payload.detail, event.ref, true);
    }
  }
  const requestIds = sortedUnique(records.flatMap((record) => record.request_id === null ? [] : [record.request_id]));
  const pendingBlocking = records.some((record) => record.pending && record.blocking);
  const pending = records.some((record) => record.pending);
  const conflicting = records.some((record) => record.pending && !record.blocking) && pendingBlocking;
  return {
    state: conflicting ? "conflicting" : records.length > 0 ? "present" : "missing",
    source_refs: sortedUnique(records.map((record) => record.ref)),
    pending,
    blocking: pendingBlocking,
    request_ids: requestIds,
  };
}

function collectSourceAssetReceipts(
  evidence: JsonObject,
  evidenceRef: string,
  selected: SelectedIdentity,
  matchingEvents: readonly EventRecord[],
): TrustedEvidenceSourceAsset {
  const values: { receipt: JsonObject; ref: string }[] = [];
  const addArray = (value: unknown, ref: string): void => {
    if (Array.isArray(value)) value.forEach((entry, index) => values.push({ receipt: object(entry), ref: `${ref}[${index}]` }));
    else if (isObject(value)) values.push({ receipt: value, ref });
  };
  for (const key of ["source_asset_receipts", "source_assets", "registration_receipts", "source_asset_receipt"] as const) addArray(evidence[key], `${evidenceRef}.${key}`);
  for (const event of matchingEvents) {
    const payload = event.payload;
    for (const key of ["source_asset_receipt", "registration_receipt", "source_asset"] as const) {
      if (payload[key] !== undefined) values.push({ receipt: object(payload[key]), ref: `${event.ref}.${key}` });
    }
  }
  const valid: { receiptId: string; assetId: string; sourceId: string; ref: string; key: string }[] = [];
  const invalidRefs: string[] = [];
  for (const entry of values) {
    const receipt = entry.receipt;
    const receiptId = id(receipt.receipt_id);
    const sourceId = id(receipt.source_id);
    const relativePath = text(receipt.relative_path);
    const digest = sha(receipt.sha256);
    const size = nonNegativeInteger(receipt.size_bytes);
    const receiptTask = id(receipt.task_id);
    const assetRef = object(receipt.asset_ref);
    const assetId = id(assetRef.asset_id);
    const assetTask = id(assetRef.task_id);
    const role = text(assetRef.role);
    const taskMatches = selected.values.task_id === null || (receiptTask === selected.values.task_id && assetTask === selected.values.task_id);
    if (receiptId === null || sourceId === null || relativePath === null || digest === null || size === null || assetId === null || role === null || !taskMatches) {
      if (receiptTask === selected.values.task_id || assetTask === selected.values.task_id) invalidRefs.push(entry.ref);
      continue;
    }
    valid.push({ receiptId, assetId, sourceId, ref: entry.ref, key: stableStringify({ receiptId, assetId, sourceId, digest, size, role }) });
  }
  const keys = sortedUnique(valid.map((entry) => entry.key));
  const conflict = invalidRefs.length > 0 || keys.length !== valid.length;
  return {
    state: conflict ? "conflicting" : valid.length > 0 ? "present" : "missing",
    source_refs: sortedUnique([...valid.map((entry) => entry.ref), ...invalidRefs]),
    receipt_ids: sortedUnique(valid.map((entry) => entry.receiptId)),
    asset_ids: sortedUnique(valid.map((entry) => entry.assetId)),
    source_ids: sortedUnique(valid.map((entry) => entry.sourceId)),
  };
}

function gap(
  code: TrustedEvidenceGapCode,
  stage: TrustedEvidenceGap["stage"],
  message: string,
  sourceRefs: readonly string[] = [],
): TrustedEvidenceGap {
  return { code, stage, message, source_refs: sortedUnique(sourceRefs) };
}

const GAP_STAGE_ORDER: readonly TrustedEvidenceGap["stage"][] = [
  "identity",
  "terminal",
  "trusted_input",
  "semantic_product",
  "build",
  "publication",
  "artifact",
  "final_answer",
  "hil",
  "reproducibility",
];

function compareGaps(left: TrustedEvidenceGap, right: TrustedEvidenceGap): number {
  return (GAP_STAGE_ORDER.indexOf(left.stage) - GAP_STAGE_ORDER.indexOf(right.stage)) ||
    left.code.localeCompare(right.code) ||
    left.source_refs.join("\u0000").localeCompare(right.source_refs.join("\u0000"));
}

function collectInitialIdentity(
  accepted: JsonObject,
  evidence: JsonObject,
  acceptedRef: string,
  evidenceRef: string,
): { selected: SelectedIdentity; acceptedSelected: SelectedIdentity; evidenceSelected: SelectedIdentity } {
  const acceptedCandidates = identityCandidates();
  collectIdentityFromObject(acceptedCandidates, accepted, acceptedRef, true);
  const acceptedNested = object(accepted.accepted);
  collectIdentityFromObject(acceptedCandidates, acceptedNested, `${acceptedRef}.accepted`, false);
  const evidenceCandidates = identityCandidates();
  collectIdentityFromObject(evidenceCandidates, evidence, evidenceRef, true);
  const evidenceNested = object(evidence.identity);
  collectIdentityFromObject(evidenceCandidates, evidenceNested, `${evidenceRef}.identity`, false);
  const acceptedSelected = selectIdentity(acceptedCandidates);
  const evidenceSelected = selectIdentity(evidenceCandidates);
  const preferred = identityCandidates();
  for (const field of ["product_commit", "request_id", "task_id", "run_id"] as const) {
    const source = acceptedCandidates[field].length > 0 ? acceptedCandidates[field] : evidenceCandidates[field];
    preferred[field].push(...source);
  }
  const selected = selectIdentity(mergeIdentityCandidates(preferred, evidenceCandidates));
  return { selected, acceptedSelected, evidenceSelected };
}

function enrichIdentityFromSnapshotAndEvents(
  selected: SelectedIdentity,
  evidence: JsonObject,
  evidenceRef: string,
): SelectedIdentity {
  const candidates = identityCandidates();
  for (const field of ["product_commit", "request_id", "task_id", "run_id"] as const) {
    if (selected.values[field] !== null) candidates[field].push({ value: selected.values[field] as string, ref: "selected" });
  }
  const snapshot = object(evidence.snapshot);
  const snapshotTask = object(snapshot.task);
  addCandidate(candidates, "task_id", snapshotTask.task_id, `${evidenceRef}.snapshot.task`);
  for (const runValue of array(snapshot.runs)) {
    const run = object(runValue);
    if (selected.values.run_id !== null && id(run.run_id) !== selected.values.run_id) continue;
    addCandidate(candidates, "task_id", run.task_id, `${evidenceRef}.snapshot.runs`);
    addCandidate(candidates, "run_id", run.run_id, `${evidenceRef}.snapshot.runs`);
    addCandidate(candidates, "request_id", run.request_id, `${evidenceRef}.snapshot.runs`);
  }
  const terminal = object(evidence.terminal);
  addCandidate(candidates, "task_id", object(terminal.task).task_id, `${evidenceRef}.terminal.task`);
  addCandidate(candidates, "task_id", object(terminal.run).task_id, `${evidenceRef}.terminal.run`);
  addCandidate(candidates, "run_id", object(terminal.run).run_id, `${evidenceRef}.terminal.run`);
  addCandidate(candidates, "request_id", object(terminal.run).request_id, `${evidenceRef}.terminal.run`);
  return selectIdentity(candidates);
}

function projectIdentity(input: ProjectTrustedEvidenceChainInput, accepted: JsonObject, evidence: JsonObject, acceptedRef: string, evidenceRef: string): { identity: TrustedEvidenceIdentity; selected: SelectedIdentity } {
  const initial = collectInitialIdentity(accepted, evidence, acceptedRef, evidenceRef);
  const enriched = enrichIdentityFromSnapshotAndEvents(initial.selected, evidence, evidenceRef);
  const fields = ["product_commit", "request_id", "task_id", "run_id"] as const;
  const missingFields = fields.filter((field) => enriched.values[field] === null);
  const conflictingFields = fields.filter((field) => initial.selected.conflicts.has(field) || initial.acceptedSelected.conflicts.has(field) || initial.evidenceSelected.conflicts.has(field) || enriched.conflicts.has(field));
  const refs = sortedUnique([...initial.selected.refs, ...enriched.refs.filter((ref) => ref !== "selected")]);
  const state: TrustedEvidenceFactState = conflictingFields.length > 0 ? "conflicting" : missingFields.length > 0 ? "missing" : "present";
  const identity: TrustedEvidenceIdentity = {
    state,
    source_refs: refs,
    product_commit: enriched.values.product_commit,
    request_id: enriched.values.request_id,
    task_id: enriched.values.task_id,
    run_id: enriched.values.run_id,
    missing_fields: missingFields,
    conflicting_fields: conflictingFields,
  };
  if (input.target_product_commit !== undefined && identity.product_commit !== null && identity.product_commit !== input.target_product_commit) {
    identity.source_refs = sortedUnique([...identity.source_refs, acceptedRef, evidenceRef]);
  }
  return { identity, selected: enriched };
}

function projectReproducibility(
  identity: TrustedEvidenceIdentity,
  targetProductCommit: string | undefined,
  publication: TrustedEvidencePublication,
  artifacts: TrustedEvidenceArtifacts,
  evidenceRef: string,
): TrustedEvidenceReproducibility {
  const matches = targetProductCommit === undefined
    ? null
    : identity.product_commit === null ? null : identity.product_commit === targetProductCommit;
  const conflict = identity.state === "conflicting" || publication.state === "conflicting" || artifacts.state === "conflicting" || matches === false;
  const complete = matches === true && publication.state === "present" && publication.authoritative && artifacts.all_verified;
  const state: TrustedEvidenceFactState = conflict ? "conflicting" : complete ? "present" : publication.state === "missing" || artifacts.state === "missing" ? "missing" : "receipt_only";
  return {
    state,
    source_refs: sortedUnique([...identity.source_refs, ...publication.source_refs, ...artifacts.source_refs, evidenceRef]),
    product_commit_matches_target: matches,
    publication_authoritative: publication.authoritative,
    all_publication_artifacts_verified: artifacts.all_verified,
  };
}

export function projectTrustedEvidenceChain(input: ProjectTrustedEvidenceChainInput): TrustedEvidenceChainProjection {
  ensureBoundedJson(input.accepted, "accepted");
  ensureBoundedJson(input.evidence, "evidence");
  if (input.hil !== undefined) ensureBoundedJson(input.hil, "hil");
  const acceptedRef = safeReference(input.accepted_ref ?? "accepted.json", "accepted_ref");
  const evidenceRef = safeReference(input.evidence_ref ?? "evidence.json", "evidence_ref");
  const hilRef = safeReference(input.hil_ref ?? "hil.json", "hil_ref");
  const accepted = object(input.accepted);
  const evidence = object(input.evidence);
  const identityProjection = projectIdentity(input, accepted, evidence, acceptedRef, evidenceRef);
  const events = parseEvents(evidence, evidenceRef);
  const selectedEventProjection = selectedEvents(events, identityProjection.selected);
  const terminal = projectTerminal(evidence, evidenceRef, identityProjection.selected, selectedEventProjection.events, selectedEventProjection.identityConflictRefs);
  const buildProjection = projectBuild(evidence, evidenceRef, identityProjection.selected, selectedEventProjection.events);
  const publication = projectPublication(evidence, evidenceRef, identityProjection.selected, selectedEventProjection.events, buildProjection.fact);
  const artifacts = projectArtifacts(evidence, evidenceRef, selectedEventProjection.events);
  const finalAnswer = projectFinalAnswer(evidence, evidenceRef, identityProjection.selected, publication.publication_ids, selectedEventProjection.events);
  const hil = projectHil(evidence, evidenceRef, input.hil, hilRef, selectedEventProjection.events);
  const sourceAssets = collectSourceAssetReceipts(evidence, evidenceRef, identityProjection.selected, selectedEventProjection.events);
  const semanticProduct: TrustedEvidenceSemanticProduct = { state: "missing", source_refs: [], projected: false };
  const targetProductCommit = input.target_product_commit;
  const reproducibility = projectReproducibility(identityProjection.identity, targetProductCommit, publication, artifacts, evidenceRef);
  const gaps: TrustedEvidenceGap[] = [];
  if (identityProjection.identity.state === "missing") gaps.push(gap("identity.missing", "identity", "Accepted request/task/run/product identity is incomplete", identityProjection.identity.source_refs));
  if (identityProjection.identity.state === "conflicting") gaps.push(gap("identity.conflicting", "identity", "Evidence contains conflicting request/task/run/product identity values", identityProjection.identity.source_refs));
  if (terminal.state === "missing") gaps.push(gap("terminal.missing", "terminal", "No matching terminal task/run fact was found", terminal.source_refs));
  if (terminal.state === "conflicting") gaps.push(gap("terminal.conflicting", "terminal", "Matching task/run terminal facts conflict", terminal.source_refs));
  if (terminal.task_status !== "completed" || terminal.run_status !== "completed") gaps.push(gap("terminal.not_completed", "terminal", "Matching task and run are not both completed", terminal.source_refs));
  if (sourceAssets.state === "missing") gaps.push(gap("trusted_input.source_asset_receipt_missing", "trusted_input", "No matching role-aware SourceAsset registration receipt was observed", [evidenceRef]));
  if (sourceAssets.state === "conflicting") gaps.push(gap("trusted_input.source_asset_receipt_conflicting", "trusted_input", "SourceAsset registration receipts conflict or fail identity closure", sourceAssets.source_refs));
  gaps.push(gap("semantic_product.not_projected", "semantic_product", "Legacy evidence does not durably project semantic tables, relations, or product assessment", semanticProduct.source_refs));
  if (buildProjection.fact.state === "missing") gaps.push(gap("build.missing", "build", "No matching BuildResult or build receipt was found", buildProjection.fact.source_refs));
  if (buildProjection.fact.state === "receipt_only") gaps.push(gap("build.receipt_only", "build", "Only a build or operation identifier was observed; BuildResult is absent", buildProjection.fact.source_refs));
  if (buildProjection.fact.state === "conflicting") gaps.push(gap("build.conflicting", "build", "Matching BuildResult receipts conflict", buildProjection.fact.source_refs));
  if (buildProjection.malformedRefs.length > 0) gaps.push(gap("build.malformed", "build", "A matching build result was malformed and was not trusted", buildProjection.malformedRefs));
  if (publication.state === "missing") gaps.push(gap("publication.missing", "publication", "No publication identifier or receipt matched the selected run", publication.source_refs));
  if (publication.state === "receipt_only") gaps.push(gap("publication.receipt_only", "publication", "Publication identifier exists without an authoritative publication receipt", publication.source_refs));
  if (publication.state === "conflicting") gaps.push(gap("publication.conflicting", "publication", "Publication receipts or manifest hashes conflict", publication.source_refs));
  if (!publication.consistent_with_build) gaps.push(gap("publication.build_result_mismatch", "publication", "BuildResult.publication_id does not match an authoritative publication receipt", publication.source_refs));
  if (artifacts.items.length === 0) gaps.push(gap("artifact.receipts_missing", "artifact", "No artifact production or artifact API receipt was observed", [evidenceRef]));
  if (artifacts.state === "conflicting") {
    gaps.push(gap("artifact.conflicting", "artifact", "Artifact production/list/download receipts conflict", artifacts.source_refs));
    if (artifacts.items.some((item) => item.expected_sha256 !== null && item.downloaded_sha256 !== null && item.expected_sha256 !== item.downloaded_sha256)) gaps.push(gap("artifact.hash_mismatch", "artifact", "Downloaded artifact SHA-256 does not match the expected receipt", artifacts.source_refs));
    if (artifacts.items.some((item) => item.expected_size_bytes !== null && item.downloaded_size_bytes !== null && item.expected_size_bytes !== item.downloaded_size_bytes)) gaps.push(gap("artifact.size_mismatch", "artifact", "Downloaded artifact size does not match the expected receipt", artifacts.source_refs));
  }
  if (artifacts.items.length > 0 && !artifacts.all_verified && artifacts.state !== "conflicting") gaps.push(gap("artifact.download_verification_missing", "artifact", "Not every publication artifact has a verified downloaded hash and size", artifacts.source_refs));
  if (finalAnswer.content === null) gaps.push(gap("final_answer.missing", "final_answer", "No assistant final answer was durably captured for the selected run", finalAnswer.source_refs));
  else if (!finalAnswer.publication_referenced) gaps.push(gap("final_answer.publication_reference_missing", "final_answer", "Final answer does not contain an exact selected publication ID occurrence", finalAnswer.source_refs));
  if (hil.pending && hil.blocking) gaps.push(gap("hil.pending", "hil", "A blocking human-in-the-loop request remains pending", hil.source_refs));
  if (targetProductCommit !== undefined && identityProjection.identity.product_commit === null) gaps.push(gap("reproducibility.product_commit_missing", "reproducibility", "Evidence does not identify a product commit", identityProjection.identity.source_refs));
  else if (targetProductCommit !== undefined && reproducibility.product_commit_matches_target === false) gaps.push(gap("reproducibility.product_commit_mismatch", "reproducibility", "Evidence product commit does not match the evaluator target commit", identityProjection.identity.source_refs));
  if (publication.state === "present" && !artifacts.all_verified) gaps.push(gap("reproducibility.artifact_verification_missing", "reproducibility", "Publication exists but all artifact downloads are not hash/size verified", artifacts.source_refs));
  const evidenceRefs = sortedUnique([
    acceptedRef,
    evidenceRef,
    ...(input.hil === undefined ? [] : [hilRef]),
    ...identityProjection.identity.source_refs,
    ...terminal.source_refs,
    ...buildProjection.fact.source_refs,
    ...publication.source_refs,
    ...artifacts.source_refs,
    ...finalAnswer.source_refs,
    ...hil.source_refs,
    ...sourceAssets.source_refs,
  ]);
  return {
    schema_version: "1.0",
    accepted_identity: identityProjection.identity,
    terminal,
    source_assets: sourceAssets,
    semantic_product: semanticProduct,
    build: buildProjection.fact,
    publication,
    artifacts,
    final_answer: finalAnswer,
    hil,
    reproducibility,
    gaps: gaps.sort(compareGaps),
    evidence_refs: evidenceRefs,
  };
}

async function confinedFile(root: string, reference: string): Promise<string> {
  const safe = safeReference(reference, "evidence reference");
  const rootPath = await realpath(root);
  const candidate = resolve(rootPath, safe);
  const resolved = await realpath(candidate);
  const suffix = relative(rootPath, resolved);
  if (suffix === "" || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) throw new TypeError("path escapes evidence root");
  return resolved;
}

async function readBoundedJson(root: string, reference: string, optional: boolean): Promise<unknown> {
  let filePath: string;
  try {
    filePath = await confinedFile(root, reference);
  } catch (error) {
    if (optional && isObject(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
  const fileStat = await stat(filePath);
  if (!fileStat.isFile() || fileStat.size > MAX_JSON_BYTES) throw new TypeError(`${reference} exceeds bounded JSON file limit`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    throw new TypeError(`${reference} is not valid JSON`);
  }
  ensureBoundedJson(parsed, reference);
  return parsed;
}

export async function loadTrustedEvidenceChainFiles(
  input: LoadTrustedEvidenceChainFilesInput,
): Promise<TrustedEvidenceChainProjection> {
  const accepted = await readBoundedJson(input.evidence_root, input.accepted_ref, false);
  const evidence = await readBoundedJson(input.evidence_root, input.evidence_ref, false);
  const hil = input.hil_ref === undefined ? undefined : await readBoundedJson(input.evidence_root, input.hil_ref, true);
  return projectTrustedEvidenceChain({
    accepted,
    evidence,
    hil,
    accepted_ref: input.accepted_ref,
    evidence_ref: input.evidence_ref,
    hil_ref: input.hil_ref,
    target_product_commit: input.target_product_commit,
  });
}

export const loadTrustedEvidenceChain = loadTrustedEvidenceChainFiles;
export const projectTrustedEvidenceChainFromBundle = projectTrustedEvidenceChain;
