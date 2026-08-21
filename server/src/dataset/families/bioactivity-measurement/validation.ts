import type {
  RelationDefinition,
  SourceLocatorV2,
} from "@biomed/contracts";

import type {
  MultiTableValidationRequest,
  MultiTableValidationResult,
} from "../../contracts/index.js";
import { parseSourceLocator } from "../../contracts/index.js";
import {
  parseBiomedicalUnit,
  parseMeasurementRelation,
} from "../../schema/common/index.js";
import { validateMultiTableCandidate } from "../../validation/multitable.js";
import {
  bioactivityCompoundCrosswalkSchema,
  bioactivityCompoundCrosswalkTable,
  bioactivityIdentityRelations,
  bioactivityRelations,
  bioactivityTableEntries,
  bioactivityValidationPolicy,
} from "./schemas.js";
import type {
  BioactivityActivityInput,
  BioactivityAssayInput,
  BioactivityRows,
} from "./types.js";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;
const CONTENT_ASSET_ID = /^asset_[0-9a-f]{64}$/;

function fail(message: string): never {
  throw new TypeError(`bioactivity measurement rejected: ${message}`);
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") fail(`${name} is required`);
  return value;
}

function safeId(value: unknown, name: string): string {
  const parsed = text(value, name);
  if (!SAFE_ID.test(parsed) || parsed.includes("..")) fail(`${name} is not a safe identifier`);
  return parsed;
}

function locator(value: unknown, name: string): SourceLocatorV2 {
  try {
    const parsed = parseSourceLocator(value);
    if (!("locator_version" in parsed) || parsed.locator_version !== "2.0") {
      fail(`${name} must use SourceLocator 2.0`);
    }
    if (!CONTENT_ASSET_ID.test(parsed.asset_id)) {
      fail(`${name}.asset_id must be content addressed`);
    }
    return parsed;
  } catch (error) {
    if (error instanceof TypeError && error.message.startsWith("bioactivity measurement rejected:")) {
      throw error;
    }
    fail(`${name} is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function identity(id: string, namespace: string): string {
  return `${id}\u001f${namespace}`;
}

function sameContract(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertActivity(value: BioactivityActivityInput): void {
  safeId(value.activity_id, "activity_id");
  safeId(value.compound_id, "compound_id");
  text(value.compound_id_namespace, "compound_id_namespace");
  safeId(value.assay_id, "assay_id");
  text(value.assay_id_namespace, "assay_id_namespace");
  safeId(value.target_id, "target_id");
  text(value.target_namespace, "target_namespace");
  text(value.activity_type, "activity_type");
  const rawValue = text(value.raw_value, "raw_value");
  if (!Number.isFinite(Number(rawValue))) fail("raw_value must be a finite numeric token");
  try {
    parseMeasurementRelation(text(value.raw_relation, "raw_relation"));
    parseMeasurementRelation(text(value.preserved_relation, "preserved_relation"));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  if (value.raw_relation !== value.preserved_relation) {
    fail(`activity ${value.activity_id} changed the raw relation token`);
  }
  text(value.raw_unit, "raw_unit");
  text(value.preserved_raw_unit, "preserved_raw_unit");
  if (value.raw_unit !== value.preserved_raw_unit) {
    fail(`activity ${value.activity_id} changed the raw unit token`);
  }
  if (!Number.isFinite(value.standardized_value)) {
    fail("standardized_value must be finite");
  }
  try {
    parseBiomedicalUnit(text(value.standardized_unit, "standardized_unit"));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  safeId(value.source_id, "source_id");
  if (!CONTENT_ASSET_ID.test(value.source_asset_id)) {
    fail("source_asset_id must be content addressed");
  }
  const parsedLocator = locator(value.source_locator, "source_locator");
  if (parsedLocator.asset_id !== value.source_asset_id) {
    fail(`activity ${value.activity_id} locator does not match source_asset_id`);
  }
}

function assertAssay(value: BioactivityAssayInput): void {
  safeId(value.assay_id, "assay_id");
  text(value.assay_id_namespace, "assay_id_namespace");
  text(value.assay_type, "assay_type");
  if (value.description !== null) text(value.description, "description");
  if (value.organism !== null) text(value.organism, "organism");
  if (value.cell_line !== null) text(value.cell_line, "cell_line");
  safeId(value.target_entity_id, "target_entity_id");
  text(value.target_entity_namespace, "target_entity_namespace");
  if (value.bao_format_id !== null) text(value.bao_format_id, "bao_format_id");
  safeId(value.source_id, "source_id");
}

export function assertBioactivityRelations(
  relations: readonly RelationDefinition[],
  identityEnabled = false,
): void {
  const expectedRelations = identityEnabled
    ? [...bioactivityRelations, ...bioactivityIdentityRelations]
    : [...bioactivityRelations];
  if (relations.length !== expectedRelations.length) {
    fail(identityEnabled
      ? "base bioactivity and both compound identity relations are required"
      : "activity compound, assay, target, and assay-target relations are all required");
  }
  for (const expected of expectedRelations) {
    const actual = relations.find((item) => item.relation_id === expected.relation_id);
    if (actual === undefined || !sameContract(actual, expected)) {
      fail(`relation ${expected.relation_id} is missing or changed`);
    }
  }
}

export function assertBioactivityRows(rows: BioactivityRows): void {
  if (rows.activities.length === 0) fail("primary activity table must not be empty");
  if (rows.compounds.length === 0) fail("compound supporting table must not be empty");
  if (rows.assays.length === 0) fail("assay supporting table must not be empty");
  if (rows.targets.length === 0) fail("target supporting table must not be empty");

  const activityIds = new Set<string>();
  const sourceAssets = new Map<string, string>();
  for (const activity of rows.activities) {
    assertActivity(activity);
    if (activityIds.has(activity.activity_id)) fail(`duplicate activity_id ${activity.activity_id}`);
    activityIds.add(activity.activity_id);
    const existingAsset = sourceAssets.get(activity.source_id);
    if (existingAsset !== undefined && existingAsset !== activity.source_asset_id) {
      fail(`source_id ${activity.source_id} maps to multiple source assets`);
    }
    sourceAssets.set(activity.source_id, activity.source_asset_id);
  }

  const compounds = new Set<string>();
  for (const compound of rows.compounds) {
    safeId(compound.compound_id, "compound_id");
    text(compound.compound_id_namespace, "compound_id_namespace");
    text(compound.preferred_name, "compound preferred_name");
    const sourceId = safeId(compound.source_id, "compound source_id");
    if (!sourceAssets.has(sourceId)) fail(`compound ${compound.compound_id} references unprovenanced source_id`);
    const key = identity(compound.compound_id, compound.compound_id_namespace);
    if (compounds.has(key)) fail(`duplicate compound identity ${compound.compound_id}`);
    compounds.add(key);
  }

  const targets = new Set<string>();
  for (const target of rows.targets) {
    safeId(target.entity_id, "target entity_id");
    text(target.entity_namespace, "target entity_namespace");
    text(target.entity_type, "target entity_type");
    text(target.preferred_name, "target preferred_name");
    const sourceId = safeId(target.source_id, "target source_id");
    if (!sourceAssets.has(sourceId)) fail(`target ${target.entity_id} references unprovenanced source_id`);
    const key = identity(target.entity_id, target.entity_namespace);
    if (targets.has(key)) fail(`duplicate target identity ${target.entity_id}`);
    targets.add(key);
  }

  const assays = new Map<string, BioactivityAssayInput>();
  for (const assay of rows.assays) {
    assertAssay(assay);
    if (!sourceAssets.has(assay.source_id)) fail(`assay ${assay.assay_id} references unprovenanced source_id`);
    const key = identity(assay.assay_id, assay.assay_id_namespace);
    if (assays.has(key)) fail(`duplicate assay identity ${assay.assay_id}`);
    if (!targets.has(identity(assay.target_entity_id, assay.target_entity_namespace))) {
      fail(`assay ${assay.assay_id} references missing target identity`);
    }
    assays.set(key, assay);
  }

  for (const activity of rows.activities) {
    if (!compounds.has(identity(activity.compound_id, activity.compound_id_namespace))) {
      fail(`activity ${activity.activity_id} references missing compound identity`);
    }
    const assay = assays.get(identity(activity.assay_id, activity.assay_id_namespace));
    if (assay === undefined) fail(`activity ${activity.activity_id} references missing assay identity`);
    if (!targets.has(identity(activity.target_id, activity.target_namespace))) {
      fail(`activity ${activity.activity_id} references missing target identity`);
    }
    if (activity.target_id !== assay.target_entity_id ||
        activity.target_namespace !== assay.target_entity_namespace) {
      fail(`activity ${activity.activity_id} target does not match its assay target`);
    }
  }
}

export async function validateBioactivityCandidate(
  request: MultiTableValidationRequest,
  signal?: AbortSignal | null,
): Promise<MultiTableValidationResult> {
  const expectedTables = bioactivityTableEntries();
  const actualIds = request.tables.map((table) => table.definition.table_id).sort();
  const requiredIds = expectedTables.map((table) => table.tableId).sort();
  const identityEnabled = actualIds.includes("compound_crosswalks");
  const expectedIds = identityEnabled
    ? [...requiredIds, "compound_crosswalks"].sort()
    : requiredIds;
  if (!sameContract(actualIds, expectedIds)) {
    fail("activities, compounds, assays, and targets are required; only compound_crosswalks is optional");
  }
  for (const expected of expectedTables) {
    const actual = request.tables.find((table) => table.definition.table_id === expected.tableId);
    if (actual === undefined ||
        !sameContract(actual.definition, expected.definition) ||
        !sameContract(actual.schema, expected.schema)) {
      fail(`table ${expected.tableId} does not match the bioactivity schema contract`);
    }
  }
  if (identityEnabled) {
    const crosswalk = request.tables.find((table) => table.definition.table_id === "compound_crosswalks");
    if (crosswalk === undefined ||
        !sameContract(crosswalk.definition, bioactivityCompoundCrosswalkTable) ||
        !sameContract(crosswalk.schema, bioactivityCompoundCrosswalkSchema)) {
      fail("table compound_crosswalks does not match the bioactivity identity schema contract");
    }
  }
  assertBioactivityRelations(request.relations, identityEnabled);
  const relationIds = [...request.candidate.relation_ids].sort();
  const expectedRelationIds = (identityEnabled
    ? [...bioactivityRelations, ...bioactivityIdentityRelations]
    : [...bioactivityRelations]).map((item) => item.relation_id).sort();
  if (!sameContract(relationIds, expectedRelationIds)) {
    fail("candidate must reference every bioactivity relation");
  }
  if (!sameContract(request.policy, bioactivityValidationPolicy())) {
    fail("bioactivity relation and unit token preservation policy is required");
  }
  return validateMultiTableCandidate(request, signal);
}
