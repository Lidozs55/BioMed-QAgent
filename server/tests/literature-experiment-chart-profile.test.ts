import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { CoreDerivedAssetProvenance } from "@biomed/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { DelimitedBoundsError } from "../src/dataset/adapters/text.js";
import {
  LiteratureExperimentChartSemanticError,
  validateLiteratureExperimentChartProfile,
} from "../src/dataset/families/index.js";

const roots: string[] = [];
const ARCHIVE_ID = `asset_${"a".repeat(64)}`;
const IMAGE_ID = `asset_${"b".repeat(64)}`;
const CSV_ID = `asset_${"c".repeat(64)}`;
const VLM_ID = `asset_${"d".repeat(64)}`;
const PARSED_ID = `asset_${"e".repeat(64)}`;
const PROMPT = "f".repeat(64);
const REVIEW_DIGEST = "1".repeat(64);
const REVIEW_EVIDENCE_ID = `asset_${"9".repeat(64)}`;
const CANDIDATE_ID = `asset_${"8".repeat(64)}`;

function csvCell(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

async function writeCsv(
  file: string,
  rows: readonly Record<string, unknown>[],
  fields = Object.keys(rows[0] ?? {}),
): Promise<void> {
  const content = [
    fields.join(","),
    ...rows.map((row) => fields.map((field) => csvCell(row[field])).join(",")),
  ].join("\n") + "\n";
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

function provenance(options: {
  assetId: string;
  parentIds: string[];
  kind: CoreDerivedAssetProvenance["operation_kind"];
  resultId: string;
  implementationId: string;
  evidence: CoreDerivedAssetProvenance["evidence"];
}): CoreDerivedAssetProvenance {
  return {
    schema_version: "1.0",
    task_id: "task_profile",
    asset_id: options.assetId,
    parent_asset_ids: options.parentIds,
    operation_kind: options.kind,
    operation_result_id: options.resultId,
    implementation_id: options.implementationId,
    implementation_version: "1.0.0",
    parameters_digest: "2".repeat(64),
    output_digest: options.assetId.slice("asset_".length),
    evidence: options.evidence,
    created_at: "2026-08-28T00:00:00.000Z",
  };
}

async function fixture(overrides: {
  point?: Partial<Record<string, unknown>>;
  series?: Partial<Record<string, unknown>>;
  supplementary?: Partial<Record<string, unknown>>;
  manifestPoint?: Partial<Record<string, unknown>>;
  emptyChartPoints?: boolean;
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "literature-chart-profile-"));
  roots.push(root);
  const files = {
    series: path.join(root, "chart_series.csv"),
    points: path.join(root, "chart_points.csv"),
    supplementary: path.join(root, "supplementary_asset_records.csv"),
  };
  const imageLocator = {
    locator_version: "2.0",
    locator_type: "image_bbox",
    asset_id: IMAGE_ID,
    logical_file: "source_assets/archive-members/image.png",
    raw_value: "chart_1",
    page_number: null,
    figure_id: "chart_1",
    bbox: [0, 0, 1, 1],
  };
  const review = {
    review_id: "review_vlm_1",
    status: "accepted",
    reviewer: "user",
    reviewed_at: "2026-08-28T00:00:00.000Z",
    evidence_digest: REVIEW_DIGEST,
    reason: "Point checked against the figure",
  };
  const transformProvenance = {
    schema_version: "1.0",
    model_name: "qwen-vl-max",
    model_version: "qwen-vl-max",
    steps: [{ operation: "vlm_extract", parameters: { prompt_digest: PROMPT } }],
    review,
  };
  const series = {
    chart_series_id: "chart_1",
    experiment_id: "experiment_1",
    figure_id: "chart_1",
    series_label: "series",
    x_axis_name: "dose",
    x_axis_unit: "nM",
    y_axis_name: "response",
    y_axis_unit: "%",
    x_scale: "linear",
    y_scale: "linear",
    legend_text: "series",
    axis_validation_status: "clear",
    legend_validation_status: "clear",
    human_review_status: "accepted",
    source_asset_id: IMAGE_ID,
    source_locator: imageLocator,
    model_name: "qwen-vl-max",
    model_version: "qwen-vl-max",
    prompt_digest: PROMPT,
    extraction_confidence: "medium",
    transform_provenance: transformProvenance,
    ...overrides.series,
  };
  const point = {
    point_id: "point_1",
    chart_series_id: "chart_1",
    activity_value_id: "activity_1",
    x_value: "10",
    y_value: "50",
    point_type: "point",
    estimated_or_exact: "estimated",
    pixel_or_coordinate_locator: imageLocator,
    extraction_confidence: "medium",
    confidence_reason: "visible mark",
    review_status: "accepted",
    review_id: "review_vlm_1",
    original_x_value: "",
    original_y_value: "",
    transform_provenance: transformProvenance,
    ...overrides.point,
  };
  const supplementary = {
    supplementary_asset_id: "supplement_1",
    paper_id: "PMC123",
    paper_id_namespace: "pmc",
    source_asset_id: CSV_ID,
    parent_archive_asset_id: ARCHIVE_ID,
    parent_archive_sha256: ARCHIVE_ID.slice("asset_".length),
    member_path: "tables/data.csv",
    member_sha256: CSV_ID.slice("asset_".length),
    media_type: "text/csv",
    size_bytes: "12",
    parser_id: "archive.csv_to_utf8_csv.v1",
    operation_result_id: "result_parser_csv",
    source_locator: {
      locator_version: "2.0",
      locator_type: "json_pointer",
      asset_id: CSV_ID,
      logical_file: "source_assets/archive-members/data.csv",
      raw_value: CSV_ID.slice("asset_".length),
      json_pointer: "/",
    },
    ...overrides.supplementary,
  };
  await writeCsv(files.series, [series]);
  await writeCsv(
    files.points,
    overrides.emptyChartPoints ? [] : [point],
    Object.keys(point),
  );
  await writeCsv(files.supplementary, [supplementary]);

  const manifestPoint = {
    point_id: "point_1",
    chart_id: "chart_1",
    x_value: "10",
    y_value: "50",
    point_type: "point",
    confidence_level: "medium",
    confidence_reason: "visible mark",
    human_review_state: "accepted",
    review_id: "review_vlm_1",
    review_evidence_digest: REVIEW_DIGEST,
    review_reviewer: "user",
    reviewed_at: "2026-08-28T00:00:00.000Z",
    review_reason: "Point checked against the figure",
    original_x_value: "",
    original_y_value: "",
    // Exact point locator identity and row-level page response identity,
    // exact-checked by the validator against the staged point locator.
    page_number: "",
    figure_id: "chart_1",
    bbox: "0,0,1,1",
    model_version: "qwen-vl-max",
    prompt_digest: PROMPT,
    ...overrides.manifestPoint,
  };
  const sourceInputProvenance: CoreDerivedAssetProvenance[] = [
    provenance({
      assetId: IMAGE_ID,
      parentIds: [ARCHIVE_ID],
      kind: "archive_member_extraction",
      resultId: "result_archive_image",
      implementationId: "dataset_core.zip_member_extractor",
      evidence: {
        parent_archive_asset_id: ARCHIVE_ID,
        parent_archive_sha256: ARCHIVE_ID.slice("asset_".length),
        member_path: "figures/chart.png",
        member_sha256: IMAGE_ID.slice("asset_".length),
        registered_relative_path: "source_assets/archive-members/image.png",
        media_type: "image/png",
        size_bytes: 100,
      },
    }),
    provenance({
      assetId: CSV_ID,
      parentIds: [ARCHIVE_ID],
      kind: "archive_member_extraction",
      resultId: "result_archive_csv",
      implementationId: "dataset_core.zip_member_extractor",
      evidence: {
        parent_archive_asset_id: ARCHIVE_ID,
        parent_archive_sha256: ARCHIVE_ID.slice("asset_".length),
        member_path: "tables/data.csv",
        member_sha256: CSV_ID.slice("asset_".length),
        registered_relative_path: "source_assets/archive-members/data.csv",
        media_type: "text/csv",
        size_bytes: 12,
      },
    }),
    provenance({
      assetId: VLM_ID,
      // Reviewed VLM evidence directly derives from the archive image, its
      // candidate carrier, and the review_evidence HIL record.
      parentIds: [IMAGE_ID, CANDIDATE_ID, REVIEW_EVIDENCE_ID],
      kind: "vlm_extraction",
      resultId: "result_vlm_1",
      implementationId: "dataset_core.chart_vlm_evidence",
      evidence: {
        model_name: "qwen-vl-max",
        model_version: "qwen-vl-max",
        prompt_digest: PROMPT,
        review_evidence_asset_id: REVIEW_EVIDENCE_ID,
        review_id: "review_vlm_1",
        review_request_id: "request_vlm_1",
        review_action: "accept",
        review_evidence_digest: REVIEW_DIGEST,
        candidate_carrier_asset_id: CANDIDATE_ID,
        manifest: {
          charts: [{
            chart_id: "chart_1",
            source_asset_id: IMAGE_ID,
            figure_id: "chart_1",
            model_name: "qwen-vl-max",
            model_version: "qwen-vl-max",
            prompt_digest: PROMPT,
            x_label: "dose",
            x_unit: "nM",
            y_label: "response",
            y_unit: "%",
            x_scale: "linear",
            y_scale: "linear",
            legend: "series",
            page_number: "",
            bbox: "0,0,1,1",
            extraction_tier: "L1_vlm",
          }],
          points: [manifestPoint],
        },
      },
    }),
    provenance({
      assetId: REVIEW_EVIDENCE_ID,
      parentIds: [CANDIDATE_ID],
      kind: "review_evidence",
      resultId: "result_review_vlm_1",
      implementationId: "registered-paper-chart-extraction",
      evidence: {
        candidate_carrier_asset_id: `asset_${"8".repeat(64)}`,
        review_id: "review_vlm_1",
        request_id: "request_vlm_1",
        review_evidence_digest: REVIEW_DIGEST,
        output_sha256: "7".repeat(64),
      },
    }),
    // The candidate carrier itself: a registered vlm_extraction fact derived
    // from the archive image (P1 audit — the reviewed evidence's
    // candidate_carrier_asset_id must resolve to exactly one such fact).
    provenance({
      assetId: CANDIDATE_ID,
      parentIds: [IMAGE_ID],
      kind: "vlm_extraction",
      resultId: "result_vlm_candidate_1",
      implementationId: "dataset_core.chart_vlm_evidence",
      evidence: {
        model_name: "qwen-vl-max",
        model_version: "qwen-vl-max",
        prompt_digest: PROMPT,
        manifest: {
          charts: [{
            chart_id: "chart_1",
            source_asset_id: IMAGE_ID,
            figure_id: "chart_1",
            model_name: "qwen-vl-max",
            model_version: "qwen-vl-max",
            prompt_digest: PROMPT,
            x_label: "dose",
            x_unit: "nM",
            y_label: "response",
            y_unit: "%",
            x_scale: "linear",
            y_scale: "linear",
            legend: "series",
            page_number: "",
            bbox: "0,0,1,1",
            extraction_tier: "L1_vlm",
          }],
          points: [{
            point_id: "point_1",
            chart_id: "chart_1",
            x_value: "10",
            y_value: "50",
            point_type: "point",
            confidence_level: "medium",
            confidence_reason: "visible mark",
            human_review_state: "pending",
            review_id: "",
            review_evidence_digest: "",
            review_reviewer: "",
            reviewed_at: "",
            review_reason: "",
            original_x_value: "",
            original_y_value: "",
            page_number: "",
            figure_id: "chart_1",
            bbox: "0,0,1,1",
            model_version: "qwen-vl-max",
            prompt_digest: PROMPT,
          }],
        },
      },
    }),
    provenance({
      assetId: PARSED_ID,
      parentIds: [CSV_ID],
      kind: "registered_parser",
      resultId: "result_parser_csv",
      implementationId: "archive.csv_to_utf8_csv.v1",
      evidence: { parser_id: "archive.csv_to_utf8_csv.v1" },
    }),
  ];
  return { files, sourceInputProvenance };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("literature experiment chart semantic profile", () => {
  it("accepts manifest-bound chart, point review, and archive parser facts", async () => {
    const value = await fixture();
    await expect(validateLiteratureExperimentChartProfile({
      profileRef: "literature_experiment_chart.release.v1",
      stagedTablePaths: new Map([
        ["chart_series", value.files.series],
        ["chart_points", value.files.points],
        ["supplementary_asset_records", value.files.supplementary],
      ]),
      sourceInputProvenance: value.sourceInputProvenance,
    })).resolves.toBeUndefined();
  });

  it("rejects a selected candidate-only VLM carrier before empty chart points bypass closure", async () => {
    const value = await fixture({ emptyChartPoints: true });
    await expect(validateLiteratureExperimentChartProfile({
      profileRef: "literature_experiment_chart.release.v1",
      stagedTablePaths: new Map([
        ["chart_series", value.files.series],
        ["chart_points", value.files.points],
        ["supplementary_asset_records", value.files.supplementary],
      ]),
      sourceInputProvenance: value.sourceInputProvenance,
      selectedInputAssetIds: [CANDIDATE_ID],
    })).rejects.toThrow(/reviewed carrier|review_evidence|terminal VLM/);
  });

  it("rejects chart series transform provenance model and prompt drift", async () => {
    const value = await fixture({
      series: {
        transform_provenance: {
          schema_version: "1.0",
          model_name: "wrong-model",
          model_version: "wrong-version",
          steps: [{ operation: "vlm_extract", parameters: { prompt_digest: "0".repeat(64) } }],
          review: null,
        },
      },
    });
    await expect(validateLiteratureExperimentChartProfile({
      profileRef: "literature_experiment_chart.release.v1",
      stagedTablePaths: new Map([
        ["chart_series", value.files.series],
        ["chart_points", value.files.points],
        ["supplementary_asset_records", value.files.supplementary],
      ]),
      sourceInputProvenance: value.sourceInputProvenance,
    })).rejects.toThrow(/chart_series\.transform_provenance/);
  });

  it("types semantic mismatches without wrapping file I/O failures", async () => {
    const semantic = await fixture({ supplementary: { media_type: "application/octet-stream" } });
    await expect(validateLiteratureExperimentChartProfile({
      profileRef: "literature_experiment_chart.release.v1",
      stagedTablePaths: new Map([
        ["chart_series", semantic.files.series],
        ["chart_points", semantic.files.points],
        ["supplementary_asset_records", semantic.files.supplementary],
      ]),
      sourceInputProvenance: semantic.sourceInputProvenance,
    })).rejects.toBeInstanceOf(LiteratureExperimentChartSemanticError);

    const bounded = await fixture();
    await writeFile(
      bounded.files.series,
      `chart_series_id,source_locator\n${"x".repeat(1024 * 1024 + 1)},{}\n`,
      "utf8",
    );
    let resourceFailure: unknown;
    try {
      await validateLiteratureExperimentChartProfile({
        profileRef: "literature_experiment_chart.release.v1",
        stagedTablePaths: new Map([
          ["chart_series", bounded.files.series],
          ["chart_points", bounded.files.points],
          ["supplementary_asset_records", bounded.files.supplementary],
        ]),
        sourceInputProvenance: bounded.sourceInputProvenance,
      });
    } catch (error) {
      resourceFailure = error;
    }
    expect(resourceFailure).toBeInstanceOf(DelimitedBoundsError);
    expect(resourceFailure).not.toBeInstanceOf(LiteratureExperimentChartSemanticError);

    const missing = await fixture();
    await rm(missing.files.series);
    let ioFailure: unknown;
    try {
      await validateLiteratureExperimentChartProfile({
        profileRef: "literature_experiment_chart.release.v1",
        stagedTablePaths: new Map([
          ["chart_series", missing.files.series],
          ["chart_points", missing.files.points],
          ["supplementary_asset_records", missing.files.supplementary],
        ]),
        sourceInputProvenance: missing.sourceInputProvenance,
      });
    } catch (error) {
      ioFailure = error;
    }
    expect(ioFailure).toMatchObject({ code: "ENOENT" });
    expect(ioFailure).not.toBeInstanceOf(LiteratureExperimentChartSemanticError);
  });

  it("rejects exact-label review bypass, locator drift, and media-type parser bypass", async () => {
    const exact = await fixture({
      point: { estimated_or_exact: "exact", review_status: "pending", review_id: "", transform_provenance: { review: null } },
      manifestPoint: { human_review_state: "pending", review_id: "", review_evidence_digest: "", review_reviewer: "", reviewed_at: "", review_reason: "" },
    });
    await expect(validateLiteratureExperimentChartProfile({
      profileRef: "literature_experiment_chart.release.v1",
      stagedTablePaths: new Map([["chart_series", exact.files.series], ["chart_points", exact.files.points], ["supplementary_asset_records", exact.files.supplementary]]),
      sourceInputProvenance: exact.sourceInputProvenance,
    })).rejects.toThrow(/estimated|match Core VLM evidence/);

    const media = await fixture({ supplementary: { media_type: "application/octet-stream" } });
    await expect(validateLiteratureExperimentChartProfile({
      profileRef: "literature_experiment_chart.release.v1",
      stagedTablePaths: new Map([["chart_series", media.files.series], ["chart_points", media.files.points], ["supplementary_asset_records", media.files.supplementary]]),
      sourceInputProvenance: media.sourceInputProvenance,
    })).rejects.toThrow(/archive-member provenance/);

    const locator = await fixture({
      series: { source_locator: { locator_version: "2.0", locator_type: "image_bbox", asset_id: CSV_ID, logical_file: "source_assets/wrong.png", raw_value: "chart_1", page_number: null, figure_id: "chart_1", bbox: [0, 0, 1, 1] } },
    });
    await expect(validateLiteratureExperimentChartProfile({
      profileRef: "literature_experiment_chart.release.v1",
      stagedTablePaths: new Map([["chart_series", locator.files.series], ["chart_points", locator.files.points], ["supplementary_asset_records", locator.files.supplementary]]),
      sourceInputProvenance: locator.sourceInputProvenance,
    })).rejects.toThrow(/do not match Core VLM evidence/);
  });
});
