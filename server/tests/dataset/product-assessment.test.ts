import { describe, expect, test } from "vitest";

import type {
  ProductEvidenceSnapshot,
  ProductRequirementManifest,
} from "@biomed/contracts";
import { assessProduct } from "../../src/dataset/assessment/evaluator.js";

const requirements: ProductRequirementManifest = {
  schema_version: "1.0",
  requirement_id: "expression-package-v1",
  package_id: "expression_evidence",
  package_version: "1.0",
  entities: [
    { requirement_id: "study", entity_type: "Study", min_count: 1, require_identity_closure: true },
    { requirement_id: "sample", entity_type: "Sample", min_count: 2, require_identity_closure: true },
  ],
  relations: [
    {
      requirement_id: "study_contains_sample",
      predicate: "contains",
      subject_type: "Study",
      object_type: "Sample",
      min_count: 2,
      require_evidence: false,
    },
  ],
  evidence: [
    { requirement_id: "expression_measurement", evidence_type: "ExpressionMeasurement", min_count: 1 },
  ],
  identifiers: [
    {
      requirement_id: "sample_gsm",
      entity_type: "Sample",
      required_namespaces: ["GEO"],
      min_cross_references: 1,
    },
  ],
  provenance: [
    {
      requirement_id: "source_trace",
      min_complete_records: 1,
      require_locator: true,
      require_retrieved_at: true,
      require_source_receipt: true,
      require_transform_digest: true,
    },
  ],
  confidence: [
    {
      requirement_id: "confidence_review",
      min_high_confidence_ratio: 1,
      max_pending_reviews: 0,
      reject_unreviewed_low_confidence: true,
    },
  ],
  artifacts: [
    { requirement_id: "primary_artifact", min_count: 1, required_roles: ["primary_dataset"], require_hashes: true },
  ],
};

const completeSnapshot: ProductEvidenceSnapshot = {
  entities: [
    { entity_id: "study_1", entity_type: "Study", identity_closed: true },
    { entity_id: "sample_1", entity_type: "Sample", identity_closed: true },
    { entity_id: "sample_2", entity_type: "Sample", identity_closed: true },
  ],
  relations: [
    { subject_id: "study_1", subject_type: "Study", predicate: "contains", object_id: "sample_1", object_type: "Sample", evidence_refs: [] },
    { subject_id: "study_1", subject_type: "Study", predicate: "contains", object_id: "sample_2", object_type: "Sample", evidence_refs: [] },
  ],
  evidence: [{ evidence_id: "measurement_1", evidence_type: "ExpressionMeasurement" }],
  cross_references: [
    { entity_id: "sample_1", entity_type: "Sample", namespace: "GEO", match_confidence: "high", conflict: false },
    { entity_id: "sample_2", entity_type: "Sample", namespace: "GEO", match_confidence: "high", conflict: false },
  ],
  provenance: [{ source_receipt_id: "receipt_1", locator: "https://example.test/source", retrieved_at: "2026-08-20T00:00:00Z", transform_digest: "a".repeat(64) }],
  confidence: [{ level: "high", review_status: "not_required" }],
  artifacts: [{ artifact_id: "artifact_1", role: "primary_dataset", sha256: "b".repeat(64) }],
};

describe("assessProduct", () => {
  test("returns publishable only when semantic and reproducibility requirements close", () => {
    const assessment = assessProduct(requirements, completeSnapshot);
    expect(assessment.product_status).toBe("publishable");
    expect(assessment.blockers).toEqual([]);
    expect(assessment.missing_requirements).toEqual([]);
    expect(assessment.scores.every((score) => score.score === 1)).toBe(true);
  });

  test("reports missing relation, identity, provenance, confidence, and artifact blockers", () => {
    const assessment = assessProduct(requirements, {
      ...completeSnapshot,
      relations: [],
      cross_references: [],
      provenance: [{ source_receipt_id: null, locator: null, retrieved_at: null, transform_digest: null }],
      confidence: [{ level: "low", review_status: "pending" }],
      artifacts: [],
    });
    expect(assessment.product_status).toBe("incomplete");
    expect(assessment.blockers.map((blocker) => blocker.code)).toEqual(expect.arrayContaining([
      "missing_relations",
      "identity_not_closed",
      "provenance_incomplete",
      "human_review_pending",
      "artifact_incomplete",
    ]));
    expect(assessment.scores.find((score) => score.dimension === "relations")?.score).toBe(0);
  });

  test("can distinguish validated semantics from missing reproducible artifacts", () => {
    const assessment = assessProduct(requirements, {
      ...completeSnapshot,
      artifacts: [],
    });
    expect(assessment.product_status).toBe("validated");
    expect(assessment.blockers).toEqual([
      expect.objectContaining({ code: "artifact_incomplete" }),
    ]);
  });
});
