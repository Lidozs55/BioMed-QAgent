import { createHash } from "node:crypto";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { DEFAULT_RUNTIME_LIMITS } from "@biomed/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { PNG } from "pngjs";

import {
  createPrepareDynamicFamilyPublicationTool,
  parseDynamicFamilyPublicationSubmitRequest,
} from "../src/agent/tools/dynamic-family-publication.js";
import { createChartDataVlmTool } from "../src/agent/tools/extract-chart-data-vlm.js";
import { extractRegisteredZipMembers } from "../src/dataset/archive/zip-members.js";
import { parseRegisteredArchiveMembers } from "../src/dataset/archive/member-parsers.js";
import { computeHILEvidenceDigest } from "../src/dataset/contracts/hil-evidence.js";
import {
  buildCoreProfilePrepareSubmission,
} from "../src/dataset/dynamic-family/profile-scaffold.js";
import {
  prepareDynamicFamilyPublication,
} from "../src/dataset/dynamic-family/preflight.js";
import {
  publishDynamicFamily,
} from "../src/dataset/dynamic-family/publication.js";
import {
  resolveCoreProductTopologyRequirements,
} from "../src/dataset/dynamic-family/product-requirement-registry.js";
import { submitDynamicFamilyPublication } from "../src/dataset/dynamic-family/submission.js";
import {
  LITERATURE_EXPERIMENT_CHART_PROFILE_REF,
  literatureExperimentChartTables,
} from "../src/dataset/families/literature-experiment-chart/profile.js";
import { PublicHttpClient } from "../src/external/network/http-client.js";
import { SourceAssetRegistry } from "../src/runtime/source-assets/registry.js";
import {
  fakeResolver,
  localExecutor,
  PUBLIC_IP,
  startFixtureServer,
  type FixtureServer,
} from "./phase5/helpers.js";

const roots: string[] = [];
const fixtures: FixtureServer[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipStored(entries: readonly { name: string; bytes: Buffer }[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc32(entry.bytes), 14);
    local.writeUInt32LE(entry.bytes.length, 18);
    local.writeUInt32LE(entry.bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, entry.bytes);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(crc32(entry.bytes), 16);
    central.writeUInt32LE(entry.bytes.length, 20);
    central.writeUInt32LE(entry.bytes.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, name);
    localOffset += local.length + name.length + entry.bytes.length;
  }
  const central = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, central, eocd]);
}

function tinyPng(): Buffer {
  const png = new PNG({ width: 4, height: 4 });
  for (let index = 0; index < png.data.length; index += 4) {
    png.data[index] = 180;
    png.data[index + 1] = 40;
    png.data[index + 2] = 40;
    png.data[index + 3] = 255;
  }
  return Buffer.from(PNG.sync.write(png));
}

function csvCell(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function tableCsv(tableId: string, row: Record<string, unknown>): string {
  const definition = literatureExperimentChartTables.find((item) => item.table_id === tableId);
  if (definition === undefined) throw new Error(`missing table ${tableId}`);
  return `${definition.field_names.join(",")}\n${definition.field_names.map(
    (field) => csvCell(row[field] ?? ""),
  ).join(",")}\n`;
}

describe("literature experiment chart formal closure", () => {
  it("publishes a six-table product from Core archive, parser, and reviewed VLM evidence", async () => {
    const taskRoot = await mkdtemp(path.join(os.tmpdir(), "literature-chart-e2e-"));
    roots.push(taskRoot);
    const workspaceRoot = path.join(taskRoot, "agent-workspace");
    await mkdir(path.join(taskRoot, "source_assets"), { recursive: true });
    const registry = new SourceAssetRegistry("task_literature_chart", taskRoot, {
      now: () => new Date("2026-08-28T00:00:00.000Z"),
    });

    const archiveBytes = zipStored([
      { name: "figures/figure1.png", bytes: tinyPng() },
      { name: "tables/activity.csv", bytes: Buffer.from("dose,response\n10,50\n", "utf8") },
    ]);
    const archivePath = "source_assets/supplementary.zip";
    await writeFile(path.join(taskRoot, ...archivePath.split("/")), archiveBytes);
    const archive = await registry.register({
      sourceId: "fixture_supplementary",
      relativePath: archivePath,
      role: "carrier",
      mediaType: "application/zip",
    });
    await registry.registerCoreAcquisitionProvenance(archive, {
      provider_id: "europepmc.supplementary.v1",
      implementation_digest: "a".repeat(64),
      request_identity_digest: "b".repeat(64),
      canonical_accession: "PMC123",
      provider_snapshot_identity: "fixture",
      provider_revision_token: null,
    });
    const extracted = await extractRegisteredZipMembers({
      taskId: "task_literature_chart",
      taskRoot,
      archiveAssetId: archive.asset_ref.asset_id,
      sourceAssetRegistry: registry,
    });
    const parsedMembers = await parseRegisteredArchiveMembers({
      taskId: "task_literature_chart",
      taskRoot,
      sourceAssetRegistry: registry,
      members: extracted.members,
    });
    const image = extracted.members.find((member) => member.media_type === "image/png");
    const csvMember = extracted.members.find((member) => member.media_type === "text/csv");
    const parsedCsv = parsedMembers.parsed_assets.find((asset) => asset.parser_id.includes("csv"));
    if (image === undefined || csvMember === undefined || parsedCsv === undefined) {
      throw new Error("fixture archive did not yield its formal assets");
    }

    const vlmJson = JSON.stringify({
      chart_type: "line",
      title: "Non-Gold dose response",
      axes: {
        x: { label: "dose", unit: "nM", scale: "linear" },
        y: { label: "response", unit: "%", scale: "linear" },
      },
      data_points: [{
        x: "10",
        y: "50",
        series_label: "fixture series",
        confidence_level: "low",
        confidence_reason: "fixture point requires review",
      }],
      legend: ["fixture series"],
    });
    const vlmServer = await startFixtureServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { content: vlmJson } }] }));
    });
    fixtures.push(vlmServer);
    let vlmReviewCount = 0;
    const [vlmTool] = createChartDataVlmTool({
      taskRoot,
      taskId: "task_literature_chart",
      sourceAssetRegistry: registry,
      approvalGate: { request: async () => "approve" },
      hilGate: {
        requestHIL: async (request) => {
          vlmReviewCount += 1;
          return {
            schema_version: "1.0",
            review_id: "review_vlm_fixture",
            request_id: "hil_vlm_fixture",
            decision: { action: "accept" },
            reviewer: "user",
            reviewed_at: "2026-08-28T00:01:00.000Z",
            evidence_digest: computeHILEvidenceDigest(request),
            reason: "Reviewed fixture point",
          };
        },
      },
      vlmConfig: { apiKey: "fixture-key", baseUrl: "https://vlm.example.com/v1", model: "fixture-vlm" },
      httpClient: new PublicHttpClient({
        resolve: fakeResolver({ "vlm.example.com": [PUBLIC_IP] }),
        executor: localExecutor(vlmServer.port),
      }),
    });
    const vlmResult = await vlmTool.execute({ source_asset_id: image.receipt.asset_ref.asset_id });
    expect(vlmResult.isError).not.toBe(true);
    expect(vlmReviewCount).toBe(1);
    const vlmDetails = vlmResult.details as {
      prompt_digest: string;
      formal_evidence_assets: Array<{
        asset_id: string;
        provenance: { operation_kind: string; parent_asset_ids: string[]; evidence: { candidate_carrier_asset_id?: string; review_evidence_asset_id?: string; review_id?: string; manifest: { charts: Array<Record<string, unknown>>; points: Array<Record<string, unknown>> } } };
      }>;
    };
    // R5 closure: the reviewed terminal fact must resolve with the complete
    // candidate -> review_evidence -> reviewed provenance edges.
    const closure = await registry.resolveFormalProvenanceClosure(
      vlmDetails.formal_evidence_assets[0]!.asset_id,
    );
    const closureKinds = closure.flatMap((item) =>
      "operation_kind" in item ? [item.operation_kind] : []);
    expect(closureKinds).toContain("review_evidence");
    expect(closureKinds.filter((kind) => kind === "vlm_extraction")).toHaveLength(2);
    const vlmAsset = vlmDetails.formal_evidence_assets[0];
    const chart = vlmAsset?.provenance.evidence.manifest.charts[0];
    const point = vlmAsset?.provenance.evidence.manifest.points[0];
    if (vlmAsset === undefined || chart === undefined || point === undefined) {
      throw new Error("formal VLM evidence manifest is incomplete");
    }

    const fulltextPath = "source_assets/PMC123.xml";
    await writeFile(path.join(taskRoot, ...fulltextPath.split("/")), "<article><article-id pub-id-type=\"pmcid\">123</article-id></article>");
    const fulltext = await registry.register({
      sourceId: "fixture_fulltext",
      relativePath: fulltextPath,
      role: "source",
      mediaType: "application/xml",
    });
    await registry.registerCoreAcquisitionProvenance(fulltext, {
      provider_id: "pubmed.files.v1",
      implementation_digest: "c".repeat(64),
      request_identity_digest: "d".repeat(64),
      canonical_accession: "PMC123",
      provider_snapshot_identity: "fixture",
      provider_revision_token: null,
    });

    const imageLocator = {
      locator_version: "2.0",
      locator_type: "image_bbox",
      asset_id: image.receipt.asset_ref.asset_id,
      logical_file: image.receipt.relative_path,
      raw_value: String(chart.chart_id),
      page_number: chart.page_number === "" ? null : Number(chart.page_number),
      figure_id: String(chart.figure_id),
      bbox: String(chart.bbox).split(",").map(Number),
    };
    // The staged POINT locator uses the point's OWN manifest locator identity,
    // never the chart bbox (past P0 finding).
    const pointLocator = {
      ...imageLocator,
      page_number: point.page_number === "" ? null : Number(point.page_number),
      figure_id: String(point.figure_id),
      bbox: String(point.bbox).split(",").map(Number),
    };
    const review = {
      review_id: String(point.review_id),
      status: String(point.human_review_state),
      reviewer: String(point.review_reviewer),
      reviewed_at: String(point.reviewed_at),
      evidence_digest: String(point.review_evidence_digest),
      reason: String(point.review_reason),
    };
    const pointTransformProvenance = {
      schema_version: "1.0",
      model_name: String(point.model_version),
      model_version: String(point.model_version),
      steps: [{ operation: "vlm_extract", parameters: { prompt_digest: String(point.prompt_digest) } }],
      review,
    };
    const transformProvenance = {
      schema_version: "1.0",
      model_name: String(chart.model_name),
      model_version: String(chart.model_version),
      steps: [{ operation: "vlm_extract", parameters: { prompt_digest: String(chart.prompt_digest) } }],
      review,
    };
    const xmlLocator = {
      locator_version: "2.0",
      locator_type: "xml_cell",
      asset_id: fulltext.asset_ref.asset_id,
      logical_file: fulltext.relative_path,
      raw_value: "fixture activity",
      table_id: "T1",
      row_index: 1,
      column_name: "activity_value",
    };
    const supplementLocator = {
      locator_version: "2.0",
      locator_type: "json_pointer",
      asset_id: csvMember.receipt.asset_ref.asset_id,
      logical_file: csvMember.receipt.relative_path,
      raw_value: csvMember.member_sha256,
      json_pointer: "/",
    };
    const rows: Record<string, Record<string, unknown>> = {
      activity_value_records: {
        activity_value_id: "activity_1", experiment_id: "experiment_1", raw_value: "12",
        raw_relation: "=", raw_unit: "nM", normalized_value: "12", normalized_unit: "nM",
        value_precision: "exact", extraction_method: "jats_table", confidence: "high",
        review_status: "not_required", source_asset_id: fulltext.asset_ref.asset_id,
        source_locator: xmlLocator,
      },
      paper_records: {
        paper_id: "PMC123", paper_id_namespace: "pmc", title: "Fixture paper", journal: "Fixture journal",
        publication_date: "2026-01-01", authors: "Fixture Author", source_url: "https://example.test/PMC123",
      },
      experiment_records: {
        experiment_id: "experiment_1", paper_id: "PMC123", paper_id_namespace: "pmc",
        experiment_type: "kinase assay", subject: "compound fixture", target: "EGFR L858R/T790M",
        assay: "fixture assay", conditions: "fixture conditions", source_asset_id: fulltext.asset_ref.asset_id,
        source_locator: xmlLocator,
      },
      chart_series: {
        chart_series_id: chart.chart_id, experiment_id: "experiment_1", figure_id: chart.chart_id,
        series_label: chart.legend, x_axis_name: chart.x_label, x_axis_unit: chart.x_unit,
        y_axis_name: chart.y_label, y_axis_unit: chart.y_unit, x_scale: chart.x_scale, y_scale: chart.y_scale,
        legend_text: chart.legend, axis_validation_status: "clear", legend_validation_status: "clear",
        human_review_status: "accepted", source_asset_id: image.receipt.asset_ref.asset_id,
        source_locator: imageLocator, model_name: "fixture-vlm", model_version: "fixture-vlm",
        prompt_digest: vlmDetails.prompt_digest, extraction_confidence: point.confidence_level,
        transform_provenance: transformProvenance,
      },
      chart_points: {
        point_id: point.point_id, chart_series_id: chart.chart_id, activity_value_id: "activity_1",
        x_value: point.x_value, y_value: point.y_value, point_type: "point", estimated_or_exact: "estimated",
        pixel_or_coordinate_locator: pointLocator, extraction_confidence: point.confidence_level,
        confidence_reason: point.confidence_reason, review_status: point.human_review_state,
        review_id: point.review_id, original_x_value: point.original_x_value,
        original_y_value: point.original_y_value, transform_provenance: pointTransformProvenance,
      },
      supplementary_asset_records: {
        supplementary_asset_id: "supplement_1", paper_id: "PMC123", paper_id_namespace: "pmc",
        source_asset_id: csvMember.receipt.asset_ref.asset_id,
        parent_archive_asset_id: archive.asset_ref.asset_id, parent_archive_sha256: archive.sha256,
        member_path: csvMember.member_path, member_sha256: csvMember.member_sha256,
        media_type: csvMember.media_type, size_bytes: String(csvMember.size_bytes),
        parser_id: parsedCsv.parser_id, operation_result_id: parsedCsv.provenance.operation_result_id,
        source_locator: supplementLocator,
      },
    };
    const orderedTableIds = [
      "activity_value_records", "paper_records", "experiment_records", "chart_series",
      "supplementary_asset_records", "chart_points",
    ];
    const contents = Object.fromEntries(orderedTableIds.map((tableId) => [tableId, tableCsv(tableId, rows[tableId]!) ]));
    const outputs = orderedTableIds.map((tableId, index) => {
      const definition = literatureExperimentChartTables.find((item) => item.table_id === tableId)!;
      return `{handle:${JSON.stringify(`out_${index}`)},table_id:${JSON.stringify(tableId)},schema_ref:${JSON.stringify(definition.schema_ref)},locator_ref:first.receipt_id,content:${JSON.stringify(contents[tableId])},row_count:1}`;
    }).join(",");
    const transformSource = `export const transform={run({inputs}){const [first]=inputs;return {outputs:[${outputs}]};}};`;
    const sourceBindings = [
      { binding_id: "fulltext", source: "pubmed", input_requirement_ref: "fulltext_xml", parameters: {} },
      { binding_id: "vlm_evidence", source: "core_vlm", input_requirement_ref: "vlm_evidence", parameters: {} },
      {
        binding_id: "supplementary_figure",
        source: "core_archive",
        input_requirement_ref: "supplementary_figure",
        binding_kind: "provenance_only" as const,
        parameters: {},
      },
      { binding_id: "supplementary_table", source: "core_archive", input_requirement_ref: "supplementary_table", parameters: {} },
    ];
    const rawPrepare = buildCoreProfilePrepareSubmission({
      profileRef: LITERATURE_EXPERIMENT_CHART_PROFILE_REF,
      requirementId: "literature_chart_fixture",
      sourceBindings,
      registeredSources: {
        fulltext: fulltext.asset_ref.asset_id,
        vlm_evidence: vlmAsset.asset_id,
        supplementary_figure: image.receipt.asset_ref.asset_id,
        supplementary_table: parsedCsv.receipt.asset_ref.asset_id,
      },
      acquisitionRequests: {},
      transformSource,
      transformInputRoles: [
        { role: "fulltext_xml", media_type: "application/xml", constraint_ref: null },
        { role: "vlm_evidence", media_type: "application/json", constraint_ref: null },
        { role: "supplementary_table", media_type: "text/csv", constraint_ref: null },
      ],
    });
    const productRequirements = resolveCoreProductTopologyRequirements(
      LITERATURE_EXPERIMENT_CHART_PROFILE_REF,
    );
    const prepareTool = createPrepareDynamicFamilyPublicationTool({
      prepare: (submission) => prepareDynamicFamilyPublication({
        taskId: "task_literature_chart",
        requirementId: "literature_chart_fixture",
        generation: 0,
        submission,
        productRequirements,
      }),
    });
    const prepared = await prepareTool.execute(rawPrepare);
    expect(prepared.isError).not.toBe(true);
    const preparedDetails = prepared.details as {
      prepared_submission: Record<string, unknown>;
      preflight_receipt: Record<string, unknown>;
    };
    const submitRequest = await parseDynamicFamilyPublicationSubmitRequest({
      ...preparedDetails.prepared_submission,
      preflight_receipt: preparedDetails.preflight_receipt,
    });
    if (submitRequest.submission === null) {
      throw new Error("full submit request must include the prepared submission");
    }
    const execution = await submitDynamicFamilyPublication({
      taskId: "task_literature_chart",
      runId: "run_literature_chart",
      submission: submitRequest.submission,
      sourceAssetRegistry: registry,
      taskRoot,
      runtimeLimits: DEFAULT_RUNTIME_LIMITS,
      generation: 0,
      preflightReceipt: submitRequest.preflightReceipt,
      preflightSubmission: submitRequest.submission,
      productRequirements,
      isGenerationCurrent: () => true,
    });
    const transformInputAssetIds = execution.receipt.input_asset_receipts.map(
      (receipt) => receipt.asset_id,
    );
    expect(transformInputAssetIds).toHaveLength(3);
    expect(transformInputAssetIds).not.toContain(image.receipt.asset_ref.asset_id);
    expect(execution.operationResult.dependency_closure.input_asset_ids).toContain(
      image.receipt.asset_ref.asset_id,
    );
    expect(execution.materialization.candidate.registered_asset_ids).toContain(
      image.receipt.asset_ref.asset_id,
    );
    let publicationReviewCount = 0;
    const outputRoot = path.join(taskRoot, "dataset_runs", "run_literature_chart", "literature_chart_fixture");
    let published: Awaited<ReturnType<typeof publishDynamicFamily>>;
    try {
      published = await publishDynamicFamily({
        taskId: "task_literature_chart",
        taskRoot,
        workspaceRoot,
        runId: "run_literature_chart",
        requirementId: "literature_chart_fixture",
        execution,
        validationProfileRef: "literature_experiment_chart.validation.v1",
        productRequirements,
        signal: new AbortController().signal,
        hilGate: {
          requestHIL: async (request) => {
            publicationReviewCount += 1;
            return {
              schema_version: "1.0",
              review_id: "review_publication_fixture",
              request_id: "hil_publication_fixture",
              decision: { action: "accept" },
              reviewer: "user",
              reviewed_at: "2026-08-28T00:02:00.000Z",
              evidence_digest: computeHILEvidenceDigest(request),
              reason: "Reviewed complete fixture product",
            };
          },
        },
        isGenerationCurrent: () => true,
      });
    } catch (error) {
      const resource = await readFile(path.join(outputRoot, "resource_report.json"), "utf8")
        .catch(() => "resource report missing");
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\n${resource}`,
        { cause: error },
      );
    }

    expect(publicationReviewCount).toBe(1);
    expect(published.assessment.product_status).toBe("publishable");
    expect(published.manifest.tables.map((table) => table.table_id)).toEqual(orderedTableIds);
    expect(published.publication.publication.manifest_sha256).toMatch(/^[0-9a-f]{64}$/u);
    for (const artifact of published.manifest.artifacts) {
      const bytes = await readFile(path.join(outputRoot, ...artifact.relative_path.split("/")));
      expect(bytes.length).toBe(artifact.size_bytes);
      expect(sha256(bytes)).toBe(artifact.sha256);
    }
    await expect(access(path.join(outputRoot, "publish"))).resolves.toBeUndefined();
  }, 60_000);
});
