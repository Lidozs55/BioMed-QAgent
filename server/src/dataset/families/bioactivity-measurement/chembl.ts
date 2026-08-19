import type { SourceLocatorV2 } from "@biomed/contracts";

import type {
  BioactivityActivityInput,
  BioactivityAssayInput,
  BioactivityCompoundInput,
  BioactivityRows,
  BioactivityTargetInput,
} from "./types.js";

export type ChemblAssetKind = "activity" | "assay" | "target";

export interface ChemblRegisteredJsonAsset {
  kind: ChemblAssetKind;
  source_id: string;
  source_asset_id: string;
  logical_file: string;
  document: unknown;
}

const ASSET_ID = /^asset_[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;
const RELATIONS = new Set(["=", "<", ">", "<=", ">=", "~"]);
const UNITS = new Set(["M", "mM", "uM", "nM", "pM"]);

function fail(message: string): never {
  throw new TypeError(`ChEMBL bioactivity transform rejected: ${message}`);
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") fail(`${name} is required`);
  return value;
}

function optionalText(value: unknown, name: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  return text(value, name);
}

function safeId(value: unknown, name: string): string {
  const parsed = typeof value === "number" && Number.isSafeInteger(value)
    ? String(value)
    : text(value, name);
  if (!SAFE_ID.test(parsed) || parsed.includes("..")) fail(`${name} is not a safe identifier`);
  return parsed;
}

function numberValue(value: unknown, name: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) fail(`${name} must be finite`);
  return parsed;
}

function objectArray(document: unknown, key: ChemblAssetKind): readonly Record<string, unknown>[] {
  const root = record(document, `${key} JSON`);
  const expectedKey = key === "activity" ? "activities" : `${key}s`;
  const allowedKeys = new Set([expectedKey, "page_meta"]);
  if (Object.keys(root).some((item) => !allowedKeys.has(item))) {
    fail(`${key} JSON has unknown top-level fields`);
  }
  const values = root[expectedKey];
  if (!Array.isArray(values) || values.length === 0) fail(`${key} JSON requires a non-empty ${expectedKey} array`);
  return values.map((value, index) => record(value, `${key} record ${index}`));
}

function relation(value: unknown, name: string): string {
  const parsed = text(value, name);
  if (!RELATIONS.has(parsed)) fail(`${name} is not a controlled relation`);
  return parsed;
}

function unit(value: unknown, name: string): string {
  const parsed = text(value, name);
  if (!UNITS.has(parsed)) fail(`${name} is not a controlled concentration unit`);
  return parsed;
}

function toNanomolar(value: number, sourceUnit: string): number {
  const factor: Record<string, number> = { M: 1e9, mM: 1e6, uM: 1e3, nM: 1, pM: 1e-3 };
  const normalized = value * (factor[sourceUnit] ?? Number.NaN);
  if (!Number.isFinite(normalized)) fail(`cannot standardize unit ${sourceUnit}`);
  return normalized;
}

function locator(asset: ChemblRegisteredJsonAsset, pointer: string, rawValue: unknown): SourceLocatorV2 {
  return {
    locator_version: "2.0",
    locator_type: "json_pointer",
    asset_id: asset.source_asset_id,
    logical_file: asset.logical_file,
    raw_value: JSON.stringify(rawValue),
    json_pointer: pointer,
  };
}

function structureValue(item: Record<string, unknown>, key: string): string | null {
  const direct = optionalText(item[key], key);
  if (direct !== null) return direct;
  const structures = item.molecule_structures;
  if (structures !== null && structures !== undefined) {
    return optionalText(record(structures, "molecule_structures")[key], `molecule_structures.${key}`);
  }
  return null;
}

function compoundFromActivity(
  item: Record<string, unknown>,
  sourceId: string,
): BioactivityCompoundInput {
  const compoundId = safeId(item.molecule_chembl_id, "molecule_chembl_id");
  const properties = item.molecule_properties === undefined || item.molecule_properties === null
    ? null
    : record(item.molecule_properties, "molecule_properties");
  const molecularWeight = properties === null
    ? null
    : properties.full_mwt === undefined && properties.mw_freebase === undefined
      ? null
      : numberValue(properties.full_mwt ?? properties.mw_freebase, "molecule molecular weight");
  return {
    compound_id: compoundId,
    compound_id_namespace: "chembl_compound",
    preferred_name: text(item.molecule_pref_name ?? compoundId, "molecule_pref_name"),
    canonical_smiles: structureValue(item, "canonical_smiles"),
    isomeric_smiles: structureValue(item, "isomeric_smiles"),
    inchi: structureValue(item, "standard_inchi"),
    inchi_key: structureValue(item, "standard_inchi_key"),
    molecular_formula: properties === null ? null : optionalText(properties.full_molecular_formula, "full_molecular_formula"),
    molecular_weight: molecularWeight,
    source_id: sourceId,
  };
}

function mergeUnique<T extends { source_id: string }>(
  map: Map<string, T>,
  key: string,
  value: T,
  label: string,
): void {
  const prior = map.get(key);
  if (prior !== undefined && JSON.stringify(prior) !== JSON.stringify(value)) {
    fail(`conflicting ${label} records for ${key}`);
  }
  map.set(key, value);
}

export function transformChemblRegisteredAssets(
  assets: readonly ChemblRegisteredJsonAsset[],
): BioactivityRows {
  if (assets.length === 0) fail("at least one registered JSON asset is required");
  const byKind = new Map<ChemblAssetKind, ChemblRegisteredJsonAsset>();
  for (const asset of assets) {
    if (!ASSET_ID.test(asset.source_asset_id)) fail(`${asset.kind} source_asset_id must be content addressed`);
    safeId(asset.source_id, `${asset.kind} source_id`);
    text(asset.logical_file, `${asset.kind} logical_file`);
    if (byKind.has(asset.kind)) fail(`duplicate ${asset.kind} asset binding`);
    byKind.set(asset.kind, asset);
  }
  const activityAsset = byKind.get("activity");
  const assayAsset = byKind.get("assay");
  const targetAsset = byKind.get("target");
  if (activityAsset === undefined || assayAsset === undefined || targetAsset === undefined) {
    fail("activity, assay, and target assets are all required");
  }

  const activities: BioactivityActivityInput[] = [];
  const compounds = new Map<string, BioactivityCompoundInput>();
  for (const [index, item] of objectArray(activityAsset.document, "activity").entries()) {
    const activityId = `CHEMBL_ACTIVITY_${safeId(item.activity_id, "activity_id")}`;
    const rawValue = text(item.value ?? item.standard_value, "activity value");
    const rawRelation = relation(item.relation ?? item.standard_relation, "activity relation");
    const rawUnit = unit(item.units ?? item.standard_units, "activity units");
    const standardizedValue = numberValue(item.standard_value ?? item.value, "standard_value");
    const standardizedRelation = relation(item.standard_relation ?? item.relation, "standard_relation");
    const standardizedUnit = unit(item.standard_units ?? item.units, "standard_units");
    const compound = compoundFromActivity(item, activityAsset.source_id);
    mergeUnique(compounds, `${compound.compound_id}\u001f${compound.compound_id_namespace}`, compound, "compound");
    const assayId = safeId(item.assay_chembl_id, "assay_chembl_id");
    const targetId = safeId(item.target_chembl_id, "target_chembl_id");
    activities.push({
      activity_id: activityId,
      compound_id: compound.compound_id,
      compound_id_namespace: compound.compound_id_namespace,
      assay_id: assayId,
      assay_id_namespace: "chembl_assay",
      target_id: targetId,
      target_namespace: "chembl_target",
      activity_type: text(item.standard_type ?? item.activity_type, "standard_type"),
      raw_value: rawValue,
      raw_relation: rawRelation,
      preserved_relation: rawRelation,
      raw_unit: rawUnit,
      preserved_raw_unit: rawUnit,
      standardized_value: toNanomolar(standardizedValue, standardizedUnit),
      standardized_unit: "nM",
      source_id: activityAsset.source_id,
      source_asset_id: activityAsset.source_asset_id,
      source_locator: locator(activityAsset, `/activities/${index}`, item),
    });
    if (standardizedRelation !== rawRelation) {
      fail(`activity ${activityId} changes relation between raw and standardized records`);
    }
  }

  const assays = new Map<string, BioactivityAssayInput>();
  for (const item of objectArray(assayAsset.document, "assay")) {
    const assayId = safeId(item.assay_chembl_id, "assay_chembl_id");
    const assay: BioactivityAssayInput = {
      assay_id: assayId,
      assay_id_namespace: "chembl_assay",
      assay_type: text(item.assay_type, "assay_type"),
      description: optionalText(item.description, "description"),
      organism: optionalText(item.assay_organism ?? item.organism, "assay organism"),
      cell_line: optionalText(item.cell_line_name ?? item.cell_line, "cell line"),
      target_entity_id: safeId(item.target_chembl_id, "assay target_chembl_id"),
      target_entity_namespace: "chembl_target",
      bao_format_id: optionalText(item.bao_format, "bao_format"),
      source_id: assayAsset.source_id,
    };
    mergeUnique(assays, `${assay.assay_id}\u001f${assay.assay_id_namespace}`, assay, "assay");
  }

  const targets = new Map<string, BioactivityTargetInput>();
  for (const item of objectArray(targetAsset.document, "target")) {
    const targetId = safeId(item.target_chembl_id, "target_chembl_id");
    const target: BioactivityTargetInput = {
      entity_id: targetId,
      entity_namespace: "chembl_target",
      entity_type: text(item.target_type, "target_type"),
      preferred_name: text(item.pref_name, "pref_name"),
      organism: optionalText(item.organism, "target organism"),
      source_id: targetAsset.source_id,
    };
    mergeUnique(targets, `${target.entity_id}\u001f${target.entity_namespace}`, target, "target");
  }

  return {
    activities,
    compounds: [...compounds.values()],
    assays: [...assays.values()],
    targets: [...targets.values()],
  };
}
