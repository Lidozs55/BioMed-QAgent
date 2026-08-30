import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readConfidenceArtifact } from "../src/dataset/confidence/artifact.js";
import { analyzeDigitAnomaly } from "../src/dataset/confidence/digit-anomaly.js";
import { evaluateConfidence } from "../src/dataset/confidence/evaluator.js";
import { writeChartConfidenceArtifact } from "../src/processing/vlm/chart-extraction.js";
import type { ChartPointRow, ChartRow } from "../src/processing/vlm/chart-json.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** 60 values with balanced last figures, distinct values, no arithmetic run. */
function balancedValues(): number[] {
  const digits = [3, 7, 1, 9, 5, 2, 8, 4, 6, 0];
  const values: number[] = [];
  for (let group = 0; group < 6; group++) {
    for (let index = 0; index < digits.length; index++) {
      values.push(digits[index] + 10 * ((group * 13 + index * 7) % 97) + 1);
    }
  }
  return values;
}

describe("digit-regularity anti-fabrication screen", () => {
  it("stays clean with an insufficient sample", () => {
    expect(analyzeDigitAnomaly([3, 7, 1, 9, 5, 2, 8, 4, 6, 0])).toEqual({
      verdict: "clean",
      reasons: [],
      sample_size: 10,
    });
  });

  it("stays clean for balanced last figures with distinct values", () => {
    expect(analyzeDigitAnomaly(balancedValues())).toEqual({
      verdict: "clean",
      reasons: [],
      sample_size: 60,
    });
  });

  it("flags a strong deviation from uniform last figures", () => {
    const skewed = Array.from({ length: 60 }, (_, index) => index * 10 + 3);
    const result = analyzeDigitAnomaly(skewed);
    expect(result.verdict).toBe("flagged");
    expect(result.reasons.join(" ")).toMatch(/last-figure digits deviate strongly from uniform/);
  });

  it("flags skewed last-two-figure digits on integer data", () => {
    const paired = Array.from({ length: 200 }, (_, index) => index * 100 + (index % 10));
    const result = analyzeDigitAnomaly(paired);
    expect(result.verdict).toBe("flagged");
    expect(result.reasons).toEqual([
      expect.stringMatching(/last-two-figure digits deviate strongly from uniform/),
    ]);
  });

  it("flags a single value dominating the sample", () => {
    const dominated = [
      ...Array.from({ length: 52 }, () => 17.5),
      1.1, 2.2, 3.3, 4.4, 5.5, 6.6, 7.7, 8.8,
    ];
    const result = analyzeDigitAnomaly(dominated);
    expect(result.verdict).toBe("flagged");
    expect(result.reasons.join(" ")).toMatch(/single value repeats/);
  });

  it("flags a perfect arithmetic progression on the measured values", () => {
    const linear = Array.from({ length: 32 }, (_, index) => 100 + 97 * index);
    const result = analyzeDigitAnomaly(linear);
    expect(result.verdict).toBe("flagged");
    expect(result.reasons).toEqual([
      expect.stringMatching(/arithmetic progression over/),
    ]);
  });

  it("does not flag a short run of consecutive ordinals", () => {
    const ordinals = Array.from({ length: 9 }, (_, index) => index);
    expect(analyzeDigitAnomaly(ordinals).verdict).toBe("clean");
  });
});

describe("digit-regularity downgrade in evaluateConfidence", () => {
  const baseInput = {
    confidence_id: "confidence_c",
    batch_id: "batch_c",
    record_id: "row_c",
    channel: "official_api",
    components: {
      source_reliability: "high" as const,
      extraction_reliability: "high" as const,
      mapping_reliability: "high" as const,
      cross_source_consistency: "consistent" as const,
      human_review_state: "accepted" as const,
    },
  };

  it("keeps the level when no screen result is supplied", () => {
    expect(evaluateConfidence(baseInput).level).toBe("high");
  });

  it("keeps the level for a clean screen result", () => {
    expect(
      evaluateConfidence({
        ...baseInput,
        digitAnomaly: { verdict: "clean", reasons: [], sample_size: 60 },
      }).level,
    ).toBe("high");
  });

  it("forces low and records the screen reasons when flagged", () => {
    const record = evaluateConfidence({
      ...baseInput,
      digitAnomaly: {
        verdict: "flagged",
        reasons: ["last-figure digits deviate strongly from uniform (chi-square 540.0, df=9, n=60)"],
        sample_size: 60,
      },
    });
    expect(record.level).toBe("low");
    expect(record.reasons).toContain(
      "last-figure digits deviate strongly from uniform (chi-square 540.0, df=9, n=60)",
    );
  });

  it("flags override the nondeterministic channel cap", () => {
    const record = evaluateConfidence({
      ...baseInput,
      channel: "vlm",
      digitAnomaly: { verdict: "flagged", reasons: ["fabrication indicator"], sample_size: 60 },
    });
    expect(record.level).toBe("low");
  });
});

function chartRow(chartId: string, extractionTier: string): ChartRow {
  return {
    chart_id: chartId,
    source_asset_id: "asset_1",
    chart_type: "line",
    title: "figure",
    x_label: "",
    x_unit: "",
    x_scale: "",
    y_label: "",
    y_unit: "",
    y_scale: "",
    data_point_count: 0,
    legend: "",
    extracted_at: "2026-01-01T00:00:00Z",
    model_name: "qwen-vl",
    source_label: "source",
    page_number: "1",
    bbox: "",
    extraction_tier: extractionTier,
  };
}

function pointRow(chartId: string, index: number, yValue: string): ChartPointRow {
  return {
    point_id: `point_${chartId}_${index}`,
    chart_id: chartId,
    x_value: String(index),
    y_value: yValue,
    series_label: "series",
    confidence_level: "high",
    confidence_reason: "",
    human_review_state: "not_required",
    review_id: "",
    review_evidence_digest: "",
    review_reviewer: "",
    reviewed_at: "",
    review_reason: "",
    original_x_value: "",
    original_y_value: "",
  };
}

describe("chart confidence artifact digit-regularity wiring", () => {
  it("downgrades flagged charts and leaves clean charts untouched", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "digit-anomaly-artifact-"));
    roots.push(root);
    const flaggedRow = chartRow("chart_flagged", "L1_vlm");
    const cleanRow = chartRow("chart_clean", "L2_tables");
    const flaggedArithmeticRow = chartRow("chart_arithmetic", "L2_tables");
    // Every value ends in 3 -> strong last-figure deviation -> flagged.
    const flaggedPoints = Array.from({ length: 32 }, (_, index) => index * 10 + 3)
      .map((value, index) => pointRow("chart_flagged", index, String(value)));
    const cleanPoints = balancedValues().map((value, index) =>
      pointRow("chart_clean", index, String(value)),
    );
    const arithmeticPoints = Array.from({ length: 32 }, (_, index) => 100 + 97 * index)
      .map((value, index) => pointRow("chart_arithmetic", index, String(value)));

    await writeChartConfidenceArtifact(root, [
      flaggedRow,
      cleanRow,
      flaggedArithmeticRow,
    ], [
      ...flaggedPoints,
      ...cleanPoints,
      ...arithmeticPoints,
    ]);

    const artifact = (await readConfidenceArtifact(root)) as NonNullable<
      Awaited<ReturnType<typeof readConfidenceArtifact>>
    >;
    expect(artifact.record_overrides.length).toBe(32);
    expect(artifact.record_overrides.every((record) => record.level === "low")).toBe(true);
    expect(
      artifact.record_overrides[0]!.reasons.some((reason) => /uniform|arithmetic/.test(reason)),
    ).toBe(true);
    expect(
      artifact.batch_defaults.map(({ batch_id, level }) => ({ batch_id, level })),
    ).toEqual([
      { batch_id: "chart_arithmetic", level: "low" },
      { batch_id: "chart_clean", level: "medium" },
    ]);
  });
});
