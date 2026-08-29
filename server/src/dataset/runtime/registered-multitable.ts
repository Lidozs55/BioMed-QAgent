import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  DatasetExecutionSourceBinding,
  DatasetManifestV2,
  DatasetSchemaV2,
  JsonValue,
  ProductArtifactFact,
  ProductAssessment,
  SourceAssetRegistrationReceipt,
  ManifestArtifactEntry,
  OperationResultManifest,
  PublicationCandidate,
} from "@biomed/contracts";

import {
  RegisteredTableAdapter,
  createDefaultRegisteredTableRegistry,
  type RegisteredTableAdapterResult,
  type RegisteredTableAudit,
  type RegisteredTableRejectedRow,
  type RegisteredTableRow,
  type RegisteredTableSink,
} from "../adapters/registered/index.js";
import { sha256FileStream } from "../adapters/hashing.js";
import { createDefaultFamilyAssemblerRegistry } from "../assembly/index.js";
import type { DatasetExecutionSpec, ValidationResult } from "../contracts/index.js";
import type { DatasetFamilyDefinition } from "../families/index.js";
import {
  createDefaultDatasetFamilyRegistry,
  registeredTableSchemasById,
} from "../families/index.js";
import { packageDigest } from "../publish/manifest.js";
import { promotePublication, type PublishResult } from "../publish/publisher.js";
import { validateMultiTableCandidate } from "../validation/multitable.js";
import { SourceAssetRegistry } from "../../runtime/source-assets/registry.js";
import { providerCarrierBinding } from "./provider-bindings.js";
import { createDefaultProviderCarrierTransformRegistry } from "../families/index.js";
import {
  providerCarrierTransformForFamily,
  type ProviderCarrierTransformInput,
} from "./provider-transforms.js";
import { parseProteinStructureCarrier } from "../families/protein-structure/provider.js";
import { transformChemblRegisteredAssets } from "../families/bioactivity-measurement/chembl.js";
import {
  buildBioactivityIdentity,
  normalizeBioactivityInchiKey,
  parsePubChemIdentityCarrier,
  type BioactivityCompoundInput,
} from "../families/bioactivity-measurement/index.js";
import { transformBioCLiteratureEvidence } from "../families/literature-evidence/provider.js";
import { expandTargetEvidenceJsonCarriers } from "../families/target-evidence/provider-json.js";
import {
  CHART_PAPERS_TABLE_ID,
  CHART_POINTS_TABLE_ID,
  CHART_SERIES_TABLE_ID,
  CHART_SOURCES_TABLE_ID,
  chartEvidenceValidationPolicy,
  evaluateChartEvidencePublication,
  type ChartEvidenceRows,
} from "../families/bioactivity-measurement/chart-evidence/index.js";
const IMPLEMENTATION_DIGEST = createHash("sha256")
  .update("registered_multitable.runtime.v1")
  .digest("hex");

function csvCell(value: unknown): string {
  const text = value === null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

class CanonicalCsvSink implements RegisteredTableSink {
  readonly referencedSourceAssetIds = new Set<string>();
  readonly rows: RegisteredTableRow[] = [];
  result: RegisteredTableAdapterResult | null = null;

  constructor(readonly filePath: string, readonly fields: readonly string[]) {
    mkdirSync(path.dirname(filePath), { recursive: true });
    appendFileSync(filePath, `${fields.join(",")}\n`, "utf8");
  }

  writeRow(row: RegisteredTableRow): void {
    this.rows.push(row);
    const declaredAssetId = row.values.source_asset_id;
    const locator = row.values.source_locator;
    if (typeof declaredAssetId === "string") {
      if (!/^asset_[0-9a-f]{64}$/.test(declaredAssetId)) throw new Error("source_asset_id must be content addressed");
      if (locator !== null && typeof locator === "object" && !Array.isArray(locator) && Reflect.get(locator, "asset_id") !== declaredAssetId) {
        throw new Error("source locator asset does not match source_asset_id");
      }
      this.referencedSourceAssetIds.add(declaredAssetId);
    }
    appendFileSync(this.filePath, `${this.fields.map((field) => csvCell(row.values[field])).join(",")}\n`, "utf8");
  }
  writeRejectedRow(row: RegisteredTableRejectedRow): void { void row; }
  commit(result: RegisteredTableAdapterResult): void { this.result = result; }
  async rollback(): Promise<void> { await rm(this.filePath, { force: true }); }
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function chemblCarrierDocuments(document: Record<string, unknown>): {
  activity: unknown;
  assay: unknown;
  target: unknown;
} {
  if (document.activity !== undefined || document.assay !== undefined || document.target !== undefined) {
    return {
      activity: document.activity ?? document.activities,
      assay: document.assay ?? document.assays,
      target: document.target ?? document.targets,
    };
  }
  if (!Array.isArray(document.activities)) {
    throw new TypeError("ChEMBL carrier must contain activities");
  }
  const records = document.activities.map((value, index) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError(`ChEMBL activity ${index} must be an object`);
    }
    return value as Record<string, unknown>;
  });
  const assays = new Map<string, Record<string, unknown>>();
  const targets = new Map<string, Record<string, unknown>>();
  for (const record of records) {
    const assayId = String(record.assay_chembl_id ?? "");
    const targetId = String(record.target_chembl_id ?? "");
    if (assayId === "" || targetId === "") {
      throw new TypeError("ChEMBL activities require assay_chembl_id and target_chembl_id");
    }
    assays.set(assayId, {
      assay_chembl_id: assayId,
      assay_type: record.assay_type,
      description: record.assay_description,
      assay_organism: record.target_organism,
      target_chembl_id: targetId,
      bao_format: record.bao_format,
    });
    targets.set(targetId, {
      target_chembl_id: targetId,
      target_type: "SINGLE PROTEIN",
      pref_name: record.target_pref_name ?? targetId,
      organism: record.target_organism,
    });
  }
  const pageMeta = document.page_meta ?? { total_count: records.length };
  return {
    activity: { activities: records, page_meta: pageMeta },
    assay: { assays: [...assays.values()], page_meta: { total_count: assays.size } },
    target: { targets: [...targets.values()], page_meta: { total_count: targets.size } },
  };
}

async function tableResult(options: {
  taskId: string;
  runId: string;
  requirementId: string;
  familyId: string;
  tableId: string;
  schema: DatasetSchemaV2;
  relativePath: string;
  absolutePath: string;
  assetIds: readonly string[];
}): Promise<OperationResultManifest> {
  const fileStat = await stat(options.absolutePath);
  const sha256 = await sha256FileStream(options.absolutePath);
  const rowCount = Math.max(0, (await readFile(options.absolutePath, "utf8")).trimEnd().split("\n").length - 1);
  return {
    schema_version: "1.0",
    result_manifest_id: `result_${options.requirementId}_${options.tableId}`,
    task_id: options.taskId,
    run_id: options.runId,
    requirement_id: options.requirementId,
    operation_id: `integrate_${options.tableId}`,
    operation_kind: "integrate",
    operation_attempt_id: `attempt_${options.requirementId}_${options.tableId}`,
    attempt: 1,
    status: "succeeded",
    input_digest: digest([[...options.assetIds].sort(), options.schema.schema_id]),
    parameter_digest: digest({ table_id: options.tableId }),
    implementation_digest: IMPLEMENTATION_DIGEST,
    output_digest: sha256,
    output_kind: "integrated_table",
    output_summary: {
      table_id: options.tableId,
      dataset_family: options.familyId,
      row_granularity: options.schema.row_granularity,
      schema_ref: options.schema.schema_id,
      row_count: rowCount,
      column_count: options.schema.fields.length,
      primary_file_sha256: sha256,
    },
    output_files: [{ relative_path: options.relativePath, size_bytes: fileStat.size, sha256 }],
    dependency_closure: {
      input_asset_ids: [...new Set(options.assetIds)].sort(),
      upstream_result_manifest_ids: [],
      parameter_digest: digest({ table_id: options.tableId }),
      implementation_digest: IMPLEMENTATION_DIGEST,
    },
    commit: { state: "committed", commit_id: `commit_${options.requirementId}_${options.tableId}`, committed_at: new Date().toISOString() },
  };
}

async function artifact(
  outputDir: string,
  relativePath: string,
  role: ManifestArtifactEntry["role"],
  mediaType: string,
): Promise<ManifestArtifactEntry> {
  const absolutePath = path.join(outputDir, ...relativePath.split("/"));
  const fileStat = await stat(absolutePath);
  const sha256 = await sha256FileStream(absolutePath);
  return {
    schema_version: "1.0",
    artifact_id: `artifact_${digest([relativePath, sha256]).slice(0, 32)}`,
    role,
    relative_path: relativePath,
    media_type: mediaType,
    size_bytes: fileStat.size,
    sha256,
  };
}

function candidateRef(candidate: PublicationCandidate) {
  const key = (ref: PublicationCandidate["provenance_refs"][number]) =>
    [ref.result_manifest_id, ref.output_kind, ref.output_file_index, ref.output_file_sha256].join(":");
  return {
    candidate_id: candidate.candidate_id,
    table_ids: candidate.tables.map((table) => table.definition.table_id),
    relation_ids: candidate.relations.map((relation) => relation.relation_id),
    provenance_refs: candidate.provenance_refs.map(key),
    confidence_refs: candidate.confidence_refs.map(key),
    audit_refs: candidate.audit_refs.map(key),
  };
}

export interface RegisteredMultiTableExecutionInput {
  taskId: string;
  taskRoot: string;
  spec: DatasetExecutionSpec;
  /** binding_id -> content-addressed task-owned asset ID */
  registeredAssetIds: Readonly<Record<string, string>>;
  forbiddenRoots?: readonly string[];
  publishedAt?: string;
  runId?: string;
}

export interface RegisteredMultiTableExecutionResult {
  candidate: PublicationCandidate;
  manifest: DatasetManifestV2;
  validation: ValidationResult;
  publication: PublishResult;
  tableResults: Readonly<Record<string, OperationResultManifest>>;
}

type ProviderRows = Readonly<Record<string, readonly object[]>>;

interface BioactivityPubChemCarrier {
  binding: DatasetExecutionSourceBinding;
  receipt: SourceAssetRegistrationReceipt;
  bytes: Buffer;
  expectedCid: number;
}

function positivePubChemCid(binding: DatasetExecutionSourceBinding, spec: DatasetExecutionSpec): number {
  const controlledKeys = ["pubchem", "pubchem_cid", "pubchem_cids", "compound", "compound_id", "compound_ids"];
  const candidates = [
    ...(binding.accession === null ? [] : [binding.accession]),
    ...controlledKeys.flatMap((key) => spec.entities[key] ?? []),
  ].filter((value, index, values) => values.indexOf(value) === index);
  const valid = candidates.filter((value) => /^[1-9][0-9]*$/.test(value));
  if (valid.length !== 1) {
    throw new TypeError("PubChem identity binding requires exactly one positive CID");
  }
  const cid = Number(valid[0]);
  if (!Number.isSafeInteger(cid) || cid <= 0) {
    throw new TypeError("PubChem identity binding CID must be a positive safe integer");
  }
  return cid;
}

function exactChemblIdentityMatch(
  compounds: readonly object[],
  pubchem: BioactivityPubChemCarrier,
): BioactivityCompoundInput {
  const payload = JSON.parse(pubchem.bytes.toString("utf8")) as unknown;
  const property = parsePubChemIdentityCarrier(payload, pubchem.expectedCid);
  const matches = compounds.filter((value): value is BioactivityCompoundInput => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const compound = value as Partial<BioactivityCompoundInput>;
    if (compound.compound_id_namespace !== "chembl_compound" || compound.inchi_key === null || compound.inchi_key === undefined) return false;
    try {
      return normalizeBioactivityInchiKey(compound.inchi_key, "ChEMBL InChIKey") === property.inchiKey;
    } catch {
      return false;
    }
  });
  if (matches.length !== 1) {
    throw new Error("bioactivity identity requires exactly one ChEMBL compound with an exact InChIKey match");
  }
  return matches[0];
}

function jsonCompatible(value: unknown, label: string): JsonValue {
  try {
    const parsed = JSON.parse(JSON.stringify(value)) as unknown;
    if (parsed === undefined) throw new Error("undefined");
    return parsed as JsonValue;
  } catch {
    throw new Error(`provider row field '${label}' is not JSON-compatible`);
  }
}

async function carrierBytes(
  registry: SourceAssetRegistry,
  assetId: string,
): Promise<{ receipt: Awaited<ReturnType<SourceAssetRegistry["register"]>>; bytes: Buffer }> {
  const resolved = await registry.resolveAny(assetId);
  if (resolved.registration_receipt.asset_ref.role !== "carrier" && resolved.registration_receipt.asset_ref.role !== "source") {
    throw new Error("provider dispatch requires a registered source or carrier asset");
  }
  const chunks: Buffer[] = [];
  for await (const chunk of resolved.content) chunks.push(Buffer.from(chunk));
  return { receipt: resolved.registration_receipt, bytes: Buffer.concat(chunks) };
}

function providerRows(input: {
  familyId: string;
  source: string;
  adapterId: string;
  providerId?: string;
  bindingId?: string;
  tableId?: string;
  inputRole?: string;
  schemaRef?: string;
  accession?: string | null;
  parameters?: Readonly<Record<string, JsonValue>>;
  entities?: Readonly<Record<string, readonly string[]>>;
  assetId: string;
  receipt: Awaited<ReturnType<SourceAssetRegistry["register"]>>;
  bytes: Buffer;
}): ProviderRows {
  const carrier = {
    assetId: input.assetId,
    logicalFile: input.receipt.relative_path,
    retrievedAt: input.receipt.registered_at,
    mediaType: input.receipt.media_type,
  };
  if (input.familyId === "protein_structure" && input.source === "pdb" && input.adapterId === "protein.structure.carrier.v1") {
    const rows = parseProteinStructureCarrier({ ...carrier, bytes: input.bytes });
    return { structures: rows.structures, chains: rows.chains, ligands: rows.ligands, sources: rows.sources };
  }
  if (input.familyId === "literature_evidence" && input.source === "pubmed" && input.adapterId === "literature.bioc_xml.v1") {
    const rows = transformBioCLiteratureEvidence({ ...carrier, bytes: input.bytes, sourceDatabase: input.source });
    return { literature_evidence: rows.literature_evidence, papers: rows.papers, sources: rows.sources };
  }
  if (
    input.familyId === "target_evidence" &&
    ((input.source === "uniprot" && input.adapterId === "target.evidence.uniprot.v1") ||
      (input.source === "ncbi_clinvar" && input.adapterId === "target.evidence.clinvar.v1") ||
      (input.source === "clinicaltrials_gov" && input.adapterId === "target.evidence.trials.v1"))
  ) {
    if (input.source !== "uniprot" && input.source !== "ncbi_clinvar" && input.source !== "clinicaltrials_gov") {
      throw new Error(`target provider source '${input.source}' is not supported`);
    }
    const payload = JSON.parse(input.bytes.toString("utf8")) as unknown;
    const rows = expandTargetEvidenceJsonCarriers([{
      ...carrier,
      sourceId: input.receipt.source_id,
      sourceDatabase: input.source,
      payload,
    }]);
    return { targets: rows.targets, evidence: rows.evidence, sources: rows.sources, supporting: rows.supporting };
  }
  if (input.familyId === "bioactivity_measurement" && input.source === "chembl" && input.adapterId === "bioactivity.chembl_json.v1") {
    const document = JSON.parse(input.bytes.toString("utf8")) as Record<string, unknown>;
    const carrier = chemblCarrierDocuments(document);
    const rows = transformChemblRegisteredAssets([
      { kind: "activity", source_id: input.receipt.source_id, source_asset_id: input.assetId, logical_file: input.receipt.relative_path, document: carrier.activity },
      { kind: "assay", source_id: input.receipt.source_id, source_asset_id: input.assetId, logical_file: input.receipt.relative_path, document: carrier.assay },
      { kind: "target", source_id: input.receipt.source_id, source_asset_id: input.assetId, logical_file: input.receipt.relative_path, document: carrier.target },
    ]);
    return { activities: rows.activities, compounds: rows.compounds, assays: rows.assays, targets: rows.targets };
  }
  throw new Error(`unsupported provider carrier binding '${input.familyId}/${input.source}/${input.adapterId}'`);
}

async function writeProviderTables(options: {
  outputDir: string;
  taskId: string;
  runId: string;
  requirementId: string;
  familyId: string;
  schemas: ReadonlyMap<string, DatasetSchemaV2>;
  rows: ProviderRows;
  assetIds: readonly string[];
  allowEmptyTables?: readonly string[];
}): Promise<Record<string, OperationResultManifest>> {
  const results: Record<string, OperationResultManifest> = {};
  for (const [tableId, schema] of options.schemas) {
    const tableRows = options.rows[tableId];
    if (tableRows === undefined || (tableRows.length === 0 && !(options.allowEmptyTables ?? []).includes(tableId))) {
      throw new Error(`provider carrier did not produce required table '${tableId}'`);
    }
    const relativePath = `tables/${tableId}.csv`;
    const absolutePath = path.join(options.outputDir, ...relativePath.split("/"));
    mkdirSync(path.dirname(absolutePath), { recursive: true });
    appendFileSync(absolutePath, `${schema.fields.map((field) => field.name).join(",")}\n`, "utf8");
    for (const row of tableRows) {
      const values = row as Record<string, unknown>;
      appendFileSync(absolutePath, `${schema.fields.map((field) => csvCell(jsonCompatible(values[field.name], `${tableId}.${field.name}`))).join(",")}\n`, "utf8");
    }
    results[tableId] = await tableResult({
      taskId: options.taskId,
      runId: options.runId,
      requirementId: options.requirementId,
      familyId: options.familyId,
      tableId,
      schema,
      relativePath,
      absolutePath,
      assetIds: options.assetIds,
    });
  }
  return results;
}

/** Server-owned fixed registered asset -> parse -> assemble -> B3 -> Publisher capability. */
export async function executeRegisteredMultiTableBuild(
  input: RegisteredMultiTableExecutionInput,
): Promise<RegisteredMultiTableExecutionResult> {
  const runId = input.runId ?? "run_test";
  const familyRegistry = createDefaultDatasetFamilyRegistry();
  const family = familyRegistry.get(input.spec.dataset_family);
  if (family.runtime_id !== "registered_multitable.runtime.v1") {
    throw new Error(`family '${family.id}' does not use the registered multi-table runtime`);
  }
  const outputDir = path.join(input.taskRoot, "dataset_runs", runId, input.spec.requirement_id);
  mkdirSync(path.join(outputDir, "tables"), { recursive: true });
  const assetRegistry = new SourceAssetRegistry(input.taskId, input.taskRoot);
  const parserRegistry = createDefaultRegisteredTableRegistry();
  const tableResults: Record<string, OperationResultManifest> = {};
  const tableRows: Record<string, Record<string, unknown>[]> = {};
  const audits: RegisteredTableAudit[] = [];
  const sourceReceipts = new Map<string, Awaited<ReturnType<SourceAssetRegistry["register"]>>>();
  let assessIdentityArtifacts: ((artifacts: readonly ProductArtifactFact[]) => ProductAssessment) | null = null;
  let productAssessment: ProductAssessment | null = null;
  const providerBindings = input.spec.source_bindings.filter((binding) =>
    providerCarrierBinding(
      family.id,
      binding.source,
      binding.adapter_id,
      undefined,
      binding.acquisition.provider_id,
    ) !== null,
  );
  const providerTransformRegistry = createDefaultProviderCarrierTransformRegistry();
  const familyProviderTransform = providerCarrierTransformForFamily(family.id, providerTransformRegistry);
  if (providerBindings.length > 0) {
    if (providerBindings.length !== input.spec.source_bindings.length) {
      throw new Error("provider carrier dispatch cannot mix provider and registered-table bindings");
    }
    const aggregateRows: Record<string, object[]> = {};
    const assetIds: string[] = [];
    const pubchemCarriers: BioactivityPubChemCarrier[] = [];
    const familyTransformInputs: ProviderCarrierTransformInput[] = [];
    let chemblCarrierCount = 0;
    for (const binding of providerBindings) {
      const provider = providerCarrierBinding(
        family.id,
        binding.source,
        binding.adapter_id,
        undefined,
        binding.acquisition.provider_id,
      );
      if (provider === null) {
        throw new Error(`provider binding '${binding.binding_id}' is not admitted for ${family.id}`);
      }
      const assetId = input.registeredAssetIds[binding.binding_id];
      if (assetId === undefined) throw new Error(`binding '${binding.binding_id}' has no registered carrier asset ID`);
      const resolved = await carrierBytes(assetRegistry, assetId);
      sourceReceipts.set(assetId, resolved.receipt);
      assetIds.push(assetId);
      if (familyProviderTransform !== null) {
        familyTransformInputs.push({
          familyId: family.id,
          source: provider.source,
          adapterId: provider.adapterId,
          providerId: provider.providerId,
          bindingId: binding.binding_id,
          tableId: provider.tableId,
          inputRole: provider.inputRole,
          schemaRef: provider.schemaRefs?.[0],
          accession: binding.accession,
          assetId,
          receipt: resolved.receipt,
          bytes: resolved.bytes,
          parameters: binding.parameters,
          entities: input.spec.entities,
        });
        continue;
      }
      if (family.id === "bioactivity_measurement" &&
          provider.source === "pubchem" &&
          provider.adapterId === "bioactivity.pubchem_identity.v1") {
        pubchemCarriers.push({
          binding,
          receipt: resolved.receipt,
          bytes: resolved.bytes,
          expectedCid: positivePubChemCid(binding, input.spec),
        });
        continue;
      }
      if (family.id === "bioactivity_measurement" &&
          provider.source === "chembl" &&
          provider.adapterId === "bioactivity.chembl_json.v1") {
        chemblCarrierCount += 1;
      }
      const expanded = providerRows({
        familyId: family.id,
        source: provider.source,
        adapterId: provider.adapterId,
        providerId: provider.providerId,
        bindingId: binding.binding_id,
        tableId: provider.tableId,
        inputRole: provider.inputRole,
        schemaRef: provider.schemaRefs?.[0],
        accession: binding.accession,
        assetId,
        receipt: resolved.receipt,
        bytes: resolved.bytes,
        parameters: binding.parameters,
        entities: input.spec.entities,
      });
      for (const [tableId, rows] of Object.entries(expanded)) {
        (aggregateRows[tableId] ??= []).push(...rows);
      }
    }
    if (familyProviderTransform !== null) {
      const expanded = familyProviderTransform(familyTransformInputs);
      for (const [tableId, rows] of Object.entries(expanded)) {
        (aggregateRows[tableId] ??= []).push(...rows);
      }
    }
    if (pubchemCarriers.length > 0) {
      if (family.id !== "bioactivity_measurement" || pubchemCarriers.length !== 1 || chemblCarrierCount !== 1) {
        throw new Error("bioactivity identity requires exactly one ChEMBL and one PubChem provider carrier");
      }
      const pubchem = pubchemCarriers[0]!;
      const chemblCompound = exactChemblIdentityMatch(aggregateRows.compounds ?? [], pubchem);
      const chemblReceipt = [...sourceReceipts.values()].find((receipt) => receipt.source_id === chemblCompound.source_id);
      if (chemblReceipt === undefined) {
        throw new Error("bioactivity identity ChEMBL compound has no registered source receipt");
      }
      const emptyArtifactFacts: ProductArtifactFact[] = [
        { artifact_id: "artifact_compound_identity_pending", role: "compound_identity", sha256: null },
        { artifact_id: "artifact_compound_crosswalk_pending", role: "compound_crosswalk", sha256: null },
      ];
      const document = JSON.parse(pubchem.bytes.toString("utf8")) as unknown;
      const identityInput = {
        task_id: input.taskId,
        chembl_compound: chemblCompound,
        chembl_source: { receipt: chemblReceipt, json_pointer: "/activities/0" },
        pubchem_carrier: {
          receipt: pubchem.receipt,
          json_pointer: "/PropertyTable/Properties/0",
          expected_cid: pubchem.expectedCid,
          document,
        },
      };
      const identityResult = buildBioactivityIdentity(identityInput, emptyArtifactFacts);
      assessIdentityArtifacts = (artifacts) => buildBioactivityIdentity(identityInput, artifacts).assessment;
      if (identityResult.assessment.product_status === "incomplete") {
        throw new Error("bioactivity identity assessment is not semantically publishable");
      }
      const existingCompounds = aggregateRows.compounds ?? [];
      const pubchemCompound = identityResult.compounds[1];
      const pubchemDuplicate = existingCompounds.some((value) => {
        if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
        return Reflect.get(value, "compound_id") === pubchemCompound.compound_id &&
          Reflect.get(value, "compound_id_namespace") === pubchemCompound.compound_id_namespace;
      });
      if (pubchemDuplicate) {
        throw new Error("bioactivity identity PubChem compound duplicates an existing identity");
      }
      aggregateRows.compounds = [...existingCompounds, pubchemCompound];
      aggregateRows.compound_crosswalks = [...identityResult.compound_crosswalks];
    }
    const rows: ProviderRows = aggregateRows;
    const registeredSchemas = registeredTableSchemasById(family);
    const tableSchemas = new Map<string, DatasetSchemaV2>();
    for (const tableId of Object.keys(rows)) {
      const schema = registeredSchemas.get(tableId);
      if (schema !== undefined) tableSchemas.set(tableId, schema);
    }
    for (const tableId of Object.keys(rows)) {
      if (!tableSchemas.has(tableId)) {
        throw new Error(`provider carrier emitted unknown table '${tableId}'`);
      }
    }
    Object.assign(tableResults, await writeProviderTables({
      outputDir,
      taskId: input.taskId,
      runId,
      requirementId: input.spec.requirement_id,
      familyId: family.id,
      schemas: tableSchemas,
      rows,
      assetIds: [...new Set(assetIds)].sort(),
      allowEmptyTables: family.id === "protein_structure" ? ["ligands"] : [],
    }));
    for (const [tableId, providerTableRows] of Object.entries(rows)) {
      tableRows[tableId] = providerTableRows.map((row) => ({ ...(row as Record<string, unknown>) }));
    }
    if (assessIdentityArtifacts !== null) {
      const compoundResult = tableResults.compounds;
      const crosswalkResult = tableResults.compound_crosswalks;
      if (compoundResult === undefined || crosswalkResult === undefined) {
        throw new Error("bioactivity identity tables are missing committed operation results");
      }
      productAssessment = assessIdentityArtifacts([
        {
          artifact_id: `artifact_${compoundResult.result_manifest_id}`,
          role: "compound_identity",
          sha256: compoundResult.output_files[0]?.sha256 ?? null,
        },
        {
          artifact_id: `artifact_${crosswalkResult.result_manifest_id}`,
          role: "compound_crosswalk",
          sha256: crosswalkResult.output_files[0]?.sha256 ?? null,
        },
      ]);
      if (productAssessment.product_status !== "publishable") {
        throw new Error(`bioactivity identity product is not publishable: ${productAssessment.blockers.map((blocker) => blocker.code).join(", ")}`);
      }
    }
  }

  for (const binding of providerBindings.length > 0 ? [] : input.spec.source_bindings) {
    const source = family.sources.find((item) => item.source === binding.source && item.adapter_id === binding.adapter_id);
    if (source?.table_id === undefined) throw new Error(`binding '${binding.binding_id}' has no registered table capability`);
    const assetId = input.registeredAssetIds[binding.binding_id];
    if (assetId === undefined) throw new Error(`binding '${binding.binding_id}' has no registered asset ID`);
    const resolved = await assetRegistry.resolve(assetId);
    sourceReceipts.set(assetId, resolved.registration_receipt);
    const registration = parserRegistry.entries().find((entry) => entry.parser.adapter_id === binding.adapter_id);
    if (registration === undefined) throw new Error(`registered parser '${binding.adapter_id}' is unavailable`);
    const relativePath = `tables/${source.table_id}.csv`;
    const absolutePath = path.join(outputDir, ...relativePath.split("/"));
    const sink = new CanonicalCsvSink(absolutePath, registration.schema.fields.map((field) => field.name));
    const parsed = await new RegisteredTableAdapter(parserRegistry).parse({
      schema_version: "1.0",
      task_id: input.taskId,
      asset_id: assetId,
      schema_ref: source.schema_refs[0],
      adapter_id: binding.adapter_id,
      parser_version: registration.parser.parser_version,
    }, resolved, sink);
    audits.push(parsed.audit);
    tableRows[source.table_id] = sink.rows.map((row) => ({ ...row.values }));
    const rowAssetIds = new Set<string>([assetId]);
    for (const declaredAssetId of sink.referencedSourceAssetIds) {
      const carrier = await assetRegistry.resolve(declaredAssetId);
      sourceReceipts.set(declaredAssetId, carrier.registration_receipt);
      rowAssetIds.add(declaredAssetId);
    }
    tableResults[source.table_id] = await tableResult({
      taskId: input.taskId,
      runId,
      requirementId: input.spec.requirement_id,
      familyId: family.id,
      tableId: source.table_id,
      schema: registration.schema,
      relativePath,
      absolutePath,
      assetIds: [...rowAssetIds],
    });
  }

  const primarySchema = family.schemas.find((schema) => schema.schema_id === input.spec.schema_ref);
  if (primarySchema?.schema_version !== "2.0") throw new Error("registered multi-table build requires a primary Schema 2.0");
  const primaryResult = Object.values(tableResults).find((result) => result.output_summary.schema_ref === primarySchema.schema_id);
  if (primaryResult === undefined) throw new Error("registered multi-table build did not produce its primary schema");
  const registeredAssets = [...sourceReceipts.keys()].sort();
  if (tableResults[CHART_SERIES_TABLE_ID] !== undefined) {
    const missingChartTables = [
      CHART_POINTS_TABLE_ID,
      CHART_PAPERS_TABLE_ID,
      CHART_SOURCES_TABLE_ID,
    ].filter((tableId) => tableResults[tableId] === undefined);
    if (missingChartTables.length > 0) {
      throw new Error(`chart evidence build requires all chart tables; missing: ${missingChartTables.join(", ")}`);
    }
    const chartRows = {
      chart_series: tableRows[CHART_SERIES_TABLE_ID] ?? [],
      chart_points: tableRows[CHART_POINTS_TABLE_ID] ?? [],
      papers: tableRows[CHART_PAPERS_TABLE_ID] ?? [],
      sources: tableRows[CHART_SOURCES_TABLE_ID] ?? [],
    } as unknown as ChartEvidenceRows;
    const activityIds = new Set(
      (tableRows.activities ?? []).flatMap((row) =>
        typeof row.activity_id === "string" ? [row.activity_id] : []),
    );
    const chartGate = evaluateChartEvidencePublication(chartRows, activityIds);
    if (!chartGate.publishable) {
      const chartCheck = {
        check_id: "chart_evidence_gate",
        scope: "chart_evidence",
        passed: false,
        detail: chartGate.checks.map((item) => item.detail).join("; "),
      };
      await writeFile(path.join(outputDir, "validation_report.json"), `${JSON.stringify({
        profile_ref: input.spec.validation_profile_ref,
        checks: [chartCheck],
      }, null, 2)}\n`, "utf8");
      throw new Error(`registered multi-table validation failed: ${chartCheck.scope}:${chartCheck.check_id}: ${chartCheck.detail}`);
    }
  }
  const candidate = createDefaultFamilyAssemblerRegistry().createCapability(family.id).assemble({
    taskId: input.taskId,
    runId,
    requirementId: input.spec.requirement_id,
    datasetFamily: family.id,
    rowGranularity: input.spec.row_granularity,
    schema: primarySchema,
    integrationResult: primaryResult,
    integrationResults: tableResults,
    tableRows,
    registeredAssetIds: registeredAssets,
  });

  const candidateSchemaRefs = new Set(candidate.tables.map((table) => table.definition.schema_ref));
  const schemasByRef = new Map(family.schemas.filter((schema): schema is DatasetSchemaV2 =>
    schema.schema_version === "2.0" && candidateSchemaRefs.has(schema.schema_id),
  ).map((schema) => [schema.schema_id, schema]));
  const validationTables = candidate.tables.map((table) => {
    const result = tableResults[table.definition.table_id];
    const schema = schemasByRef.get(table.definition.schema_ref);
    if (result === undefined || schema === undefined) throw new Error(`candidate table '${table.definition.table_id}' is not backed by a registered result`);
    const refKey = `${result.result_manifest_id}:${result.output_kind}:0:${result.output_files[0]!.sha256}`;
    return {
      definition: table.definition,
      schema,
      file: { origin: "core_operation_result" as const, relative_path: result.output_files[0]!.relative_path, delimiter: "," as const, operation_result: result },
      provenance_refs: [refKey],
      confidence_refs: [refKey],
    };
  });
  const defaultForbiddenRoot = path.join(input.taskRoot, "workspace");
  mkdirSync(defaultForbiddenRoot, { recursive: true });
  const b3 = await validateMultiTableCandidate({
    task_id: input.taskId,
    requirement_id: input.spec.requirement_id,
    candidate: candidateRef(candidate),
    tables: validationTables,
    relations: candidate.relations,
    trusted_root: outputDir,
    forbidden_roots: input.forbiddenRoots === undefined || input.forbiddenRoots.length === 0
      ? [defaultForbiddenRoot]
      : [...input.forbiddenRoots],
    policy: tableResults[CHART_SERIES_TABLE_ID] !== undefined
      ? chartEvidenceValidationPolicy()
      : family.multitable_validation_policy ?? { token_preservation_rules: [], profile_relation_missing_policies: {} },
  });
  const auditPath = path.join(outputDir, "registered_adapter_audit.json");
  await writeFile(auditPath, `${JSON.stringify(audits, null, 2)}\n`, "utf8");
  const provenancePath = path.join(outputDir, "provenance.json");
  await writeFile(provenancePath, `${JSON.stringify({
    runtime_id: family.runtime_id,
    sources: [...sourceReceipts.values()].map((receipt) => ({ source_id: receipt.source_id, asset_id: receipt.asset_ref.asset_id, receipt_id: receipt.receipt_id })),
    tables: Object.fromEntries(Object.entries(tableResults).map(([tableId, result]) => [tableId, result.result_manifest_id])),
  }, null, 2)}\n`, "utf8");
  const schemaPath = path.join(outputDir, "schema.json");
  await writeFile(schemaPath, `${JSON.stringify([...schemasByRef.values()], null, 2)}\n`, "utf8");
  if (productAssessment !== null) {
    await writeFile(
      path.join(outputDir, "product_assessment.json"),
      `${JSON.stringify(productAssessment, null, 2)}\n`,
      "utf8",
    );
  }

  const entries: ManifestArtifactEntry[] = [];
  for (const table of candidate.tables) {
    entries.push(await artifact(outputDir, tableResults[table.definition.table_id]!.output_files[0]!.relative_path,
      table.definition.role === "primary" ? "primary_dataset" : "supporting_dataset", "text/csv"));
  }
  entries.push(await artifact(outputDir, "schema.json", "schema", "application/json"));
  entries.push(await artifact(outputDir, "provenance.json", "provenance", "application/json"));
  entries.push(await artifact(outputDir, "registered_adapter_audit.json", "audit_report", "application/json"));
  if (productAssessment !== null) {
    entries.push(await artifact(outputDir, "product_assessment.json", "audit_report", "application/json"));
  }
  const packageSha = packageDigest(entries);
  const failedChecks = b3.checks.filter((check) => !check.passed);
  const validation: ValidationResult = {
    schema_version: "1.0",
    manifest_digest: packageSha,
    profile_ref: input.spec.validation_profile_ref,
    status: failedChecks.length === 0 ? "passed" : "failed",
    checked_count: b3.checks.length,
    failed_count: failedChecks.length,
    report_path: "validation_report.json",
  };
  await writeFile(path.join(outputDir, "validation_report.json"), `${JSON.stringify({
    profile_ref: validation.profile_ref,
    checks: b3.checks,
    ...(productAssessment === null ? {} : { product_assessment: productAssessment }),
  }, null, 2)}\n`, "utf8");
  const primary = candidate.tables.find((table) => table.definition.role === "primary")!;
  const manifest: DatasetManifestV2 = {
    schema_version: "2.0",
    manifest_id: `manifest_${packageSha.slice(0, 16)}`,
    task_id: input.taskId,
    requirement_id: input.spec.requirement_id,
    dataset_family: family.id,
    row_granularity: input.spec.row_granularity,
    schema_ref: primary.definition.schema_ref,
    primary_key: [...primary.definition.primary_key],
    row_count: primary.row_count,
    sha256: packageSha,
    artifacts: entries,
    source_summary: Object.fromEntries([...sourceReceipts.values()].map((receipt) => [receipt.source_id, { asset_id: receipt.asset_ref.asset_id }])),
    validation_summary: { profile_ref: validation.profile_ref, status: validation.status, checked_count: validation.checked_count, failed_count: validation.failed_count, report_path: validation.report_path },
    confidence_summary: {
      source: "registered_table_schema_and_b3",
      ...(productAssessment === null ? {} : {
        product_status: productAssessment.product_status,
        product_scores: jsonCompatible(productAssessment.scores, "product_assessment.scores"),
        product_blockers: jsonCompatible(productAssessment.blockers, "product_assessment.blockers"),
      }),
    },
    provenance_summary: { source_count: sourceReceipts.size, coverage: { traced_rows: primary.row_count, untraced_rows: 0, coverage_ratio: 1 } },
    tables: candidate.tables.map((table) => table.definition),
    relations: candidate.relations,
    candidate_refs: [candidateRef(candidate)],
  };
  await writeFile(path.join(outputDir, "dataset_manifest.json"), `${JSON.stringify(manifest)}\n`, "utf8");
  if (validation.status !== "passed") throw new Error(`registered multi-table validation failed: ${failedChecks.map((check) => `${check.scope}:${check.check_id}`).join(", ")}`);
  const publication = await promotePublication({
    outputDir,
    manifest,
    validation,
    publicationCandidate: candidate,
    expectedSourceAssetIds: new Set(registeredAssets),
    publishedAt: input.publishedAt,
  });
  return { candidate, manifest, validation, publication, tableResults };
}

export function registeredFamilyRuntimeDefinition(familyId: string): DatasetFamilyDefinition {
  const definition = createDefaultDatasetFamilyRegistry().get(familyId);
  if (definition.runtime_id !== "registered_multitable.runtime.v1") throw new Error("family is not registered for multi-table execution");
  return definition;
}
