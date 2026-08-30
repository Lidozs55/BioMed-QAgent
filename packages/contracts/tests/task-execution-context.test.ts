import { describe, expect, expectTypeOf, it } from "vitest";

import {
  FROZEN_EVALUATION_CONTEXT_KIND,
  parseTaskExecutionContext,
  stableTaskExecutionContextJson,
  TASK_EXECUTION_CONTEXT_SCHEMA_VERSION,
  type FrozenEvaluationContextV1,
  type TaskExecutionContext,
} from "../src/index";

/**
 * The exact Gold6 context derived from the frozen files under
 * docs/evaluation/gold-v1 (manifest.json, cases/gold6.json, prompts/gold6.txt,
 * runtime-defaults.json, sources/gold6.sources.json).
 */
const GOLD6_PROMPT_SHA256 = "f30ab31099da23c75a3e0037ee303b8814c7c124bc1e84be149d2c6f4c8fc298";
const GOLD6_MANIFEST_SHA256 = "dc0fe05616f573964a66b1c805f95a8595107c610599afecc4d43ba29fa640c1";
const GOLD6_CASE_SPEC_SHA256 = "77a3ec65c9759d2492090af5586b2ce2c94f78a753f09e9749e84f98a00fe520";
const GOLD6_RUNTIME_SHA256 = "70aa7f218239f4b5218ca1eb2ae0091148a3df5c3361dc16e0e60c869f028a44";

const FROZEN_GOLD6_CASE = { case_id: "gold6", prompt_sha256: GOLD6_PROMPT_SHA256 };

function gold6Context(): Record<string, unknown> {
  return {
    schema_version: TASK_EXECUTION_CONTEXT_SCHEMA_VERSION,
    kind: FROZEN_EVALUATION_CONTEXT_KIND,
    manifest_id: "gold-v1",
    case_id: "gold6",
    manifest_sha256: GOLD6_MANIFEST_SHA256,
    case_spec_sha256: GOLD6_CASE_SPEC_SHA256,
    prompt_sha256: GOLD6_PROMPT_SHA256,
    runtime_profile_sha256: GOLD6_RUNTIME_SHA256,
    expected_family: "bioactivity_measurement",
    required_tables: [
      "paper_records",
      "experiment_records",
      "activity_value_records",
      "chart_series",
      "chart_points",
      "supplementary_asset_records",
    ],
    allowed_sources: ["PubMed", "PubMed Central", "Europe PMC", "RCSB PDB for verification only"],
    source_selection: { papers: ["PMC10408569", "PMC5355725", "PMC5094958"] },
    success_definition:
      "A registered bioactivity publication preserves paper/table/figure locators, raw relation " +
      "tokens, confidence and human-review state; low-confidence chart values are blocked until " +
      "accepted; Artifact API hashes are reverified.",
    forbidden_shortcuts: [
      "estimated chart points treated as exact without review",
      "workspace CSV as publication",
      "missing locator filled from model prior",
      "prompt modification",
    ],
  };
}

describe("frozen evaluation execution context", () => {
  it("parses the exact Gold6 context and returns a frozen object graph", () => {
    const context = parseTaskExecutionContext(
      gold6Context(),
      "task_execution_context",
      FROZEN_GOLD6_CASE,
    );
    expect(context.case_id).toBe("gold6");
    expect(context.manifest_id).toBe("gold-v1");
    expect(context.expected_family).toBe("bioactivity_measurement");
    expect(context.source_selection.papers).toEqual(["PMC10408569", "PMC5355725", "PMC5094958"]);
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.required_tables)).toBe(true);
    expect(Object.isFrozen(context.allowed_sources)).toBe(true);
    expect(Object.isFrozen(context.forbidden_shortcuts)).toBe(true);
    expect(Object.isFrozen(context.source_selection)).toBe(true);
    expect(Object.isFrozen(context.source_selection.papers)).toBe(true);
    expectTypeOf<TaskExecutionContext["schema_version"]>().toEqualTypeOf<"1.0">();
    expectTypeOf<TaskExecutionContext["kind"]>().toEqualTypeOf<"frozen_evaluation">();
    expectTypeOf<FrozenEvaluationContextV1["source_selection"]>().toEqualTypeOf<
      Readonly<Record<string, readonly string[]>>
    >();
  });

  it("rejects unknown top-level keys", () => {
    const value = gold6Context();
    value.allowed_tools = ["workspace_exec"];
    expect(() => parseTaskExecutionContext(value)).toThrow(/Unknown field "allowed_tools"/);
  });

  it.each([
    ["missing manifest_sha256", (value: Record<string, unknown>) => { delete value.manifest_sha256; }],
    ["missing case_spec_sha256", (value: Record<string, unknown>) => { delete value.case_spec_sha256; }],
    ["missing prompt_sha256", (value: Record<string, unknown>) => { delete value.prompt_sha256; }],
    ["missing runtime_profile_sha256", (value: Record<string, unknown>) => { delete value.runtime_profile_sha256; }],
    ["non-hex prompt_sha256", (value: Record<string, unknown>) => { value.prompt_sha256 = "f30ab310"; }],
    ["wrong schema_version", (value: Record<string, unknown>) => { value.schema_version = "2.0"; }],
    ["wrong kind", (value: Record<string, unknown>) => { value.kind = "advisory_notes"; }],
    ["empty case_id", (value: Record<string, unknown>) => { value.case_id = ""; }],
    ["required_tables not an array", (value: Record<string, unknown>) => { value.required_tables = "paper_records"; }],
    ["missing success_definition", (value: Record<string, unknown>) => { delete value.success_definition; }],
    ["missing forbidden_shortcuts", (value: Record<string, unknown>) => { delete value.forbidden_shortcuts; }],
  ])("rejects hostile wire: %s", (_name, mutate) => {
    const value = gold6Context();
    mutate(value);
    expect(() => parseTaskExecutionContext(value)).toThrow();
  });

  it("rejects duplicate required tables", () => {
    const value = gold6Context();
    value.required_tables = ["paper_records", "chart_series", "paper_records"];
    expect(() => parseTaskExecutionContext(value)).toThrow(/duplicate "paper_records"/u);
  });

  it("rejects URL or path shaped source identifiers", () => {
    const urlSource = gold6Context();
    urlSource.allowed_sources = ["https://pubmed.ncbi.nlm.nih.gov"];
    expect(() => parseTaskExecutionContext(urlSource)).toThrow(/URL or path syntax.*allowed_sources/u);

    const pathTable = gold6Context();
    pathTable.required_tables = ["paper_records", "tables/paper_records"];
    expect(() => parseTaskExecutionContext(pathTable)).toThrow(/URL or path syntax/u);

    const windowsPathTable = gold6Context();
    windowsPathTable.required_tables = ["C:\\data\\paper_records"];
    expect(() => parseTaskExecutionContext(windowsPathTable)).toThrow(/URL or path syntax/u);

    const pathSelection = gold6Context();
    pathSelection.source_selection = { papers: ["PMC10408569/fullTextXML"] };
    expect(() => parseTaskExecutionContext(pathSelection)).toThrow(/URL or path syntax/u);

    const pathSelectionKey = gold6Context();
    pathSelectionKey.source_selection = { "papers/xml": ["PMC10408569"] };
    expect(() => parseTaskExecutionContext(pathSelectionKey)).toThrow(/URL or path syntax/u);
  });

  it("rejects a context whose prompt_sha256 or case_id differs from the frozen case", () => {
    const mutatedPrompt = gold6Context();
    mutatedPrompt.prompt_sha256 = "b".repeat(64);
    expect(() =>
      parseTaskExecutionContext(mutatedPrompt, "task_execution_context", FROZEN_GOLD6_CASE),
    ).toThrow(/frozen case/u);
    const mutatedCase = gold6Context();
    mutatedCase.case_id = "gold5";
    expect(() =>
      parseTaskExecutionContext(mutatedCase, "task_execution_context", FROZEN_GOLD6_CASE),
    ).toThrow(/frozen case/u);
    // Without a frozen-case reference the parser stays structural: the frozen
    // match is enforced where the frozen case is known (the evaluation runner).
    expect(parseTaskExecutionContext(mutatedPrompt).prompt_sha256).toBe("b".repeat(64));
  });

  it("rejects corrupted UTF-8 text and oversized fields", () => {
    const loneSurrogate = gold6Context();
    loneSurrogate.success_definition = "bad \uD800 surrogate";
    expect(() => parseTaskExecutionContext(loneSurrogate)).toThrow(/well-formed Unicode/u);
    const replacement = gold6Context();
    replacement.success_definition = "corrupted \uFFFD bytes";
    expect(() => parseTaskExecutionContext(replacement)).toThrow(/U\+FFFD/u);
    const oversized = gold6Context();
    oversized.success_definition = "x".repeat(1_048_577);
    expect(() => parseTaskExecutionContext(oversized)).toThrow(/exceeds/u);
  });

  it("serializes with stable key order regardless of input key order", () => {
    const context = parseTaskExecutionContext(gold6Context());
    const shuffled = parseTaskExecutionContext(
      Object.fromEntries(Object.entries(gold6Context()).reverse()),
    );
    expect(stableTaskExecutionContextJson(shuffled)).toBe(stableTaskExecutionContextJson(context));
    expect(Object.keys(JSON.parse(stableTaskExecutionContextJson(context)))).toEqual([
      "schema_version",
      "kind",
      "manifest_id",
      "case_id",
      "manifest_sha256",
      "case_spec_sha256",
      "prompt_sha256",
      "runtime_profile_sha256",
      "expected_family",
      "required_tables",
      "allowed_sources",
      "source_selection",
      "success_definition",
      "forbidden_shortcuts",
    ]);
    const unsortedSelection = parseTaskExecutionContext({
      ...gold6Context(),
      source_selection: { zeta: ["PMC10408569"], alpha: ["EGFR"] },
    });
    const parsedSelection = JSON.parse(stableTaskExecutionContextJson(unsortedSelection)) as {
      source_selection: Record<string, unknown>;
    };
    expect(Object.keys(parsedSelection.source_selection)).toEqual(["alpha", "zeta"]);
  });
});
