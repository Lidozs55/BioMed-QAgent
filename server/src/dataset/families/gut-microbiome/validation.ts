import type { RelationDefinition, SourceLocatorV2 } from "@biomed/contracts";
import type { MultiTableValidationRequest, MultiTableValidationResult } from "../../contracts/index.js";
import { parseSourceLocator } from "../../contracts/index.js";
import { validateMultiTableCandidate } from "../../validation/multitable.js";
import { gutMicrobiomeRelations, gutMicrobiomeTableDefinitions, gutMicrobiomeValidationPolicy } from "./schemas.js";
import type {
  GutMicrobiomeDifferentialAbundanceInput,
  GutMicrobiomeReferencePrevalenceInput,
  GutMicrobiomeRows,
  GutMicrobiomeStudyInput,
  GutMicrobiomeSourceInput,
  GutMicrobiomeTaxonInput,
} from "./types.js";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;
const CONTENT_ASSET_ID = /^asset_[0-9a-f]{64}$/;

function fail(message: string): never {
  throw new TypeError(`gut microbiome rejected: ${message}`);
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
    if (!("locator_version" in parsed) || parsed.locator_version !== "2.0") fail(`${name} must use SourceLocator 2.0`);
    if (!CONTENT_ASSET_ID.test(parsed.asset_id)) fail(`${name}.asset_id must be content addressed`);
    return parsed;
  } catch (error) {
    if (error instanceof TypeError && error.message.startsWith("gut microbiome rejected:")) throw error;
    fail(`${name} is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function sourceLink(sourceId: string, assetId: string, sourceLocator: SourceLocatorV2, sources: ReadonlyMap<string, GutMicrobiomeSourceInput>, label: string): void {
  const source = sources.get(sourceId);
  if (source === undefined) fail(`${label} references missing source_id`);
  if (source.source_asset_id !== assetId || sourceLocator.asset_id !== assetId) fail(`${label} source asset closure is invalid`);
}

function assertSource(value: GutMicrobiomeSourceInput): void {
  safeId(value.source_id, "source_id");
  if (!["mgnify", "gmrepo", "ncbi_taxonomy"].includes(value.source_database)) fail("source_database is not allowed");
  if (!CONTENT_ASSET_ID.test(value.source_asset_id)) fail("source_asset_id must be content addressed");
  const parsed = locator(value.source_locator, "source_locator");
  if (parsed.asset_id !== value.source_asset_id) fail("source locator does not match source_asset_id");
  if (Number.isNaN(Date.parse(text(value.retrieved_at, "retrieved_at")))) fail("retrieved_at must be an ISO datetime");
  text(value.carrier_type, "carrier_type");
}

function assertStudy(value: GutMicrobiomeStudyInput, sources: ReadonlyMap<string, GutMicrobiomeSourceInput>): void {
  safeId(value.study_id, "study_id");
  safeId(value.study_accession, "study_accession");
  text(value.study_title, "study_title");
  safeId(value.disease_id, "disease_id");
  text(value.disease_name, "disease_name");
  safeId(value.host_taxon_id, "host_taxon_id");
  if (!Number.isSafeInteger(value.sample_count) || value.sample_count < 1) fail("sample_count must be a positive integer");
  safeId(value.source_id, "source_id");
  if (!CONTENT_ASSET_ID.test(value.source_asset_id)) fail("source_asset_id must be content addressed");
  sourceLink(value.source_id, value.source_asset_id, locator(value.source_locator, "source_locator"), sources, `study ${value.study_id}`);
}

function assertTaxon(value: GutMicrobiomeTaxonInput, sources: ReadonlyMap<string, GutMicrobiomeSourceInput>): void {
  safeId(value.study_id, "study_id");
  safeId(value.sample_id, "sample_id");
  text(value.taxon_path, "taxon_path");
  safeId(value.taxon_id, "taxon_id");
  if (!Number.isSafeInteger(value.abundance) || value.abundance < 0) fail("abundance must be a non-negative integer");
  safeId(value.source_id, "source_id");
  if (!CONTENT_ASSET_ID.test(value.source_asset_id)) fail("source_asset_id must be content addressed");
  sourceLink(value.source_id, value.source_asset_id, locator(value.source_locator, "source_locator"), sources, `taxon ${value.taxon_id}`);
}

function assertDifferential(value: GutMicrobiomeDifferentialAbundanceInput, sources: ReadonlyMap<string, GutMicrobiomeSourceInput>): void {
  safeId(value.study_id, "study_id");
  safeId(value.taxon_id, "taxon_id");
  safeId(value.comparison_id, "comparison_id");
  text(value.comparison_label, "comparison_label");
  if (!Number.isFinite(value.effect_size)) fail("effect_size must be finite");
  if (!Number.isFinite(value.p_value) || value.p_value < 0 || value.p_value > 1) fail("p_value must be in [0,1]");
  if (value.adjusted_p_value !== null && (!Number.isFinite(value.adjusted_p_value) || value.adjusted_p_value < 0 || value.adjusted_p_value > 1)) fail("adjusted_p_value must be null or in [0,1]");
  if (!["increase", "decrease", "unchanged"].includes(value.effect_direction)) fail("effect_direction is invalid");
  safeId(value.source_id, "source_id");
  if (!CONTENT_ASSET_ID.test(value.source_asset_id)) fail("source_asset_id must be content addressed");
  sourceLink(value.source_id, value.source_asset_id, locator(value.source_locator, "source_locator"), sources, `differential result ${value.comparison_id}`);
}

function assertPrevalence(value: GutMicrobiomeReferencePrevalenceInput, sources: ReadonlyMap<string, GutMicrobiomeSourceInput>): void {
  safeId(value.study_id, "study_id");
  safeId(value.taxon_id, "taxon_id");
  text(value.reference_group, "reference_group");
  if (!Number.isFinite(value.prevalence) || value.prevalence < 0 || value.prevalence > 1) fail("prevalence must be in [0,1]");
  if (!Number.isSafeInteger(value.reference_sample_count) || value.reference_sample_count < 1) fail("reference_sample_count must be a positive integer");
  safeId(value.source_id, "source_id");
  if (!CONTENT_ASSET_ID.test(value.source_asset_id)) fail("source_asset_id must be content addressed");
  sourceLink(value.source_id, value.source_asset_id, locator(value.source_locator, "source_locator"), sources, `prevalence ${value.taxon_id}`);
}

export function assertGutMicrobiomeRows(rows: GutMicrobiomeRows): void {
  if (rows.studies.length === 0) fail("study table must not be empty");
  if (rows.taxa.length === 0) fail("taxon table must not be empty");
  if (rows.differentialAbundances.length === 0) fail("differential abundance table must not be empty");
  if (rows.referencePrevalences.length === 0) fail("reference prevalence table must not be empty");
  if (rows.sources.length === 0) fail("source table must not be empty");
  const sources = new Map<string, GutMicrobiomeSourceInput>();
  for (const source of rows.sources) {
    assertSource(source);
    if (sources.has(source.source_id)) fail(`duplicate source_id ${source.source_id}`);
    sources.set(source.source_id, source);
  }
  const studies = new Set<string>();
  for (const study of rows.studies) {
    assertStudy(study, sources);
    if (studies.has(study.study_id)) fail(`duplicate study_id ${study.study_id}`);
    studies.add(study.study_id);
  }
  const taxa = new Set<string>();
  for (const taxon of rows.taxa) {
    assertTaxon(taxon, sources);
    if (!studies.has(taxon.study_id)) fail(`taxon ${taxon.taxon_id} references missing study`);
    const key = `${taxon.study_id}\u001f${taxon.taxon_id}`;
    taxa.add(key);
  }
  const differentialIds = new Set<string>();
  for (const value of rows.differentialAbundances) {
    assertDifferential(value, sources);
    if (!studies.has(value.study_id)) fail(`differential result ${value.comparison_id} references missing study`);
    if (!taxa.has(`${value.study_id}\u001f${value.taxon_id}`)) fail(`differential result ${value.comparison_id} references missing taxon`);
    const key = `${value.study_id}\u001f${value.taxon_id}\u001f${value.comparison_id}`;
    if (differentialIds.has(key)) fail(`duplicate differential result ${value.comparison_id}`);
    differentialIds.add(key);
  }
  const prevalenceIds = new Set<string>();
  for (const value of rows.referencePrevalences) {
    assertPrevalence(value, sources);
    if (!studies.has(value.study_id)) fail(`prevalence ${value.taxon_id} references missing study`);
    if (!taxa.has(`${value.study_id}\u001f${value.taxon_id}`)) fail(`prevalence ${value.taxon_id} references missing taxon`);
    const key = `${value.study_id}\u001f${value.taxon_id}\u001f${value.reference_group}`;
    if (prevalenceIds.has(key)) fail(`duplicate prevalence ${value.taxon_id}`);
    prevalenceIds.add(key);
  }
}

export function assertGutMicrobiomeRelations(relations: readonly RelationDefinition[]): void {
  if (relations.length !== gutMicrobiomeRelations.length) fail("all gut microbiome relations are required");
  for (const expected of gutMicrobiomeRelations) {
    const actual = relations.find((item) => item.relation_id === expected.relation_id);
    if (actual === undefined || JSON.stringify(actual) !== JSON.stringify(expected)) fail(`relation ${expected.relation_id} is missing or changed`);
  }
}

export async function validateGutMicrobiomeCandidate(request: MultiTableValidationRequest, signal?: AbortSignal | null): Promise<MultiTableValidationResult> {
  const expectedTables = gutMicrobiomeTableDefinitions();
  const actualIds = request.tables.map((table) => table.definition.table_id).sort();
  const expectedIds = expectedTables.map((table) => table.table_id).sort();
  if (JSON.stringify(actualIds) !== JSON.stringify(expectedIds)) fail("all four gut microbiome tables are required");
  for (const expected of expectedTables) {
    const actual = request.tables.find((table) => table.definition.table_id === expected.table_id);
    if (actual === undefined || JSON.stringify(actual.definition) !== JSON.stringify(expected)) fail(`table ${expected.table_id} does not match the gut microbiome schema contract`);
  }
  assertGutMicrobiomeRelations(request.relations);
  if (JSON.stringify(request.policy) !== JSON.stringify(gutMicrobiomeValidationPolicy())) fail("gut microbiome validation policy is required");
  const expectedRelationIds = gutMicrobiomeRelations.map((relation) => relation.relation_id).sort();
  if (JSON.stringify([...request.candidate.relation_ids].sort()) !== JSON.stringify(expectedRelationIds)) fail("candidate must reference every gut microbiome relation");
  return validateMultiTableCandidate(request, signal);
}
