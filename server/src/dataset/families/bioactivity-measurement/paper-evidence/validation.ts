import type { SourceLocatorV2 } from "@biomed/contracts";

import { canonicalDigest } from "../../../adapters/identity.js";
import type {
  MultiTableValidationRequest,
  MultiTableValidationResult,
} from "../../../contracts/index.js";
import { parseSourceLocator } from "../../../contracts/index.js";
import {
  parseMeasurementRelation,
} from "../../../schema/common/index.js";
import { validateMultiTableCandidate } from "../../../validation/multitable.js";
import {
  bioactivityRelations,
  bioactivityTableEntries,
  bioactivityValidationPolicy,
} from "../schemas.js";
import type {
  BioactivityActivityInput,
  BioactivityAssayInput,
  BioactivityCompoundInput,
  BioactivityTargetInput,
} from "../types.js";
import {
  chartEvidenceRelations,
  chartEvidenceTables,
  chartEvidenceValidationPolicy,
} from "../chart-evidence/index.js";
import {
  paperEvidenceRelations,
  paperEvidenceTables,
} from "./schemas.js";
import {
  ACTIVITY_VALUE_RECORDS_TABLE_ID,
  PAPER_ID_ABSENT,
  type ActivityValueRecordInput,
  type PaperDerivedCanonicalIdentities,
  type PaperEvidenceRows,
} from "./types.js";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;
const SHA256 = /^[0-9a-f]{64}$/;
const CONTENT_ASSET_ID = /^asset_[0-9a-f]{64}$/;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T/;
const CONFIDENCE_LEVELS = ["high", "medium", "low"] as const;

export interface PaperEvidencePublicationCheck {
  check_id: string;
  passed: boolean;
  detail: string;
}

export interface PaperEvidencePublicationResult {
  publishable: boolean;
  checks: PaperEvidencePublicationCheck[];
}

function fail(message: string): never {
  throw new TypeError(`paper evidence rejected: ${message}`);
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

function identifierToken(value: unknown, name: string): string {
  const parsed = text(value, name);
  if (!SAFE_ID.test(parsed) || parsed.includes("..")) {
    fail(`${name} must be a safe identifier token or the explicit absent token`);
  }
  return parsed;
}

function isoDateTime(value: unknown, name: string): string {
  const parsed = text(value, name);
  if (!ISO_DATETIME.test(parsed) || Number.isNaN(Date.parse(parsed))) {
    fail(`${name} must be ISO 8601`);
  }
  return parsed;
}

function sourceLocator(
  value: unknown,
  name: string,
  expectedAssetId?: string,
): SourceLocatorV2 {
  let parsed: ReturnType<typeof parseSourceLocator>;
  try {
    parsed = parseSourceLocator(value);
  } catch (error) {
    fail(`${name} is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!("locator_version" in parsed) || parsed.locator_version !== "2.0") {
    fail(`${name} must be a SourceLocator 2.0`);
  }
  if (!CONTENT_ASSET_ID.test(parsed.asset_id)) fail(`${name}.asset_id must be content addressed`);
  if (expectedAssetId !== undefined && parsed.asset_id !== expectedAssetId) {
    fail(`${name}.asset_id does not match source_asset_id`);
  }
  return parsed;
}

/**
 * The composite paper identity renders as a safe digest-derived join key so
 * chart_series.paper_id can reference paper_records without embedding raw
 * identifiers that may contain unsafe characters.
 */
function paperKeyOf(paper: Pick<PaperEvidenceRows["paper_records"][number], "pmid" | "pmcid" | "doi">): string {
  return `paper_${canonicalDigest([paper.pmid, paper.pmcid, paper.doi]).slice(0, 32)}`;
}

function activityKey(record: ActivityValueRecordInput): string {
  return [
    record.experiment_id,
    record.compound,
    record.protein_variant,
    record.activity_type,
    record.table_or_figure,
    record.row_label,
    record.column_label,
  ].join("\u001f");
}

export function assertPaperEvidenceRows(
  rows: PaperEvidenceRows,
  registeredAssetIds: ReadonlySet<string>,
): void {
  if (rows.paper_records.length === 0) fail("paper_records must not be empty");
  if (rows.experiment_records.length === 0) fail("experiment_records must not be empty");
  if (rows.activity_value_records.length === 0) fail("activity_value_records must not be empty");
  if (rows.supplementary_asset_records.length === 0) fail("supplementary_asset_records must not be empty");

  const papers = new Set<string>();
  for (const paper of rows.paper_records) {
    const pmid = identifierToken(paper.pmid, "pmid");
    const pmcid = identifierToken(paper.pmcid, "pmcid");
    const doi = identifierToken(paper.doi, "doi");
    if ([pmid, pmcid, doi].every((token) => token === PAPER_ID_ABSENT)) {
      fail(`paper ${paper.paper_key} requires at least one of pmid, pmcid, or doi`);
    }
    text(paper.title, "paper title");
    if (paper.journal !== null) text(paper.journal, "paper journal");
    if (paper.publication_date !== null) text(paper.publication_date, "paper publication_date");
    if (paper.open_access_status !== null) text(paper.open_access_status, "paper open_access_status");
    if (paper.source_url !== null) text(paper.source_url, "paper source_url");
    safeId(paper.source_id, "paper source_id");
    const key = paperKeyOf({ pmid, pmcid, doi });
    if (paper.paper_key !== key) {
      fail(`paper paper_key ${paper.paper_key} does not match its pmid|pmcid|doi composite ${key}`);
    }
    if (papers.has(key)) fail(`duplicate paper identity ${key}`);
    papers.add(key);
  }

  const experiments = new Set<string>();
  for (const experiment of rows.experiment_records) {
    safeId(experiment.experiment_id, "experiment_id");
    if (experiments.has(experiment.experiment_id)) {
      fail(`duplicate experiment_id ${experiment.experiment_id}`);
    }
    if (!papers.has(experiment.paper_id)) {
      fail(`experiment ${experiment.experiment_id} references missing paper ${experiment.paper_id}`);
    }
    text(experiment.protein, "experiment protein");
    if (experiment.variant !== null) text(experiment.variant, "experiment variant");
    if (experiment.construct !== null) text(experiment.construct, "experiment construct");
    if (experiment.ligand !== null) text(experiment.ligand, "experiment ligand");
    text(experiment.assay_type, "experiment assay_type");
    if (experiment.cell_line_or_system !== null) text(experiment.cell_line_or_system, "experiment cell_line_or_system");
    if (experiment.temperature !== null) text(experiment.temperature, "experiment temperature");
    if (experiment.buffer !== null) text(experiment.buffer, "experiment buffer");
    if (experiment.incubation_time !== null) text(experiment.incubation_time, "experiment incubation_time");
    sourceLocator(experiment.source_locator, "experiment source_locator");
    text(experiment.extraction_method, "experiment extraction_method");
    experiments.add(experiment.experiment_id);
  }

  const activityKeys = new Set<string>();
  for (const record of rows.activity_value_records) {
    if (!experiments.has(record.experiment_id)) {
      fail(`activity value references missing experiment ${record.experiment_id}`);
    }
    text(record.compound, "activity compound");
    text(record.protein_variant, "activity protein_variant");
    text(record.activity_type, "activity activity_type");
    const rawValue = text(record.activity_value, "activity activity_value");
    if (!Number.isFinite(Number(rawValue))) {
      fail("activity activity_value must be a finite numeric token");
    }
    text(record.activity_unit, "activity activity_unit");
    const relation = text(record.relation, "activity relation");
    try {
      parseMeasurementRelation(relation);
    } catch (error) {
      fail(`activity relation: ${error instanceof Error ? error.message : String(error)}`);
    }
    text(record.original_text, "activity original_text");
    text(record.table_or_figure, "activity table_or_figure");
    text(record.row_label, "activity row_label");
    text(record.column_label, "activity column_label");
    const confidence = text(record.confidence_level, "activity confidence_level");
    if (!CONFIDENCE_LEVELS.includes(confidence as (typeof CONFIDENCE_LEVELS)[number])) {
      fail(`activity confidence_level has unsupported value '${confidence}'`);
    }
    safeId(record.source_id, "activity source_id");
    if (!CONTENT_ASSET_ID.test(record.source_asset_id)) {
      fail("activity source_asset_id must be content addressed");
    }
    if (!registeredAssetIds.has(record.source_asset_id)) {
      fail(`activity value references unregistered source asset ${record.source_asset_id}`);
    }
    sourceLocator(record.source_locator, "activity source_locator", record.source_asset_id);
    isoDateTime(record.retrieved_at, "activity retrieved_at");
    const key = activityKey(record);
    if (activityKeys.has(key)) fail(`duplicate activity value key ${key.replaceAll("\u001f", "|")}`);
    activityKeys.add(key);
  }

  const assets = new Set<string>();
  for (const asset of rows.supplementary_asset_records) {
    if (!papers.has(asset.paper_id)) {
      fail(`supplementary asset ${asset.asset_name} references missing paper ${asset.paper_id}`);
    }
    safeId(asset.asset_name, "supplementary asset_name");
    text(asset.asset_type, "supplementary asset_type");
    if (asset.download_url !== null) text(asset.download_url, "supplementary download_url");
    if (!SHA256.test(asset.sha256)) fail("supplementary sha256 must be a lowercase SHA-256");
    if (asset.file_size !== null && (!Number.isSafeInteger(asset.file_size) || asset.file_size < 0)) {
      fail("supplementary file_size must be a non-negative integer");
    }
    text(asset.parse_status, "supplementary parse_status");
    if (asset.table_count !== null && (!Number.isSafeInteger(asset.table_count) || asset.table_count < 0)) {
      fail("supplementary table_count must be a non-negative integer");
    }
    sourceLocator(asset.source_locator, "supplementary source_locator", asset.source_asset_id);
    if (!CONTENT_ASSET_ID.test(asset.source_asset_id)) {
      fail("supplementary source_asset_id must be content addressed");
    }
    if (!registeredAssetIds.has(asset.source_asset_id)) {
      fail(`supplementary asset ${asset.asset_name} references unregistered supplementary asset ${asset.source_asset_id}`);
    }
    const key = `${asset.paper_id}\u001f${asset.asset_name}`;
    if (assets.has(key)) fail(`duplicate supplementary asset ${asset.asset_name}`);
    assets.add(key);
  }
}

export function evaluatePaperEvidencePublication(
  rows: PaperEvidenceRows,
  registeredAssetIds: ReadonlySet<string>,
): PaperEvidencePublicationResult {
  try {
    assertPaperEvidenceRows(rows, registeredAssetIds);
    return {
      publishable: true,
      checks: [{
        check_id: "paper_evidence_gate",
        passed: true,
        detail: "paper evidence is link-, measurement-, and registration-closed",
      }],
    };
  } catch (error) {
    return {
      publishable: false,
      checks: [{
        check_id: "paper_evidence_gate",
        passed: false,
        detail: error instanceof Error ? error.message : String(error),
      }],
    };
  }
}

function normalizeIdentityComponent(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function digestId(prefix: string, body: unknown): string {
  return `${prefix}_${canonicalDigest(body).slice(0, 32)}`;
}

/**
 * Concentration units admitted for canonical standardization; every derived
 * activity is standardized onto the controlled nM scale. Raw tokens are
 * always preserved alongside the standardized value.
 */
const CONCENTRATION_TO_NANOMOLAR: Readonly<Record<string, number>> = {
  nM: 1,
  uM: 1e3,
  "µM": 1e3,
  "μM": 1e3,
  mM: 1e6,
  pM: 1e-3,
  M: 1e9,
};

function standardizeToNanomolar(
  rawValue: string,
  rawUnit: string,
  name: string,
): { value: number; unit: "nM" } {
  const factor = CONCENTRATION_TO_NANOMOLAR[rawUnit.trim()];
  if (factor === undefined) {
    fail(`${name} unit '${rawUnit}' cannot be standardized to the controlled concentration scale`);
  }
  const numeric = Number(rawValue);
  const value = numeric * factor;
  if (!Number.isFinite(value)) fail(`${name} cannot be standardized to a finite nM value`);
  return { value, unit: "nM" };
}

export function derivePaperCanonicalIdentities(
  rows: PaperEvidenceRows,
): PaperDerivedCanonicalIdentities {
  const experiments = new Map(
    rows.experiment_records.map((experiment) => [experiment.experiment_id, experiment]),
  );
  const compounds = new Map<string, BioactivityCompoundInput>();
  const targets = new Map<string, BioactivityTargetInput>();
  const assays = new Map<string, BioactivityAssayInput>();
  const activities: BioactivityActivityInput[] = [];

  for (const record of rows.activity_value_records) {
    const experiment = experiments.get(record.experiment_id);
    if (experiment === undefined) {
      fail(`activity value references missing experiment ${record.experiment_id}`);
    }
    const normalizedCompound = normalizeIdentityComponent(record.compound);
    const compoundBody = { namespace: "paper_compound", name: normalizedCompound };
    const compoundId = digestId("cmp", compoundBody);
    if (!compounds.has(compoundId)) {
      compounds.set(compoundId, {
        compound_id: compoundId,
        compound_id_namespace: "paper_compound",
        preferred_name: record.compound,
        canonical_smiles: null,
        isomeric_smiles: null,
        inchi: null,
        inchi_key: null,
        molecular_formula: null,
        molecular_weight: null,
        source_id: record.source_id,
      });
    }

    const normalizedVariant = experiment.variant === null || experiment.variant === PAPER_ID_ABSENT
      ? ""
      : normalizeIdentityComponent(experiment.variant);
    const targetBody = {
      namespace: "paper_protein",
      protein: normalizeIdentityComponent(experiment.protein),
      variant: normalizedVariant,
    };
    const targetId = digestId("tgt", targetBody);
    if (!targets.has(targetId)) {
      targets.set(targetId, {
        entity_id: targetId,
        entity_namespace: "paper_protein",
        entity_type: "protein",
        preferred_name: normalizedVariant === ""
          ? experiment.protein
          : `${experiment.protein} ${experiment.variant}`,
        organism: null,
        source_id: record.source_id,
      });
    }

    const assayBody = {
      namespace: "paper_experiment",
      paper_id: experiment.paper_id,
      experiment_id: experiment.experiment_id,
    };
    const assayId = digestId("asy", assayBody);
    if (!assays.has(assayId)) {
      assays.set(assayId, {
        assay_id: assayId,
        assay_id_namespace: "paper_experiment",
        assay_type: experiment.assay_type,
        description: null,
        organism: null,
        cell_line: experiment.cell_line_or_system,
        target_entity_id: targetId,
        target_entity_namespace: "paper_protein",
        bao_format_id: null,
        source_id: record.source_id,
      });
    }

    const standardized = standardizeToNanomolar(
      record.activity_value,
      record.activity_unit,
      `activity value ${record.experiment_id}/${record.compound}`,
    );
    activities.push({
      activity_id: digestId("act", {
        namespace: "paper_activity",
        experiment_id: record.experiment_id,
        compound: normalizedCompound,
        protein_variant: normalizeIdentityComponent(record.protein_variant),
        activity_type: normalizeIdentityComponent(record.activity_type),
        table_or_figure: record.table_or_figure,
        row_label: record.row_label,
        column_label: record.column_label,
      }),
      compound_id: compoundId,
      compound_id_namespace: "paper_compound",
      assay_id: assayId,
      assay_id_namespace: "paper_experiment",
      target_id: targetId,
      target_namespace: "paper_protein",
      activity_type: record.activity_type,
      raw_value: record.activity_value,
      raw_relation: record.relation,
      preserved_relation: record.relation,
      raw_unit: record.activity_unit,
      preserved_raw_unit: record.activity_unit,
      standardized_value: standardized.value,
      standardized_unit: standardized.unit,
      source_id: record.source_id,
      source_asset_id: record.source_asset_id,
      source_locator: record.source_locator,
    });
  }

  return {
    activities,
    compounds: [...compounds.values()],
    assays: [...assays.values()],
    targets: [...targets.values()],
  };
}

export function paperEvidenceValidationPolicy(options?: {
  withChartTables?: boolean;
}): ReturnType<typeof chartEvidenceValidationPolicy> {
  const base = options?.withChartTables === false
    ? bioactivityValidationPolicy()
    : chartEvidenceValidationPolicy();
  return {
    ...base,
    token_preservation_rules: [
      ...base.token_preservation_rules,
      {
        table_id: ACTIVITY_VALUE_RECORDS_TABLE_ID,
        source_field: "relation",
        output_field: "relation",
        token_kind: "relation" as const,
      },
      {
        table_id: ACTIVITY_VALUE_RECORDS_TABLE_ID,
        source_field: "activity_unit",
        output_field: "activity_unit",
        token_kind: "unit" as const,
      },
    ],
  };
}

export async function validatePaperEvidenceCandidate(
  request: MultiTableValidationRequest,
  rows: PaperEvidenceRows,
  registeredAssetIds: ReadonlySet<string>,
  signal?: AbortSignal | null,
): Promise<MultiTableValidationResult> {
  const expectedTables = [
    ...bioactivityTableEntries().map((entry) => ({ schema: entry.schema, definition: entry.definition })),
    ...chartEvidenceTables,
    ...paperEvidenceTables,
  ];
  const expectedRelations = [
    ...bioactivityRelations,
    ...chartEvidenceRelations,
    ...paperEvidenceRelations,
  ];
  const same = (left: unknown, right: unknown): boolean =>
    JSON.stringify(left) === JSON.stringify(right);
  if (request.tables.length !== expectedTables.length || request.relations.length !== expectedRelations.length) {
    fail("candidate must contain the complete bioactivity, chart, and paper evidence table/relation contract");
  }
  for (const expected of expectedTables) {
    const actual = request.tables.find((table) => table.definition.table_id === expected.definition.table_id);
    if (actual === undefined || !same(actual.definition, expected.definition) || !same(actual.schema, expected.schema)) {
      fail(`table ${expected.definition.table_id} does not match the paper evidence contract`);
    }
  }
  for (const expected of expectedRelations) {
    if (!request.relations.some((actual) => same(actual, expected))) {
      fail(`relation ${expected.relation_id} does not match the paper evidence contract`);
    }
  }
  if (!same(request.policy, paperEvidenceValidationPolicy())) {
    fail("bioactivity token preservation policy is required");
  }
  const result = await validateMultiTableCandidate(request, signal);
  if (!result.passed) return result;
  const paperGate = evaluatePaperEvidencePublication(rows, registeredAssetIds);
  return {
    passed: paperGate.publishable,
    checks: [
      ...result.checks,
      ...paperGate.checks.map((item) => ({
        check_id: item.check_id,
        scope: "paper_evidence",
        passed: item.passed,
        detail: item.detail,
      })),
    ],
  };
}
