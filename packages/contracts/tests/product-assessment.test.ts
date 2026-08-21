import { describe, expect, test } from "vitest";

import {
  parseProductAssessment,
  type ProductAssessment,
} from "../src/index.js";

function assessment(overrides: Partial<ProductAssessment> = {}): ProductAssessment {
  return {
    schema_version: "1.0",
    requirement_id: "bioactivity_identity.release.v1",
    package_id: "bioactivity_identity",
    package_version: "1.0",
    product_status: "publishable",
    scores: [
      { dimension: "schema", score: 1, satisfied: 2, required: 2 },
      { dimension: "relations", score: 1, satisfied: 1, required: 1 },
      { dimension: "identifiers", score: 1, satisfied: 1, required: 1 },
      { dimension: "provenance", score: 1, satisfied: 2, required: 2 },
      { dimension: "confidence", score: 1, satisfied: 1, required: 1 },
      { dimension: "reproducibility", score: 1, satisfied: 2, required: 2 },
    ],
    missing_requirements: [],
    blockers: [],
    ...overrides,
  };
}

describe("ProductAssessment runtime contract", () => {
  test("strictly parses and deterministically orders a publishable assessment", () => {
    const value = assessment({ scores: [...assessment().scores].reverse() });
    expect(parseProductAssessment(value)).toEqual(assessment());
  });

  test("accepts validated only for reproducibility blockers", () => {
    const parsed = parseProductAssessment(assessment({
      product_status: "validated",
      scores: assessment().scores.map((score) => score.dimension === "reproducibility"
        ? { ...score, score: 0, satisfied: 0 }
        : score),
      missing_requirements: ["identity_artifacts"],
      blockers: [{
        requirement_id: "identity_artifacts",
        dimension: "reproducibility",
        code: "artifact_incomplete",
        message: "Required artifact roles or hashes are missing",
      }],
    }));
    expect(parsed.product_status).toBe("validated");
  });

  test("accepts incomplete semantic blockers and sorts blocker output", () => {
    const parsed = parseProductAssessment(assessment({
      product_status: "incomplete",
      missing_requirements: ["pubchem_identity", "compound_identity"],
      blockers: [
        {
          requirement_id: "pubchem_identity",
          dimension: "identifiers",
          code: "cross_reference_not_closed",
          message: "Conflicting cross-references exist",
        },
        {
          requirement_id: "compound_identity",
          dimension: "schema",
          code: "missing_entities",
          message: "Missing Compound entities",
        },
      ],
    }));
    expect(parsed.missing_requirements).toEqual(["compound_identity", "pubchem_identity"]);
    expect(parsed.blockers.map((blocker) => blocker.requirement_id)).toEqual([
      "compound_identity",
      "pubchem_identity",
    ]);
  });

  test.each([
    { extra: true },
    { schema_version: "2.0" },
    { product_status: "unknown" },
    { scores: [] },
    { scores: [{ dimension: "schema", score: 2, satisfied: 1, required: 1 }] },
  ])("rejects malformed top-level assessments: %o", (override) => {
    expect(() => parseProductAssessment({ ...assessment(), ...override })).toThrow();
  });

  test("rejects duplicate dimensions and invalid status combinations", () => {
    expect(() => parseProductAssessment(assessment({
      scores: [assessment().scores[0]!, assessment().scores[0]!],
    }))).toThrow(/dimension/i);
    expect(() => parseProductAssessment(assessment({
      product_status: "publishable",
      missing_requirements: ["identity_artifacts"],
      blockers: [{
        requirement_id: "identity_artifacts",
        dimension: "reproducibility",
        code: "artifact_incomplete",
        message: "missing",
      }],
    }))).toThrow(/publishable/i);
    expect(() => parseProductAssessment(assessment({
      product_status: "validated",
      missing_requirements: ["compound_identity"],
      blockers: [{
        requirement_id: "compound_identity",
        dimension: "schema",
        code: "missing_entities",
        message: "missing",
      }],
    }))).toThrow(/validated/i);
  });

  test("rejects duplicate missing requirements and blockers", () => {
    const blocker = {
      requirement_id: "compound_identity",
      dimension: "schema" as const,
      code: "missing_entities" as const,
      message: "Missing Compound entities",
    };
    expect(() => parseProductAssessment(assessment({
      product_status: "incomplete",
      missing_requirements: ["compound_identity", "compound_identity"],
      blockers: [blocker],
    }))).toThrow(/duplicates/i);
    expect(() => parseProductAssessment(assessment({
      product_status: "incomplete",
      missing_requirements: ["compound_identity"],
      blockers: [blocker, blocker],
    }))).toThrow(/duplicates/i);
  });

  test("rejects unknown fields and malformed blocker codes", () => {
    expect(() => parseProductAssessment({ ...assessment(), unexpected: true })).toThrow(/field/i);
    expect(() => parseProductAssessment(assessment({
      product_status: "incomplete",
      missing_requirements: ["compound_identity"],
      blockers: [{
        requirement_id: "compound_identity",
        dimension: "schema",
        code: "unknown" as ProductAssessment["blockers"][number]["code"],
        message: "missing",
      }],
    }))).toThrow(/code/i);
  });
});
