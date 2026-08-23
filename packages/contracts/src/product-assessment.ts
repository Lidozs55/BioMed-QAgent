/**
 * Generic semantic product assessment contracts.
 *
 * These facts are package-neutral. Gold/evaluation profiles may consume them,
 * but production code must not encode a benchmark case in this contract.
 */

export type ProductStatus = "incomplete" | "validated" | "publishable";

export type ProductScoreDimension =
  | "schema"
  | "relations"
  | "identifiers"
  | "provenance"
  | "confidence"
  | "reproducibility";

export interface ProductScore {
  dimension: ProductScoreDimension;
  score: number;
  satisfied: number;
  required: number;
}

export interface ProductBlocker {
  requirement_id: string;
  dimension: ProductScoreDimension;
  code:
    | "missing_entities"
    | "missing_relations"
    | "missing_evidence"
    | "identity_not_closed"
    | "cross_reference_not_closed"
    | "provenance_incomplete"
    | "confidence_below_threshold"
    | "human_review_pending"
    | "artifact_incomplete";
  message: string;
}

export interface ProductEntityRequirement {
  requirement_id: string;
  entity_type: string;
  min_count: number;
  require_identity_closure: boolean;
}

export interface ProductRelationRequirement {
  requirement_id: string;
  predicate: string;
  subject_type?: string;
  object_type?: string;
  min_count: number;
  require_evidence: boolean;
}

export interface ProductEvidenceRequirement {
  requirement_id: string;
  evidence_type: string;
  min_count: number;
}

export interface ProductIdentifierRequirement {
  requirement_id: string;
  entity_type: string;
  required_namespaces: readonly string[];
  min_cross_references: number;
}

export interface ProductProvenanceRequirement {
  requirement_id: string;
  min_complete_records: number;
  require_locator: boolean;
  require_retrieved_at: boolean;
  require_source_receipt: boolean;
  require_transform_digest: boolean;
}

export interface ProductConfidenceRequirement {
  requirement_id: string;
  min_high_confidence_ratio: number;
  max_pending_reviews: number;
  reject_unreviewed_low_confidence: boolean;
}

export interface ProductArtifactRequirement {
  requirement_id: string;
  min_count: number;
  required_roles: readonly string[];
  require_hashes: boolean;
}

export interface ProductRequirementManifest {
  schema_version: "1.0";
  requirement_id: string;
  package_id: string;
  package_version: string;
  entities: readonly ProductEntityRequirement[];
  relations: readonly ProductRelationRequirement[];
  evidence: readonly ProductEvidenceRequirement[];
  identifiers: readonly ProductIdentifierRequirement[];
  provenance: readonly ProductProvenanceRequirement[];
  confidence: readonly ProductConfidenceRequirement[];
  artifacts: readonly ProductArtifactRequirement[];
}

export interface ProductEntityFact {
  entity_id: string;
  entity_type: string;
  identity_closed: boolean;
}

export interface ProductRelationFact {
  subject_id: string;
  subject_type: string;
  predicate: string;
  object_id: string;
  object_type: string;
  evidence_refs: readonly string[];
}

export interface ProductEvidenceFact {
  evidence_id: string;
  evidence_type: string;
}

export interface ProductCrossReferenceFact {
  entity_id: string;
  entity_type: string;
  namespace: string;
  match_confidence: "high" | "medium" | "low";
  conflict: boolean;
}

export interface ProductProvenanceFact {
  source_receipt_id: string | null;
  locator: string | null;
  retrieved_at: string | null;
  transform_digest: string | null;
}

export interface ProductConfidenceFact {
  level: "high" | "medium" | "low";
  review_status: "not_required" | "pending" | "accepted" | "rejected";
}

export interface ProductArtifactFact {
  artifact_id: string;
  role: string;
  sha256: string | null;
}

export interface ProductEvidenceSnapshot {
  entities: readonly ProductEntityFact[];
  relations: readonly ProductRelationFact[];
  evidence: readonly ProductEvidenceFact[];
  cross_references: readonly ProductCrossReferenceFact[];
  provenance: readonly ProductProvenanceFact[];
  confidence: readonly ProductConfidenceFact[];
  artifacts: readonly ProductArtifactFact[];
}

export interface ProductHumanReviewEvidence {
  policy_ref: string;
  request_id: string;
  review_id: string;
  evidence_digest: string;
  decision: "accept";
  reviewer: "user";
  reviewed_at: string;
  reason: string | null;
}

export interface ProductAssessment {
  schema_version: "1.0";
  requirement_id: string;
  package_id: string;
  package_version: string;
  product_status: ProductStatus;
  scores: readonly ProductScore[];
  missing_requirements: readonly string[];
  blockers: readonly ProductBlocker[];
  human_review_evidence?: readonly ProductHumanReviewEvidence[];
}
