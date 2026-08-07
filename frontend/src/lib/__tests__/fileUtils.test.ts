import { describe, expect, it } from "vitest";

import { fileType } from "@/lib/fileUtils";

describe("fileType", () => {
  // --- Role-based labels (T8+) ---
  it("labels primary_dataset by role", () => {
    const meta = fileType("results.csv", "primary_dataset");
    expect(meta.label).toBe("主数据");
  });

  it("labels supporting_dataset by role", () => {
    const meta = fileType("extra.csv", "supporting_dataset");
    expect(meta.label).toBe("辅助数据");
  });

  it("labels audit_report by role", () => {
    const meta = fileType("cleaning.csv", "audit_report");
    expect(meta.label).toBe("审计报告");
  });

  it("labels schema by role", () => {
    const meta = fileType("schema.json", "schema");
    expect(meta.label).toBe("结构定义");
  });

  it("labels provenance by role", () => {
    const meta = fileType("mapping.csv", "provenance");
    expect(meta.label).toBe("溯源信息");
  });

  // --- Extension-only fallback (no role, unknown filename) ---
  it("labels by extension when role is absent", () => {
    const meta = fileType("unknown.csv");
    expect(meta.label).toBe("CSV");
  });

  it("labels JSON by extension when role is absent", () => {
    const meta = fileType("config.json");
    expect(meta.label).toBe("JSON");
  });

  // --- Legacy filename fallback (ITEM2) ---
  it("labels main_data.csv as 主数据 when role is absent", () => {
    const meta = fileType("main_data.csv");
    expect(meta.label).toBe("主数据");
  });

  it("labels sample_metadata.csv as 辅助数据 when role is absent", () => {
    const meta = fileType("sample_metadata.csv");
    expect(meta.label).toBe("辅助数据");
  });

  it("labels source_list.csv as 审计报告 when role is absent", () => {
    const meta = fileType("source_list.csv");
    expect(meta.label).toBe("审计报告");
  });

  it("labels cleaning_report.csv as 审计报告 when role is absent", () => {
    const meta = fileType("cleaning_report.csv");
    expect(meta.label).toBe("审计报告");
  });

  it("labels quality_report.csv as 审计报告 when role is absent", () => {
    const meta = fileType("quality_report.csv");
    expect(meta.label).toBe("审计报告");
  });

  it("labels source_relations.csv as 审计报告 when role is absent", () => {
    const meta = fileType("source_relations.csv");
    expect(meta.label).toBe("审计报告");
  });

  it("labels source_assets.csv as 审计报告 when role is absent", () => {
    const meta = fileType("source_assets.csv");
    expect(meta.label).toBe("审计报告");
  });

  it("labels schema.json as 结构定义 when role is absent", () => {
    const meta = fileType("schema.json");
    expect(meta.label).toBe("结构定义");
  });

  it("labels field_descriptions.csv as 结构定义 when role is absent", () => {
    const meta = fileType("field_descriptions.csv");
    expect(meta.label).toBe("结构定义");
  });

  it("labels field_mapping.csv as 溯源信息 when role is absent", () => {
    const meta = fileType("field_mapping.csv");
    expect(meta.label).toBe("溯源信息");
  });

  it("labels run_manifest.json as 结构定义 when role is absent", () => {
    const meta = fileType("run_manifest.json");
    expect(meta.label).toBe("结构定义");
  });

  // --- Role takes priority over filename fallback ---
  it("role label takes priority over filename fallback", () => {
    // main_data.csv would be 主数据 by filename, but role provenance wins
    const meta = fileType("main_data.csv", "provenance");
    expect(meta.label).toBe("溯源信息");
  });

  // --- Unknown extension with no role or filename ---
  it("labels unknown extension with no role", () => {
    const meta = fileType("data.parquet");
    expect(meta.label).toBe("PARQUET");
  });
});
