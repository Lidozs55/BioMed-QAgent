import type { SourceLocatorV2 } from "@biomed/contracts";
import { parseSourceLocator } from "../../contracts/index.js";
import { isTargetEvidenceSourceDatabase } from "./schemas.js";

const CONTENT_ADDRESSED_ASSET = /^asset_[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;

export interface TargetEvidenceSourceRecord {
  source_id: string;
  source_database: string;
  source_asset_id: string;
  source_locator: SourceLocatorV2;
  retrieved_at: string;
  carrier_type: string;
}

export interface TargetEvidenceEvidenceRecord {
  evidence_id: string;
  target_id: string;
  target_namespace: string;
  evidence_type: string;
  assertion: string;
  evidence_value?: unknown;
  source_id: string;
  source_locator: SourceLocatorV2;
}

export interface TargetEvidenceSupportingRecord {
  supporting_id: string;
  evidence_id: string;
  supporting_type: string;
  supporting_value: unknown;
  source_id: string;
}

export interface TargetEvidenceRows {
  targets: readonly Record<string, unknown>[];
  evidence: readonly TargetEvidenceEvidenceRecord[];
  sources: readonly TargetEvidenceSourceRecord[];
  supporting: readonly TargetEvidenceSupportingRecord[];
}

function fail(message: string): never {
  throw new TypeError(`target evidence rejected: ${message}`);
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") fail(`${name} is required`);
  return value;
}

function safeId(value: unknown, name: string): string {
  const result = text(value, name);
  if (!SAFE_ID.test(result) || result.includes("..")) fail(`${name} is not a safe identifier`);
  return result;
}

function assertLocator(value: unknown, name: string): asserts value is SourceLocatorV2 {
  let locator: ReturnType<typeof parseSourceLocator>;
  try {
    locator = parseSourceLocator(value);
  } catch (error) {
    fail(`${name} is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!("locator_version" in locator) || locator.locator_version !== "2.0") {
    fail(`${name} must use SourceLocator 2.0`);
  }
  if (!CONTENT_ADDRESSED_ASSET.test(locator.asset_id)) {
    fail(`${name}.asset_id must be content addressed`);
  }
}

function assertSource(value: TargetEvidenceSourceRecord): void {
  safeId(value.source_id, "source_id");
  if (!isTargetEvidenceSourceDatabase(value.source_database)) {
    fail(`source_database '${value.source_database}' is not allowed for target evidence`);
  }
  if (!CONTENT_ADDRESSED_ASSET.test(value.source_asset_id)) fail("source_asset_id must be content addressed");
  assertLocator(value.source_locator, "source_locator");
  if (value.source_locator.asset_id !== value.source_asset_id) fail("source locator asset does not match source_asset_id");
  if (Number.isNaN(Date.parse(text(value.retrieved_at, "retrieved_at")))) fail("retrieved_at must be an ISO datetime");
  text(value.carrier_type, "carrier_type");
}

function assertEvidence(value: TargetEvidenceEvidenceRecord, sources: ReadonlyMap<string, TargetEvidenceSourceRecord>): void {
  safeId(value.evidence_id, "evidence_id");
  safeId(value.target_id, "target_id");
  text(value.target_namespace, "target_namespace");
  text(value.evidence_type, "evidence_type");
  text(value.assertion, "assertion");
  if (value.evidence_value === undefined) fail(`evidence ${value.evidence_id} is missing evidence_value`);
  safeId(value.source_id, "source_id");
  const source = sources.get(value.source_id);
  if (source === undefined) fail(`evidence ${value.evidence_id} references missing source_id`);
  assertLocator(value.source_locator, "source_locator");
  if (value.source_locator.asset_id !== source.source_asset_id) fail(`evidence ${value.evidence_id} locator does not match its source asset`);
}

export function assertTargetEvidenceRows(rows: TargetEvidenceRows): void {
  if (rows.targets.length === 0) fail("primary target table must not be empty");
  if (rows.evidence.length === 0) fail("evidence table must not be empty");
  if (rows.sources.length === 0) fail("source table must not be empty");
  const sourceMap = new Map<string, TargetEvidenceSourceRecord>();
  for (const source of rows.sources) {
    assertSource(source);
    if (sourceMap.has(source.source_id)) fail(`duplicate source_id ${source.source_id}`);
    sourceMap.set(source.source_id, source);
  }
  const targetKeys = new Set(rows.targets.map((target) => `${String(target.entity_id)}\u0000${String(target.entity_namespace)}`));
  if (targetKeys.size !== rows.targets.length) fail("duplicate target identity");
  for (const target of rows.targets) {
    safeId(target.entity_id, "target.entity_id");
    text(target.entity_namespace, "target.entity_namespace");
    const sourceId = safeId(target.source_id, "target.source_id");
    if (!sourceMap.has(sourceId)) fail(`target ${String(target.entity_id)} references missing source_id`);
  }
  const evidenceIds = new Set<string>();
  for (const evidence of rows.evidence) {
    assertEvidence(evidence, sourceMap);
    if (evidenceIds.has(evidence.evidence_id)) fail(`duplicate evidence_id ${evidence.evidence_id}`);
    evidenceIds.add(evidence.evidence_id);
    if (!targetKeys.has(`${evidence.target_id}\u0000${evidence.target_namespace}`)) fail(`evidence ${evidence.evidence_id} references missing target identity`);
  }
  const supportingIds = new Set<string>();
  for (const supporting of rows.supporting) {
    safeId(supporting.supporting_id, "supporting_id");
    safeId(supporting.evidence_id, "evidence_id");
    text(supporting.supporting_type, "supporting_type");
    if (supporting.supporting_value === undefined) fail(`supporting ${supporting.supporting_id} is missing supporting_value`);
    safeId(supporting.source_id, "source_id");
    if (supportingIds.has(supporting.supporting_id)) fail(`duplicate supporting_id ${supporting.supporting_id}`);
    supportingIds.add(supporting.supporting_id);
    if (!evidenceIds.has(supporting.evidence_id)) fail(`supporting ${supporting.supporting_id} references missing evidence_id`);
    const source = sourceMap.get(supporting.source_id);
    if (source === undefined) fail(`supporting ${supporting.supporting_id} references missing source_id`);
  }
}
