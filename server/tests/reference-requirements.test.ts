import { describe, expect, test } from "vitest";

import {
  parseReferenceRequirements,
  type ReferenceRequirements,
} from "../src/evaluation/reference-requirements.js";

const baseReference = {
  schema_id: "fixture-reference",
  version: "1",
  family: "example_family",
  tables: [
    {
      table_id: "measurements",
      role: "primary",
      granularity: "one measurement per sample",
      primary_key: ["sample_id", "feature_id"],
      columns: ["sample_id", "feature_id", "value"],
    },
    {
      table_id: "samples",
      role: "supporting",
      granularity: "one row per sample",
      primary_key: ["sample_id"],
      columns: ["sample_id", "source_id"],
      allow_empty: true,
    },
  ],
  relations: [
    {
      from: "measurements.sample_id",
      to: "samples.sample_id",
      cardinality: "many_to_one",
      missing: "reject",
    },
  ],
  required_provenance: ["source_asset_id", "source_locator"],
  confidence_policy: "Unresolved values block publication",
};

describe("parseReferenceRequirements", () => {
  test("normalizes generic tables, relations, provenance, and uncheckable policy", () => {
    const result = parseReferenceRequirements(baseReference);
    expect(result.tables.map((table) => table.table_id)).toEqual(["measurements", "samples"]);
    expect(result.tables[0]?.primary_key).toEqual(["feature_id", "sample_id"]);
    expect(result.tables[0]?.columns).toEqual(["feature_id", "sample_id", "value"]);
    expect(result.tables[1]?.allow_empty).toBe(true);
    expect(result.required_provenance).toEqual(["source_asset_id", "source_locator"]);
    expect(result.uncheckable).toEqual([
      expect.objectContaining({ requirement_id: "confidence_policy" }),
    ]);
  });

  test("preserves bounded optional contracts but marks their evaluation uncheckable", () => {
    const result = parseReferenceRequirements({
      ...baseReference,
      derived_contract: {
        algorithm_id: "fixed_v1",
        parameters: ["cutoff"],
        input_asset_digest_required: true,
      },
      measurement_contract: {
        raw_value_required: true,
        allowed_relations: ["=", "<", null],
      },
      chart_contract: {
        review_required: true,
      },
    });
    expect(Object.keys(result.optional_contracts)).toEqual([
      "chart_contract",
      "derived_contract",
      "measurement_contract",
    ]);
    expect(result.uncheckable.map((item) => item.requirement_id)).toEqual([
      "chart_contract",
      "confidence_policy",
      "derived_contract",
      "measurement_contract",
    ]);
  });

  test("produces the same normalized result regardless of input ordering", () => {
    const reversed = {
      ...baseReference,
      tables: [...baseReference.tables].reverse().map((table) => ({
        ...table,
        columns: [...table.columns].reverse(),
        primary_key: [...table.primary_key].reverse(),
      })),
      required_provenance: [...baseReference.required_provenance].reverse(),
    };
    expect(parseReferenceRequirements(reversed)).toEqual(parseReferenceRequirements(baseReference));
  });

  test.each([
    { ...baseReference, extra: true },
    { ...baseReference, tables: [{ ...baseReference.tables[0], extra: true }, baseReference.tables[1]] },
    { ...baseReference, tables: [baseReference.tables[0], baseReference.tables[0]] },
    { ...baseReference, tables: [{ ...baseReference.tables[0], primary_key: ["missing"] }, baseReference.tables[1]] },
    { ...baseReference, relations: [{ ...baseReference.relations[0], cardinality: "invalid" }] },
    { ...baseReference, tables: [{ ...baseReference.tables[0], allow_empty: 1 }, baseReference.tables[1]] },
  ])("rejects malformed or ambiguous requirements: %o", (value) => {
    expect(() => parseReferenceRequirements(value)).toThrow();
  });

  test("rejects unbounded optional metadata", () => {
    const tooDeep = { value: { value: { value: { value: { value: true } } } } };
    expect(() => parseReferenceRequirements({
      ...baseReference,
      derived_contract: tooDeep,
    })).toThrow(/depth limit/);
  });

  test("parses all frozen reference files without registering them as production families", async () => {
    const references = await Promise.all(
      ["gold1", "gold2", "gold3", "gold4", "gold5", "gold6"].map(async (caseId) => {
        const url = new URL(`../../docs/evaluation/gold-v1/schemas/${caseId}-reference.json`, import.meta.url);
        return parseReferenceRequirements(await import(url.href, { with: { type: "json" } }).then((module) => module.default));
      }),
    );
    expect(references).toHaveLength(6);
    expect(references.every((reference: ReferenceRequirements) => reference.tables.length > 0)).toBe(true);
  });
});
