/**
 * Gold6 current-HEAD end-to-end closure (vision repair plan Task 8, step 1).
 *
 * Runs the FULL Host route in-process — `createPhase3Runtime` + the durable
 * HTTP API — with fakes only at the external boundaries:
 * - fixed-provider acquisition downloads are served by a fixture acquisition
 *   runtime that keeps the real provider admission (`plan`) and the real
 *   registration receipt/provenance path, but never touches the network;
 * - the visual model is a deterministic local fixture server reached through
 *   the public-URL policy with a fake resolver + local executor;
 * - human decisions arrive through the real durable HIL gate via the HTTP
 *   resume endpoint.
 *
 * Asserted: the byte-identical frozen Gold6 prompt, the frozen execution
 * context carried as system context only, the three frozen PMCIDs acquired as
 * registered carriers, governed registered extraction with accepted AND
 * corrected estimates (correct preserves original values), the six required
 * tables in ONE immutable Publication that survives a simulated Host restart
 * through the durable publication-acceptance continuation (publishing exactly
 * once), and recomputed Artifact API SHA-256 hashes.
 *
 * Route note: the registered-parser product closure (canonical identity
 * derivation, chart review gate, B3) is proven deterministically in
 * `chart-evidence-publication-closure.test.ts`; this test proves the
 * orchestration closure — frozen context -> carriers -> governed extraction ->
 * evidence-bound reviews -> six-table candidate -> real `publication_acceptance`
 * -> restart-safe Publication -> Artifact verification.
 */

import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  computeFamilySpecDigest,
  DEFAULT_RUNTIME_LIMITS,
  parseTaskExecutionContext,
  stableTaskExecutionContextJson,
  type FamilySpec,
  type HILDecision,
  type HILRequest,
  type Projection,
} from "@biomed/contracts";
import { afterEach, describe, expect, test } from "vitest";

import { canonicalDigest } from "../src/dataset/adapters/identity.js";
import {
  CoreAcquisitionRegistry,
  acquisitionRequestIdentity,
  type CoreAcquisitionResult,
} from "../src/dataset/acquisition/runtime.js";
import { createCoreAcquisitionProviders } from "../src/dataset/acquisition/provider-catalog.js";
import { sha256FileStream } from "../src/dataset/adapters/hashing.js";
import { PublicHttpClient } from "../src/external/network/http-client.js";
import type {
  BioMedAgentAdapter,
  BioMedAgentEvent,
  BioMedAgentSession,
  BioMedAgentTool,
  BioMedSessionConfig,
} from "../src/agent/contracts.js";
import { publishDynamicFamily as actualPublish } from "../src/dataset/dynamic-family/publication.js";
import { REGISTERED_PAPER_CHART_PROMPT } from "../src/processing/vlm/registered-paper-chart-extraction.js";
import { readPublicationAcceptanceContinuation } from "../src/runtime/execution-continuation.js";
import {
  createPhase3Runtime,
  type Phase3AcquisitionRuntime,
} from "../src/runtime/phase3-composition.js";
import type { DurableTaskRepository } from "../src/runtime/task-repository.js";
import { SourceAssetRegistry } from "../src/runtime/source-assets/registry.js";
import { PRODUCTION_B3_RESOURCE_POLICY } from "../src/dataset/validation/b3-production-policy.js";
import {
  PUBLIC_IP,
  fakeResolver,
} from "./phase5/helpers.js";

const GOLD_ROOT = path.resolve(import.meta.dirname, "..", "..", "docs", "evaluation", "gold-v1");
const FROZEN_PROMPT_SHA256 = "f30ab31099da23c75a3e0037ee303b8814c7c124bc1e84be149d2c6f4c8fc298";
const PMCIDS = ["PMC10408569", "PMC5355725", "PMC5094958"] as const;
// The governed paper-evidence gate requires a registered supplementary carrier
// for every paper; the fixture acquires one per PMCID (the frozen inventory
// records historical anchors for the first two only, and anchors are
// historical evidence, never acquisition inputs).
const SUPPLEMENT_PMCIDS = PMCIDS;
const REQUIREMENT_ID = "build_gold6_current_head";
const VLM_HOST = "vlm.gold6.fixture";
const VLM_API_KEY = "fixture-vlm-key-not-a-secret";
const VLM_MODEL = "gold6-fake-vision-model";
const VLM_MODEL_VERSION = "gold6-fake-vision-model-2026-08-30";

const roots: string[] = [];
const httpServers: Server[] = [];

afterEach(async () => {
  await Promise.all(httpServers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  for (const root of roots.splice(0)) {
    // Windows temp-dir cleanup can race in-flight async work; retry briefly.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await rm(root, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }
});

function sha256Bytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

interface PaperFixture {
  pmcid: (typeof PMCIDS)[number];
  title: string;
  experimentId: string;
  activityKey: string;
  seriesKey: string;
  points: Array<{ x: string; y: string }>;
}

const PAPERS: PaperFixture[] = [
  {
    pmcid: "PMC10408569",
    title: "Osimertinib resistance mechanisms in EGFR-mutant lung cancer",
    experimentId: "exp_osimertinib_ba_f3",
    activityKey: "act_osimertinib_ic50",
    seriesKey: "osimertinib_dose",
    points: [{ x: "10", y: "88.2" }, { x: "100", y: "41.0" }],
  },
  {
    pmcid: "PMC5355725",
    title: "Afatinib activity profiles in EGFR L858R models",
    experimentId: "exp_afatinib_table2",
    activityKey: "act_afatinib_ic50",
    seriesKey: "afatinib_dose",
    points: [{ x: "1", y: "72.5" }],
  },
  {
    pmcid: "PMC5094958",
    title: "Erlotinib dose-response characterisation in HCC827 cells",
    experimentId: "exp_erlotinib_fig2a",
    activityKey: "act_erlotinib_ic50",
    seriesKey: "erlotinib_dose",
    points: [{ x: "10", y: "64.5" }, { x: "100", y: "22.0" }],
  },
];

/** Deterministic strict-contract VLM page response for one paper. */
function vlmResponseFor(paper: PaperFixture): string {
  return JSON.stringify({
    paper: {
      title: paper.title,
      journal: "Fixture Journal of Oncology",
      publication_date: "2020-04-03",
      authors: ["A. Researcher", "B. Scientist"],
      source_url: `https://pubmed.ncbi.nlm.nih.gov/?term=${paper.pmcid}`,
    },
    experiments: [{
      experiment_id: paper.experimentId,
      protein: "EGFR",
      variant: "L858R",
      construct: "wild-type kinase domain",
      ligand: "erlotinib",
      assay_type: "cellular viability assay",
      cell_line_or_system: "HCC827 cells",
      temperature: "37 C",
      buffer: "complete RPMI",
      incubation_time: "72 h",
      figure_id: "Figure_1",
      table_id: null,
      locator_evidence: `Figure 1 dose-response for ${paper.pmcid}`,
    }],
    activities: [{
      activity_key: paper.activityKey,
      experiment_id: paper.experimentId,
      compound: "Erlotinib",
      protein_variant: "EGFR",
      activity_type: "IC50",
      activity_value: "12.5",
      activity_unit: "nM",
      relation: "<",
      replicate_count: 3,
      error_value: null,
      error_type: null,
      original_text: `erlotinib inhibited EGFR signalling with an IC50 of 12.5 nM (${paper.pmcid})`,
      table_or_figure: "Figure_1",
      row_label: "none",
      column_label: "none",
      confidence_level: "medium",
    }],
    series: [{
      series_key: paper.seriesKey,
      figure_id: "Figure_1",
      series_label: "Erlotinib",
      x_axis_name: "Erlotinib concentration",
      x_axis_unit: "nM",
      y_axis_name: "EGFR activity",
      y_axis_unit: "percent",
      x_scale: "log",
      y_scale: "linear",
      legend_text: "Erlotinib",
      axis_validation_status: "clear",
      legend_validation_status: "clear",
      bbox: [40, 60, 560, 400],
      extraction_confidence: "medium",
      confidence_reason: "Axis labels and legend are legible.",
    }],
    points: paper.points.map((point, index) => ({
      series_key: paper.seriesKey,
      activity_key: paper.activityKey,
      x_value: point.x,
      y_value: point.y,
      point_type: "line_vertex",
      bbox: [200 + index * 40, 180, 212 + index * 40, 192],
      extraction_confidence: "medium",
      confidence_reason: "Marker is visible on the curve.",
    })),
  });
}

/** Minimal one-page PDF with an embedded raster image XObject (L1 tier). */
function fixturePdf(pmcid: string): Buffer {
  const content = Buffer.from(
    `BT /F1 12 Tf 72 720 Td (Figure 1 ${pmcid} dose response with axis and legend) Tj ET\n` +
    "q 72 500 200 200 re W n /Im1 Do Q\n",
    "utf8",
  );
  const image = Buffer.from([0x80, 0x40, 0xc0, 0x20]);
  const objects: Buffer[] = [
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>", "utf8"),
    Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "utf8"),
    Buffer.from(
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] " +
      "/Resources << /Font << /F1 5 0 R >> /XObject << /Im1 6 0 R >> >> /Contents 4 0 R >>",
      "utf8",
    ),
    Buffer.concat([
      Buffer.from(`<< /Length ${content.length} >>\nstream\n`, "utf8"),
      content,
      Buffer.from("\nendstream", "utf8"),
    ]),
    Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", "utf8"),
    Buffer.concat([
      Buffer.from(
        "<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceGray " +
        "/BitsPerComponent 8 /Length 4 >>\nstream\n",
        "utf8",
      ),
      image,
      Buffer.from("\nendstream", "utf8"),
    ]),
  ];
  const parts: Buffer[] = [Buffer.from("%PDF-1.4\n", "utf8")];
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(parts.reduce((sum, part) => sum + part.length, 0));
    parts.push(Buffer.from(`${index + 1} 0 obj\n`, "utf8"), body, Buffer.from("\nendobj\n", "utf8"));
  });
  const xrefPosition = parts.reduce((sum, part) => sum + part.length, 0);
  parts.push(Buffer.from(`xref\n0 ${objects.length + 1}\n`, "utf8"));
  parts.push(Buffer.from("0000000000 65535 f \n", "utf8"));
  for (const offset of offsets) {
    parts.push(Buffer.from(`${String(offset).padStart(10, "0")} 00000 n \n`, "utf8"));
  }
  parts.push(Buffer.from(
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPosition}\n%%EOF\n`,
    "utf8",
  ));
  return Buffer.concat(parts);
}

function fixtureSupplementArchive(pmcid: string): Buffer {
  return Buffer.from(`supplementary archive for ${pmcid}\ncompound,value\nErlotinib,12.5\n`, "utf8");
}

function fixtureFullTextXml(pmcid: string, paper: PaperFixture): Buffer {
  return Buffer.from(
    `<?xml version="1.0" encoding="UTF-8"?>\n<article><front><article-title>${paper.title}</article-title>` +
    `<article-id pub-id-type="pmc">${pmcid}</article-id></front></article>\n`,
    "utf8",
  );
}

/**
 * Provider-boundary fixture: real provider admission (`plan`), real registration
 * receipts and Core acquisition provenance, deterministic fixture bytes instead
 * of a network download.
 */
function createFixtureAcquisitionRuntime(options: {
  taskId: string;
  taskRoot: string;
  sourceAssetRegistry: SourceAssetRegistry;
}): Phase3AcquisitionRuntime {
  const registry = new CoreAcquisitionRegistry();
  for (const provider of createCoreAcquisitionProviders()) registry.registerProvider(provider);
  const registerCarrier = async (
    rawRequest: Parameters<Phase3AcquisitionRuntime["acquire"]>[0],
  ): Promise<CoreAcquisitionResult> => {
    const handler = registry.resolve(rawRequest, options.taskId).handler;
    const plan = await handler.plan(rawRequest);
    const requestIdentityDigest = acquisitionRequestIdentity(rawRequest, handler.implementationDigest);
    const accession = String(rawRequest.parameters.accession);
    const isPdf = plan.filename.endsWith(".pdf");
    const isXml = plan.filename.endsWith(".xml");
    const paper = PAPERS.find((candidate) => candidate.pmcid === accession);
    if (isXml && paper === undefined) throw new Error(`fixture paper ${accession} was not found`);
    const bytes = isPdf
      ? fixturePdf(accession)
      : isXml
        ? fixtureFullTextXml(accession, paper!)
        : fixtureSupplementArchive(accession);
    const extension = isPdf ? "pdf" : isXml ? "xml" : "zip";
    const mediaType = isPdf ? "application/pdf" : isXml ? "application/xml" : "application/zip";
    const relativePath = `source_assets/fixture_carrier_${accession}.${extension}`;
    await mkdir(path.dirname(path.join(options.taskRoot, ...relativePath.split("/"))), { recursive: true });
    await writeFile(path.join(options.taskRoot, ...relativePath.split("/")), bytes);
    const receipt = await options.sourceAssetRegistry.register({
      sourceId: `fixture_${handler.providerId.replaceAll(".", "_")}_${accession}`,
      relativePath,
      role: "carrier",
      mediaType,
    });
    await options.sourceAssetRegistry.registerCoreAcquisitionProvenance(receipt, {
      provider_id: handler.providerId,
      implementation_digest: handler.implementationDigest,
      request_identity_digest: requestIdentityDigest,
      canonical_accession: accession,
      provider_snapshot_identity: `${handler.providerId}:fixture`,
    });
    return {
      requestIdentityDigest,
      attempts: [],
      sourceAsset: receipt.asset_ref,
      extractionAssets: [],
    };
  };
  return {
    plan: async (rawRequest) => {
      const { handler } = registry.resolve(rawRequest, options.taskId);
      await handler.plan(rawRequest);
      return {
        requestIdentityDigest: acquisitionRequestIdentity(rawRequest, handler.implementationDigest),
        providerId: handler.providerId,
        implementationDigest: handler.implementationDigest,
        recipe: null,
      };
    },
    acquire: registerCarrier,
  };
}

async function executeTool(
  tools: readonly BioMedAgentTool[],
  name: string,
  args: Record<string, unknown>,
  callIndex: number,
): Promise<Record<string, unknown>> {
  const tool = tools.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`tool ${name} is not composed`);
  const result = await tool.execute(args, undefined, { toolCallId: `call_${name}_${callIndex}` });
  const parsed = JSON.parse(result.content) as Record<string, unknown>;
  if (result.isError === true || parsed.ok === false || parsed.status === "error") {
    throw new Error(`${name} failed: ${result.content.slice(0, 500)}`);
  }
  return parsed;
}

const TABLE_FIELDS: Record<string, string[]> = {
  paper_records: ["paper_key", "pmcid", "pmid", "doi", "title", "journal", "publication_date", "source_id"],
  experiment_records: ["experiment_id", "paper_id", "protein", "ligand", "assay_type", "figure_id"],
  activity_value_records: ["activity_key", "experiment_id", "compound", "protein_variant", "activity_type", "activity_value", "activity_unit", "relation", "original_text", "confidence_level"],
  chart_series: ["chart_series_id", "paper_id", "figure_id", "series_label", "x_axis_name", "x_axis_unit", "y_axis_name", "y_axis_unit", "axis_validation_status", "legend_validation_status", "human_review_status", "model_name", "model_version"],
  chart_points: ["point_id", "chart_series_id", "activity_id", "x_value", "y_value", "estimated_or_exact", "review_status", "review_id", "original_x_value", "original_y_value"],
  supplementary_asset_records: ["paper_id", "asset_name", "asset_type", "sha256", "parse_status"],
};
const TABLE_IDS = Object.keys(TABLE_FIELDS);

/**
 * Deterministic, admission-safe transform: destructuring and dot paths only
 * (no bracket access), JSON.parse for the registered carrier bytes, and the
 * exact declared_output_tables as CSV wire envelopes.
 */
const TRANSFORM_SOURCE = [
  "export const transform = {",
  "  run({ inputs }) {",
  "    const cell = (value) => {",
  "      const text = value === null || value === undefined ? \"\" : String(value);",
  "      if (text.includes(\",\") || text.includes(\"\\\"\") || text.includes(\"\\n\")) {",
  "        return \"\\\"\" + text.replaceAll(\"\\\"\", \"\\\"\\\"\") + \"\\\"\";",
  "      }",
  "      return text;",
  "    };",
  "    const csv = (header, rows, project) => {",
  "      const lines = [header.join(\",\")];",
  "      for (const row of rows) {",
  "        lines.push(project(row).map(cell).join(\",\"));",
  "      }",
  "      return lines.join(\"\\n\") + \"\\n\";",
  "    };",
  "    const carriers = inputs.map((input) => JSON.parse(input.text));",
  "    const paperRows = carriers.flatMap((carrier) => carrier.paper_records);",
  "    const experimentRows = carriers.flatMap((carrier) => carrier.experiment_records);",
  "    const activityRows = carriers.flatMap((carrier) => carrier.activity_value_records);",
  "    const seriesRows = carriers.flatMap((carrier) => carrier.chart_series);",
  "    const pointRows = carriers.flatMap((carrier) => carrier.chart_points);",
  "    const supplementRows = carriers.flatMap((carrier) => carrier.supplementary_asset_records);",
  "    const outputs = [];",
  "    const addTable = (handle, tableId, schemaRef, rows, header, project) => {",
  "      outputs.push({ handle, table_id: tableId, schema_ref: schemaRef, locator_ref: inputs.at(0).receipt_id, content: csv(header, rows, project), row_count: rows.length });",
  "    };",
  "    addTable(\"out_0\", \"paper_records\", \"gold6_dynamic.paper_records.v1\", paperRows, [\"paper_key\", \"pmcid\", \"pmid\", \"doi\", \"title\", \"journal\", \"publication_date\", \"source_id\"], (row) => [row.paper_key, row.pmcid, row.pmid, row.doi, row.title, row.journal, row.publication_date, row.source_id]);",
  "    addTable(\"out_1\", \"experiment_records\", \"gold6_dynamic.experiment_records.v1\", experimentRows, [\"experiment_id\", \"paper_id\", \"protein\", \"ligand\", \"assay_type\", \"figure_id\"], (row) => [row.experiment_id, row.paper_id, row.protein, row.ligand, row.assay_type, row.source_locator.figure_id]);",
  "    addTable(\"out_2\", \"activity_value_records\", \"gold6_dynamic.activity_value_records.v1\", activityRows, [\"activity_key\", \"experiment_id\", \"compound\", \"protein_variant\", \"activity_type\", \"activity_value\", \"activity_unit\", \"relation\", \"original_text\", \"confidence_level\"], (row) => [row.activity_key, row.experiment_id, row.compound, row.protein_variant, row.activity_type, row.activity_value, row.activity_unit, row.relation, row.original_text, row.confidence_level]);",
  "    addTable(\"out_3\", \"chart_series\", \"gold6_dynamic.chart_series.v1\", seriesRows, [\"chart_series_id\", \"paper_id\", \"figure_id\", \"series_label\", \"x_axis_name\", \"x_axis_unit\", \"y_axis_name\", \"y_axis_unit\", \"axis_validation_status\", \"legend_validation_status\", \"human_review_status\", \"model_name\", \"model_version\"], (row) => [row.chart_series_id, row.paper_id, row.source_locator.figure_id, row.series_label, row.x_axis_name, row.x_axis_unit, row.y_axis_name, row.y_axis_unit, row.axis_validation_status, row.legend_validation_status, row.human_review_status, row.model_name, row.model_version]);",
  "    addTable(\"out_4\", \"chart_points\", \"gold6_dynamic.chart_points.v1\", pointRows, [\"point_id\", \"chart_series_id\", \"activity_id\", \"x_value\", \"y_value\", \"estimated_or_exact\", \"review_status\", \"review_id\", \"original_x_value\", \"original_y_value\"], (row) => [row.point_id, row.chart_series_id, row.activity_id, row.x_value, row.y_value, row.estimated_or_exact, row.review_status, row.review_id, row.original_x_value, row.original_y_value]);",
  "    addTable(\"out_5\", \"supplementary_asset_records\", \"gold6_dynamic.supplementary_asset_records.v1\", supplementRows, [\"paper_id\", \"asset_name\", \"asset_type\", \"sha256\", \"parse_status\"], (row) => [row.paper_id, row.asset_name, row.asset_type, row.sha256, row.parse_status]);",
  "    return { outputs };",
  "  },",
  "};",
].join("\n");

async function buildSubmission(carrierAssetIds: string[]): Promise<Record<string, unknown>> {
  const projection: Projection = {
    projection_id: "projection_gold6_closure",
    schema_version: "2.0",
    primary_tables: ["paper_records"],
    supporting_tables: ["experiment_records", "activity_value_records", "chart_series", "chart_points", "supplementary_asset_records"],
    derived_tables: [],
    required: [...TABLE_IDS],
    optional: [],
    allow_empty: [],
    relations: [],
    row_granularity: "paper_experiment_activity_chart_product",
    compatibility_dimensions: [],
    merge_identity_fields: ["paper_key"],
    validation_policy_ref: "policy_validation",
    assessment_policy_ref: "policy_assessment",
  };
  const unsignedFamily: FamilySpec = {
    family_spec_id: "family_gold6_current_head",
    semantic_version: "1.0.0",
    canonical_digest: "0".repeat(64),
    projections: [projection],
    table_definitions: TABLE_IDS.map((tableId) => ({
      table_id: tableId,
      schema_ref: `gold6_dynamic.${tableId}.v1`,
      role: tableId === "paper_records" ? "primary" as const : "supporting" as const,
      required: true,
      allow_empty: false,
      primary_key: [
        tableId === "paper_records" ? "paper_key"
        : tableId === "experiment_records" ? "experiment_id"
        : tableId === "activity_value_records" ? "experiment_id"
        : tableId === "chart_series" ? "chart_series_id"
        : tableId === "chart_points" ? "point_id"
        : "sha256",
      ],
      field_names: TABLE_FIELDS[tableId] ?? [],
    })),
    relations: [],
    identity: {
      dataset_id_scheme: "ds_hash",
      dataset_revision_id_scheme: "dsrev_hash",
      asset_id_scheme: "asset_sha256",
      sample_identity_fields: ["dataset_revision_id", "sample_id"],
      probe_mapping_assertion_pk: "mapping_assertion_id",
    },
    transform_capability_refs: [],
    declared_outputs: TABLE_IDS.map((tableId) => ({
      table_id: tableId,
      schema_ref: `gold6_dynamic.${tableId}.v1`,
    })),
    integration_policy_ref: "policy_integration",
    validation_policy_ref: "policy_validation",
    assessment_policy_ref: "policy_assessment",
    resource_class_request: "small",
    scope: "task",
    author: "agent",
    evidence_refs: [],
  };
  const family = { ...unsignedFamily, canonical_digest: await computeFamilySpecDigest(unsignedFamily) };
  return {
    schema_version: "1.0",
    execution_backend: "in_process_unisolated",
    family_spec: family,
    projection_id: projection.projection_id,
    transform_source: TRANSFORM_SOURCE,
    transform_metadata: {
      transform_id: "transform_gold6_current_head",
      version: "1.0.0",
      entrypoint: "transform.run",
      declared_input_roles: carrierAssetIds.map((_, index) => ({
        role: `carrier_${index}`,
        media_type: "application/json",
        constraint_ref: null,
      })),
      declared_output_tables: TABLE_IDS.map((tableId) => ({
        table_id: tableId,
        schema_ref: `gold6_dynamic.${tableId}.v1`,
      })),
      bound_family_spec_digest: family.canonical_digest,
      bound_projection_digest: canonicalDigest(projection),
      determinism_profile: "deterministic",
      resource_class: "small",
      origin: "agent",
      scope: "task",
      review_refs: [],
    },
    registered_sources: Object.fromEntries(
      carrierAssetIds.map((assetId, index) => [`carrier_${index}`, assetId]),
    ),
    acquisition_requests: {},
    execution_proposal: {
      schema_version: "2.0",
      spec_kind: "proposal",
      requirement_id: REQUIREMENT_ID,
      family_spec_ref: {
        scope: "task",
        id: family.family_spec_id,
        version: family.semantic_version,
        digest: family.canonical_digest,
      },
      projection_ref: projection.projection_id,
      transform_refs: [{
        scope: "task",
        id: "transform_gold6_current_head",
        version: "1.0.0",
        digest: "f".repeat(64),
      }],
      policy_refs: [],
      output_format: "long_table",
      idempotency_identity: "gold6_current_head_closure",
      source_bindings: carrierAssetIds.map((_, index) => ({
        binding_id: `carrier_${index}`,
        source: "registered_paper_chart_evidence",
        input_requirement_ref: `carrier_${index}`,
        parameters: {},
      })),
    },
  };
}

interface PendingReview {
  requestId: string;
  evidenceDigest: string;
  kind: string;
  reviewType: string | null;
  firstItemId: string | null;
}

type RepositoryLike = Pick<DurableTaskRepository, "listEvents">;

async function pendingReviews(
  repository: RepositoryLike,
  taskId: string,
  runId: string,
): Promise<PendingReview[]> {
  const events = await repository.listEvents(taskId, 0);
  const resumed = new Set(events.flatMap((event) =>
    event.run_id === runId && event.payload.type === "user_input_resumed"
      ? [event.payload.request_id]
      : []));
  return events.flatMap((event) => {
    if (event.run_id !== runId || event.payload.type !== "user_input_required") return [];
    const request = event.payload.hil_request;
    if (request === null || request === undefined || resumed.has(request.request_id)) return [];
    return [{
      requestId: request.request_id,
      evidenceDigest: request.evidence_digest,
      kind: request.kind,
      reviewType: request.review_type,
      firstItemId: request.review_items[0]?.item_id ?? null,
    }];
  });
}

async function resumeWithDecision(options: {
  base: string;
  taskId: string;
  runId: string;
  review: PendingReview;
  decision: HILDecision;
}): Promise<void> {
  const response = await fetch(
    `${options.base}/api/v1/tasks/${options.taskId}/runs/${options.runId}/resume`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        request_id: options.review.requestId,
        evidence_digest: options.review.evidenceDigest,
        decision: options.decision,
        reason: options.decision.action === "correct"
          ? "corrected the interpolated y coordinate"
          : null,
      }),
    },
  );
  expect([200, 409]).toContain(response.status);
  if (response.status === 409) {
    throw new Error(`resume rejected for ${options.review.requestId}: ${await response.text()}`);
  }
}

async function waitAndResume(options: {
  repository: RepositoryLike;
  base: string;
  taskId: string;
  runId: string;
  match: (review: PendingReview) => boolean;
  decision: (review: PendingReview) => HILDecision;
  timeoutMs?: number;
  lastError?: () => string | null;
}): Promise<PendingReview> {
  const deadline = Date.now() + (options.timeoutMs ?? 60_000);
  for (;;) {
    const reviews = await pendingReviews(options.repository, options.taskId, options.runId);
    const review = reviews.find(options.match);
    if (review !== undefined) {
      await resumeWithDecision({
        base: options.base,
        taskId: options.taskId,
        runId: options.runId,
        review,
        decision: options.decision(review),
      });
      return review;
    }
    const runError = options.lastError?.() ?? null;
    if (runError !== null) {
      throw new Error(`gold6 scripted run failed before the next review: ${runError}`);
    }
    if (Date.now() > deadline) {
      const all = await options.repository.listEvents(options.taskId, 0);
      const summary = all.map((event) => `${event.sequence}:${event.payload.type}`).join(" ");
      const failure = all.find((event) => event.payload.type === "run_failed");
      const failureMessage = failure !== undefined && failure.payload.type === "run_failed"
        ? String(failure.payload.error)
        : null;
      throw new Error(
        `timed out waiting for a pending review to resolve via the HIL resume endpoint; events: ${summary}` +
        (failureMessage === null ? "" : `; last failure: ${failureMessage}`),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

interface StartedRuntime {
  runtime: Awaited<ReturnType<typeof createPhase3Runtime>>;
  server: Server;
  base: string;
}

function startRuntime(options: {
  tasksRoot: string;
  workspacesRoot: string;
  vlmHttpClient: PublicHttpClient;
  adapter: BioMedAgentAdapter;
}): Promise<StartedRuntime> {
  return (async () => {
    const runtime = await createPhase3Runtime({
      tasksRoot: options.tasksRoot,
      workspacesRoot: options.workspacesRoot,
      repositoryRoot: path.resolve("."),
      agentExecPolicy: null,
      adapter: options.adapter,
      database: null,
      browserPool: null,
      resolveRuntimeLimits: () => ({ ...DEFAULT_RUNTIME_LIMITS, build_timeout_seconds: 120 }),
      resolveVlmConfig: async () => ({
        apiKey: VLM_API_KEY,
        baseUrl: `https://${VLM_HOST}/v1`,
        model: VLM_MODEL,
      }),
      vlmHttpClient: options.vlmHttpClient,
      dynamicFamilySeams: {
        resolveProductRequirements: () => ({
          schema_version: "1.0",
          profile_ref: "policy_assessment",
          dataset_family: "family_gold6_current_head",
          tables: TABLE_IDS.map((tableId) => ({
            table_id: tableId,
            role: tableId === "paper_records" ? "primary" as const : "supporting" as const,
            schema_ref: `gold6_dynamic.${tableId}.v1`,
            min_rows: 1,
          })),
          relations: [],
        }),
        createAcquisitionRuntime: ({ taskId, taskRoot, sourceAssetRegistry }) =>
          createFixtureAcquisitionRuntime({ taskId, taskRoot, sourceAssetRegistry }),
        // The evaluation harness runs beside a loaded vitest worker; give the
        // B3 resource baseline the same configured-heap budget a real Host
        // process has instead of the conservative single-purpose default.
        publishDynamicFamily: async (input) => actualPublish({
          ...input,
          signal: input.signal ?? new AbortController().signal,
          b3Validation: {
            policy: PRODUCTION_B3_RESOURCE_POLICY,
            configuredHeapBytes: 4 * 1024 * 1024 * 1024,
            configuredTempBytes: 32 * 1024 * 1024 * 1024,
          },
        }),
      },
    });
    const server = createServer((request, response) => {
      if (!runtime.handle(request, response)) response.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("gold6 e2e server failed to bind");
    return { runtime, server, base: `http://127.0.0.1:${address.port}` };
  })();
}

describe("Gold6 current-HEAD closure (fake providers, fake VLM, real HIL)", () => {
  test("closes the frozen prompt through governed extraction, six-table publication, restart-safe acceptance, and artifact hashes", { timeout: 300_000 }, async () => {
    const tasksRoot = await mkdtemp(path.join(os.tmpdir(), "gold6-e2e-tasks-"));
    roots.push(tasksRoot);
    const workspacesRoot = await mkdtemp(path.join(os.tmpdir(), "gold6-e2e-workspaces-"));
    roots.push(workspacesRoot);

    // -- Frozen inputs: byte-identical prompt and its execution context.
    const promptBytes = await readFile(path.join(GOLD_ROOT, "prompts", "gold6.txt"));
    expect(sha256Bytes(promptBytes)).toBe(FROZEN_PROMPT_SHA256);
    const manifestPath = path.join(GOLD_ROOT, "manifest.json");
    const caseSpecPath = path.join(GOLD_ROOT, "cases", "gold6.json");
    const runtimeProfilePath = path.join(GOLD_ROOT, "runtime-defaults.json");
    const sourcesPath = path.join(GOLD_ROOT, "sources", "gold6.sources.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { manifest_id: string };
    const caseSpec = JSON.parse(await readFile(caseSpecPath, "utf8")) as {
      case_id: string;
      expected_family: string;
      required_tables: string[];
      allowed_sources: string[];
      success_definition: string;
      forbidden_shortcuts: string[];
    };
    const sources = JSON.parse(await readFile(sourcesPath, "utf8")) as {
      selection_constraints: Record<string, string[]>;
    };
    const executionContext = {
      schema_version: "1.0",
      kind: "frozen_evaluation",
      manifest_id: manifest.manifest_id,
      case_id: caseSpec.case_id,
      manifest_sha256: sha256Bytes(await readFile(manifestPath)),
      case_spec_sha256: sha256Bytes(await readFile(caseSpecPath)),
      prompt_sha256: sha256Bytes(promptBytes),
      runtime_profile_sha256: sha256Bytes(await readFile(runtimeProfilePath)),
      expected_family: caseSpec.expected_family,
      required_tables: caseSpec.required_tables,
      allowed_sources: caseSpec.allowed_sources,
      source_selection: sources.selection_constraints,
      success_definition: caseSpec.success_definition,
      forbidden_shortcuts: caseSpec.forbidden_shortcuts,
    };
    const parsedContext = parseTaskExecutionContext(executionContext, "execution_context");
    expect(parsedContext.required_tables).toEqual([
      "paper_records",
      "experiment_records",
      "activity_value_records",
      "chart_series",
      "chart_points",
      "supplementary_asset_records",
    ]);
    expect(parsedContext.source_selection.papers).toEqual([...PMCIDS]);

    // -- Deterministic fake visual model, stubbed fully in-process at the
    // HTTP transport boundary (the URL still passes the public-URL policy).
    interface CapturedVlmCall {
      url: string;
      authorization: string | undefined;
      model: string;
      prompt: string;
      hasImage: boolean;
    }
    const capturedVlmCalls: CapturedVlmCall[] = [];
    const vlmResponses = PAPERS.map(vlmResponseFor);
    const vlmHttpClient = new PublicHttpClient({
      resolve: fakeResolver({ [VLM_HOST]: [PUBLIC_IP] }),
      executor: async (request) => {
        const bodyText = request.body === null ? "" : request.body.toString("utf8");
        const parsed = JSON.parse(bodyText) as {
          model: string;
          messages: Array<{ content: Array<{ type: string; text?: string; image_url?: { url: string } }> }>;
        };
        const textPart = parsed.messages[0]?.content.find((part) => part.type === "text");
        const responseIndex = capturedVlmCalls.length;
        capturedVlmCalls.push({
          url: request.url.toString(),
          authorization: request.headers.authorization,
          model: parsed.model,
          prompt: textPart?.text ?? "",
          hasImage: parsed.messages[0]?.content.some((part) => part.type === "image_url") === true,
        });
        const content = vlmResponses[responseIndex % vlmResponses.length];
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: (async function* () {
            yield Buffer.from(JSON.stringify({
              model: VLM_MODEL_VERSION,
              choices: [{ message: { content } }],
            }), "utf8");
          })(),
        };
      },
      timeoutMs: 30_000,
    });

    // -- Scripted non-visual agent driving the REAL composed tools.
    const bridge = {
      runInput: "",
      systemContext: null as string | null,
      lastError: null as string | null,
    };
    const scriptedAdapter: BioMedAgentAdapter = {
      async createSession(config: BioMedSessionConfig): Promise<BioMedAgentSession> {
        const tools = config.tools ?? [];
        const taskRoot = path.join(tasksRoot, config.taskId);
        bridge.systemContext = config.systemContext ?? null;
        const xmlAssetIds: Record<string, string> = {};
        const pdfAssetIds: Record<string, string> = {};
        const supplementAssetIds: Record<string, string> = {};
        const reviewedCarrierIds: string[] = [];
        const run = async function* (input: string): AsyncIterable<BioMedAgentEvent> {
          bridge.runInput = input;
          let callIndex = 0;
          try {
            yield { type: "turn_started" };

            // 1. Acquire the frozen PMCIDs as registered Core XML/PDF/ZIP
            // carriers through the real acquisition-only tool (provider
            // downloads are faked, but receipts and provenance are real).
            for (const paper of PAPERS) {
              const xml = await executeTool(tools, "acquire_core_carrier", {
                provider_id: "europepmc.fulltext_xml.v1",
                source: "europepmc_fulltext_xml",
                accession: paper.pmcid,
              }, callIndex++);
              xmlAssetIds[paper.pmcid] = xml.carrier_asset_id as string;
              const pdf = await executeTool(tools, "acquire_core_carrier", {
                provider_id: "europepmc.pdf.v1",
                source: "europepmc_pdf",
                accession: paper.pmcid,
              }, callIndex++);
              pdfAssetIds[paper.pmcid] = pdf.carrier_asset_id as string;
            }
            for (const pmcid of SUPPLEMENT_PMCIDS) {
              const parsed = await executeTool(tools, "acquire_core_carrier", {
                provider_id: "europepmc.supplementary.v1",
                source: "europepmc_supplementary",
                accession: pmcid,
              }, callIndex++);
              supplementAssetIds[pmcid] = parsed.carrier_asset_id as string;
            }

            // 2. Governed registered extraction per paper. The FIRST call
            // suspends on the coalesced credential approval; every call then
            // suspends on its ONE evidence-bound data_review.
            for (const paper of PAPERS) {
              const parsed = await executeTool(tools, "extract_registered_paper_chart_evidence", {
                paper_xml_asset_id: xmlAssetIds[paper.pmcid],
                paper_pdf_asset_id: pdfAssetIds[paper.pmcid],
                supplementary_asset_ids: supplementAssetIds[paper.pmcid] === undefined
                  ? []
                  : [supplementAssetIds[paper.pmcid]],
                paper_id: paper.pmcid,
                paper_id_namespace: "pmc",
              }, callIndex++);
              const reviewed = parsed.reviewed_carrier as
                | { asset_id: string; relative_path: string; sha256: string }
                | undefined;
              if (reviewed === undefined) {
                throw new Error("governed extraction did not return the review-closed publication carrier");
              }
              const carrierText = await readFile(
                path.join(taskRoot, ...reviewed.relative_path.split("/")),
                "utf8",
              );
              expect(sha256Bytes(Buffer.from(carrierText, "utf8"))).toBe(reviewed.sha256);
              const reviewedRows = JSON.parse(carrierText) as Record<string, unknown[]>;
              const expectedStatus = paper === PAPERS[2] ? "corrected" : "accepted";
              for (const point of reviewedRows.chart_points as Array<Record<string, unknown>>) {
                expect(point.review_status).toBe(expectedStatus);
                expect(point.estimated_or_exact).toBe("estimated");
                expect(String(point.review_id)).toMatch(/^review_/);
              }
              reviewedCarrierIds.push(reviewed.asset_id);
            }
            expect(reviewedCarrierIds).toHaveLength(PAPERS.length);

            // 3. Bind the review-closed carriers and publish the six-table
            // product; the real publication_acceptance review suspends here.
            const raw = await buildSubmission(reviewedCarrierIds);
            const prepared = await executeTool(tools, "prepare_dynamic_family_publication", raw, callIndex++);
            const receipt = prepared.preflight_receipt as { host_descriptor_digest: string };
            const submitPayload = structuredClone(raw) as Record<string, unknown>;
            const proposal = submitPayload.execution_proposal as {
              transform_refs: Array<{ digest: string }>;
            };
            proposal.transform_refs[0]!.digest = receipt.host_descriptor_digest;
            submitPayload.preflight_receipt = receipt;
            yield { type: "assistant_delta", delta: "submitting the gold6 candidate" };
            const submitted = await executeTool(tools, "submit_dynamic_family_publication", submitPayload, callIndex++);
            expect(submitted.status).toBe("published");
            yield { type: "turn_completed" };
          } catch (error) {
            bridge.lastError = error instanceof Error ? error.message : String(error);
            throw error;
          }
        };
        return {
          piSessionId: `pi_gold6_${config.taskId}`,
          taskId: config.taskId,
          runId: config.runId,
          run,
          cancel: async () => undefined,
          steer: async () => undefined,
          dispose: async () => undefined,
        };
      },
    };

    const runtimeA = await startRuntime({
      tasksRoot,
      workspacesRoot,
      vlmHttpClient,
      adapter: scriptedAdapter,
    });

    const admitted = await fetch(`${runtimeA.base}/api/v1/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        request_id: "gold6-current-head-e2e",
        input: promptBytes.toString("utf8"),
        databases: [],
        mode: "agent",
        execution_context: executionContext,
      }),
    });
    expect(admitted.status).toBe(202);
    const accepted = (await admitted.json()) as { task_id: string; run_id: string };

    // The frozen user prompt is delivered unmodified; the frozen context is
    // bound to the session as durable system context (the Pi adapter wraps it
    // in the delimited section — that wrapping is covered by pi-adapter.test).
    expect(bridge.runInput).toBe(promptBytes.toString("utf8"));
    expect(bridge.systemContext).toBe(stableTaskExecutionContextJson(parsedContext));

    // Review routing: each governed extraction call carries its own credential
    // approval (run+operation coalescing covers concurrent callers — proven by
    // the T6 approval-gate tests) followed by ONE evidence-bound data_review.
    // Papers A + B estimates are accepted; paper C is corrected (originals
    // preserved).
    let extractionCall = 0;
    for (let round = 0; round < PAPERS.length * 2; round += 1) {
      await waitAndResume({
        repository: runtimeA.runtime.repository,
        base: runtimeA.base,
        taskId: accepted.task_id,
        runId: accepted.run_id,
        match: (review) => review.kind === "permission" || review.reviewType === "vlm_extraction",
        decision: (review): HILDecision => {
          if (review.kind === "permission") return { action: "approve" };
          const paper = PAPERS[extractionCall];
          extractionCall += 1;
          return extractionCall <= 2
            ? { action: "accept" }
            : {
                action: "correct",
                correction: {
                  points: {
                    [`series_${paper?.seriesKey}_p1`]: { y_value: "22.5" },
                    [`series_${paper?.seriesKey}_p2`]: {},
                  },
                },
              };
        },
        lastError: () => bridge.lastError,
      });
    }
    expect(extractionCall).toBe(PAPERS.length);

    // The publication_acceptance review must suspend the run before the restart.
    const acceptanceReview = await (async () => {
      const deadline = Date.now() + 60_000;
      for (;;) {
        if (bridge.lastError !== null) {
          throw new Error(`gold6 scripted run failed before publication acceptance: ${bridge.lastError}`);
        }
        const reviews = await pendingReviews(runtimeA.runtime.repository, accepted.task_id, accepted.run_id);
        const review = reviews.find((candidate) => candidate.reviewType === "publication_acceptance");
        if (review !== undefined) return review;
        if (Date.now() > deadline) throw new Error("publication acceptance review never became pending");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    })();
    expect(
      (await runtimeA.runtime.repository.getSnapshot(accepted.task_id))?.runs
        .find((run) => run.run_id === accepted.run_id)?.status,
    ).toBe("awaiting_user_input");

    // -- Simulated Application Host restart with the acceptance unresolved.
    await new Promise<void>((resolve) => runtimeA.server.close(() => resolve()));
    await runtimeA.runtime.close();
    const runtimeB = await startRuntime({
      tasksRoot,
      workspacesRoot,
      vlmHttpClient,
      adapter: {
        async createSession(): Promise<never> {
          throw new Error("the resumed publication must not need an AI session");
        },
      },
    });
    // Startup recovery must keep the pending acceptance alive (not fail closed).
    expect(
      (await runtimeB.runtime.repository.getSnapshot(accepted.task_id))?.runs
        .find((run) => run.run_id === accepted.run_id)?.status,
    ).toBe("awaiting_user_input");

    // The fake human accepts the evidence-bound candidate; the deterministic
    // continuation publishes exactly once.
    await resumeWithDecision({
      base: runtimeB.base,
      taskId: accepted.task_id,
      runId: accepted.run_id,
      review: acceptanceReview,
      decision: { action: "accept" },
    });
    await expect.poll(
      async () =>
        (await runtimeB.runtime.repository.getSnapshot(accepted.task_id))?.runs
          .find((run) => run.run_id === accepted.run_id)?.status,
      { timeout: 120_000 },
    ).toBe("completed");

    // -- Exactly one immutable Publication, consumed continuation, replay fence.
    const publishDir = path.join(
      tasksRoot, accepted.task_id, "dataset_runs", accepted.run_id, REQUIREMENT_ID, "publish",
    );
    const versions = (await readdir(publishDir)).filter((name) => !name.startsWith("."));
    expect(versions).toHaveLength(1);
    const versionDir = path.join(publishDir, versions[0] ?? "");
    const publication = JSON.parse(
      await readFile(path.join(versionDir, "publication.json"), "utf8"),
    ) as { publication_id: string };
    const events = await runtimeB.runtime.repository.listEvents(accepted.task_id, 0);
    expect(events.filter((event) => event.payload.type === "publication_created")).toHaveLength(1);
    const continuation = await readPublicationAcceptanceContinuation(
      path.join(tasksRoot, accepted.task_id),
      REQUIREMENT_ID,
    );
    expect(continuation?.published_publication_id).toBe(publication.publication_id);
    const replay = await fetch(`${runtimeB.base}/api/v1/tasks/${accepted.task_id}/runs/${accepted.run_id}/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        request_id: acceptanceReview.requestId,
        evidence_digest: acceptanceReview.evidenceDigest,
        decision: { action: "reject" },
        reason: null,
      }),
    });
    expect([200, 409]).toContain(replay.status);
    expect((await readdir(publishDir)).filter((name) => !name.startsWith("."))).toHaveLength(1);

    // -- All six frozen required tables are published.
    const manifestJson = JSON.parse(
      await readFile(path.join(versionDir, "dataset_manifest.json"), "utf8"),
    ) as {
      sha256: string;
      artifacts: Array<{ relative_path: string; role: string; sha256: string }>;
    };
    expect(
      manifestJson.artifacts
        .filter((artifact) => artifact.relative_path.startsWith("tables/"))
        .map((artifact) => path.basename(artifact.relative_path, ".csv"))
        .sort(),
    ).toEqual([...TABLE_IDS].sort());

    // -- Artifact API round-trip: every artifact re-hashes to its receipt.
    const artifactListResponse = await fetch(`${runtimeB.base}/api/v1/tasks/${accepted.task_id}/artifacts`);
    expect(artifactListResponse.status).toBe(200);
    const artifactList = (await artifactListResponse.json()) as {
      artifacts: Array<{ artifact_id: string; name: string; sha256: string }>;
    };
    expect(artifactList.artifacts.length).toBeGreaterThanOrEqual(manifestJson.artifacts.length + 1);
    for (const artifact of manifestJson.artifacts) {
      const listed = artifactList.artifacts.find(
        (candidate) => candidate.name === path.basename(artifact.relative_path),
      );
      expect(listed, artifact.relative_path).toBeDefined();
      expect(listed!.sha256).toBe(artifact.sha256);
      const download = await fetch(
        `${runtimeB.base}/api/v1/tasks/${accepted.task_id}/artifacts/${listed!.artifact_id}`,
      );
      expect(download.status).toBe(200);
      const bytes = Buffer.from(await download.arrayBuffer());
      expect(sha256Bytes(bytes)).toBe(artifact.sha256);
      expect(await sha256FileStream(path.join(versionDir, ...artifact.relative_path.split("/")))).toBe(artifact.sha256);
    }

    // -- Published content checks.
    const parseCsv = (text: string): string[][] => {
      const rows: string[][] = [];
      for (const line of text.replace(/\r\n/g, "\n").trim().split("\n")) {
        const cells: string[] = [];
        let current = "";
        let quoted = false;
        for (let index = 0; index < line.length; index += 1) {
          const char = line[index]!;
          if (quoted) {
            if (char === "\"" && line[index + 1] === "\"") {
              current += "\"";
              index += 1;
            } else if (char === "\"") {
              quoted = false;
            } else {
              current += char;
            }
          } else if (char === "\"") {
            quoted = true;
          } else if (char === ",") {
            cells.push(current);
            current = "";
          } else {
            current += char;
          }
        }
        cells.push(current);
        rows.push(cells);
      }
      const header = rows[0] ?? [];
      return rows.slice(1).map((row) => header.map((_, index) => row[index] ?? ""));
    };
    const columnOf = (header: string[], rows: string[][], name: string): string[] => {
      const index = header.indexOf(name);
      if (index === -1) throw new Error(`column ${name} missing`);
      return rows.map((row) => row[index] ?? "");
    };
    const downloadTable = async (tableId: string): Promise<{ header: string[]; rows: string[][] }> => {
      const artifact = manifestJson.artifacts.find(
        (candidate) => candidate.relative_path === `tables/${tableId}.csv`,
      );
      if (artifact === undefined) throw new Error(`missing published table ${tableId}`);
      const listed = artifactList.artifacts.find(
        (candidate) => candidate.name === path.basename(artifact.relative_path),
      );
      const download = await fetch(
        `${runtimeB.base}/api/v1/tasks/${accepted.task_id}/artifacts/${listed!.artifact_id}`,
      );
      const text = await download.text();
      const parsed = parseCsv(text);
      return {
        header: TABLE_FIELDS[tableId] ?? [],
        rows: parsed,
      };
    };

    const papers = await downloadTable("paper_records");
    expect(columnOf(papers.header, papers.rows, "pmcid").sort()).toEqual([...PMCIDS].sort());
    expect(papers.rows).toHaveLength(PAPERS.length);

    const series = await downloadTable("chart_series");
    expect(series.rows).toHaveLength(PAPERS.length);
    expect(columnOf(series.header, series.rows, "model_name")).toEqual(series.rows.map(() => VLM_MODEL));
    expect(columnOf(series.header, series.rows, "model_version")).toEqual(series.rows.map(() => VLM_MODEL_VERSION));
    expect(columnOf(series.header, series.rows, "axis_validation_status")).toEqual(series.rows.map(() => "clear"));
    expect(columnOf(series.header, series.rows, "legend_validation_status")).toEqual(series.rows.map(() => "clear"));

    const points = await downloadTable("chart_points");
    const totalPoints = PAPERS.reduce((sum, paper) => sum + paper.points.length, 0);
    expect(points.rows).toHaveLength(totalPoints);
    const reviewStatuses = columnOf(points.header, points.rows, "review_status");
    expect(reviewStatuses.filter((status) => status === "accepted")).toHaveLength(totalPoints - 2);
    expect(reviewStatuses.filter((status) => status === "corrected")).toHaveLength(2);
    for (const reviewId of columnOf(points.header, points.rows, "review_id")) {
      expect(reviewId).toMatch(/^review_/);
    }
    for (const precision of columnOf(points.header, points.rows, "estimated_or_exact")) {
      expect(precision).toBe("estimated");
    }
    const yIndex = points.header.indexOf("y_value");
    const originalYIndex = points.header.indexOf("original_y_value");
    const originalXIndex = points.header.indexOf("original_x_value");
    const xIndex = points.header.indexOf("x_value");
    const corrected = points.rows.filter((_, index) => reviewStatuses[index] === "corrected");
    expect(corrected.map((row) => row[yIndex])).toContain("22.5");
    for (const row of corrected) {
      // Correction provenance: the raw estimate survives in the original columns.
      expect(row[originalYIndex]).not.toBe("");
    }
    const edited = corrected.find((row) => row[yIndex] === "22.5");
    // Paper C point 1 was (10, 64.5): the reviewer corrected y to 22.5 while
    // the raw estimate survives in original_y_value.
    expect(edited?.[originalYIndex]).toBe("64.5");
    expect(edited?.[originalXIndex]).toBe(edited?.[xIndex]);
    const untouched = corrected.find((row) => row[yIndex] === "22.0");
    expect(untouched?.[originalYIndex]).toBe("22.0");

    const supplements = await downloadTable("supplementary_asset_records");
    expect(supplements.rows).toHaveLength(SUPPLEMENT_PMCIDS.length);

    // -- HIL machinery evidence: one credential approval per governed
    // extraction call, one data_review per carrier, one publication_acceptance.
    const hilEvents = events
      .filter((event) => event.payload.type === "user_input_required")
      .map((event) => (event.payload as unknown as { hil_request: HILRequest }).hil_request);
    expect(hilEvents.filter((request) => request.kind === "permission")).toHaveLength(PAPERS.length);
    expect(hilEvents.filter((request) => request.review_type === "vlm_extraction")).toHaveLength(PAPERS.length);
    expect(hilEvents.filter((request) => request.review_type === "publication_acceptance")).toHaveLength(1);

    // -- The fake visual model saw exactly one governed call per paper.
    expect(capturedVlmCalls).toHaveLength(PAPERS.length);
    for (const call of capturedVlmCalls) {
      expect(call.url).toBe(`https://${VLM_HOST}/v1/chat/completions`);
      expect(call.authorization).toBe(`Bearer ${VLM_API_KEY}`);
      expect(call.model).toBe(VLM_MODEL);
      expect(call.prompt).toBe(REGISTERED_PAPER_CHART_PROMPT);
      expect(call.hasImage).toBe(true);
    }

    await new Promise<void>((resolve) => runtimeB.server.close(() => resolve()));
    await runtimeB.runtime.close();
  });
});
