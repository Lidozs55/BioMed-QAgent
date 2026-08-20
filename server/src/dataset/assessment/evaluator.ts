import type {
  ProductArtifactFact,
  ProductAssessment,
  ProductBlocker,
  ProductConfidenceFact,
  ProductConfidenceRequirement,
  ProductCrossReferenceFact,
  ProductEntityFact,
  ProductEntityRequirement,
  ProductEvidenceFact,
  ProductEvidenceRequirement,
  ProductEvidenceSnapshot,
  ProductIdentifierRequirement,
  ProductProvenanceFact,
  ProductProvenanceRequirement,
  ProductRelationFact,
  ProductRelationRequirement,
  ProductRequirementManifest,
  ProductScore,
  ProductScoreDimension,
  ProductStatus,
} from "@biomed/contracts";

function ratio(satisfied: number, required: number): number {
  if (required === 0) return 1;
  return Number(Math.min(1, Math.max(0, satisfied / required)).toFixed(6));
}

function score(
  dimension: ProductScoreDimension,
  satisfied: number,
  required: number,
): ProductScore {
  return { dimension, satisfied, required, score: ratio(satisfied, required) };
}

function addBlocker(
  blockers: ProductBlocker[],
  requirementId: string,
  dimension: ProductScoreDimension,
  code: ProductBlocker["code"],
  message: string,
): void {
  blockers.push({
    requirement_id: requirementId,
    dimension,
    code,
    message,
  });
}

function entityFacts(
  facts: readonly ProductEntityFact[],
  requirement: ProductEntityRequirement,
): { satisfied: number; required: number } {
  const matching = facts.filter((fact) => fact.entity_type === requirement.entity_type);
  const satisfied = requirement.require_identity_closure
    ? matching.filter((fact) => fact.identity_closed).length
    : matching.length;
  return { satisfied, required: requirement.min_count };
}

function relationFacts(
  facts: readonly ProductRelationFact[],
  requirement: ProductRelationRequirement,
): { satisfied: number; required: number } {
  const matching = facts.filter((fact) =>
    fact.predicate === requirement.predicate &&
    (requirement.subject_type === undefined || fact.subject_type === requirement.subject_type) &&
    (requirement.object_type === undefined || fact.object_type === requirement.object_type) &&
    (!requirement.require_evidence || fact.evidence_refs.length > 0));
  return { satisfied: matching.length, required: requirement.min_count };
}

function evidenceFacts(
  facts: readonly ProductEvidenceFact[],
  requirement: ProductEvidenceRequirement,
): { satisfied: number; required: number } {
  return {
    satisfied: facts.filter((fact) => fact.evidence_type === requirement.evidence_type).length,
    required: requirement.min_count,
  };
}

function identifierFacts(
  entities: readonly ProductEntityFact[],
  crossReferences: readonly ProductCrossReferenceFact[],
  requirement: ProductIdentifierRequirement,
): { satisfied: number; required: number } {
  const entityIds = new Set(
    entities
      .filter((entity) => entity.entity_type === requirement.entity_type && entity.identity_closed)
      .map((entity) => entity.entity_id),
  );
  const namespaces = new Set(requirement.required_namespaces);
  const satisfied = [...entityIds].filter((entityId) => {
    const references = crossReferences.filter((reference) =>
      reference.entity_id === entityId && namespaces.has(reference.namespace) && !reference.conflict,
    );
    return references.length >= requirement.min_cross_references;
  }).length;
  return { satisfied, required: entityIds.size > 0 ? entityIds.size : 1 };
}

function provenanceFacts(
  facts: readonly ProductProvenanceFact[],
  requirement: ProductProvenanceRequirement,
): { satisfied: number; required: number } {
  const satisfied = facts.filter((fact) =>
    (!requirement.require_locator || fact.locator !== null) &&
    (!requirement.require_retrieved_at || fact.retrieved_at !== null) &&
    (!requirement.require_source_receipt || fact.source_receipt_id !== null) &&
    (!requirement.require_transform_digest || fact.transform_digest !== null),
  ).length;
  return { satisfied, required: requirement.min_complete_records };
}

function confidenceFacts(
  facts: readonly ProductConfidenceFact[],
  requirement: ProductConfidenceRequirement,
): { satisfied: number; required: number; pending: number } {
  const high = facts.filter((fact) => fact.level === "high").length;
  const pending = facts.filter((fact) => fact.review_status === "pending").length;
  const lowUnreviewed = facts.filter((fact) =>
    fact.level === "low" && fact.review_status !== "accepted" && fact.review_status !== "not_required",
  ).length;
  const highRatio = facts.length === 0 ? 0 : high / facts.length;
  const satisfied = highRatio >= requirement.min_high_confidence_ratio &&
    pending <= requirement.max_pending_reviews &&
    (!requirement.reject_unreviewed_low_confidence || lowUnreviewed === 0)
    ? 1
    : 0;
  return { satisfied, required: 1, pending };
}

function artifactFacts(
  facts: readonly ProductArtifactFact[],
  requirement: ProductRequirementManifest["artifacts"][number],
): { satisfied: number; required: number } {
  const roles = new Set(requirement.required_roles);
  const matching = facts.filter((fact) =>
    (!requirement.require_hashes || fact.sha256 !== null) &&
    (roles.size === 0 || roles.has(fact.role)),
  );
  return { satisfied: matching.length, required: Math.max(requirement.min_count, roles.size) };
}

export function assessProduct(
  requirements: ProductRequirementManifest,
  snapshot: ProductEvidenceSnapshot,
): ProductAssessment {
  const blockers: ProductBlocker[] = [];
  const scores: ProductScore[] = [];
  let schemaSatisfied = 0;
  const schemaRequired = requirements.entities.reduce((total, requirement) => total + requirement.min_count, 0) +
    requirements.evidence.reduce((total, requirement) => total + requirement.min_count, 0);

  for (const requirement of requirements.entities) {
    const result = entityFacts(snapshot.entities, requirement);
    schemaSatisfied += Math.min(result.satisfied, result.required);
    if (result.satisfied < result.required) {
      addBlocker(blockers, requirement.requirement_id, "schema", "missing_entities", `Missing ${requirement.entity_type} entities`);
    }
  }
  for (const requirement of requirements.evidence) {
    const result = evidenceFacts(snapshot.evidence, requirement);
    schemaSatisfied += Math.min(result.satisfied, result.required);
    if (result.satisfied < result.required) {
      addBlocker(blockers, requirement.requirement_id, "schema", "missing_evidence", `Missing ${requirement.evidence_type} evidence`);
    }
  }
  scores.push(score("schema", schemaSatisfied, schemaRequired));

  let relationSatisfied = 0;
  let relationRequired = 0;
  for (const requirement of requirements.relations) {
    const result = relationFacts(snapshot.relations, requirement);
    relationSatisfied += Math.min(result.satisfied, result.required);
    relationRequired += result.required;
    if (result.satisfied < result.required) {
      addBlocker(blockers, requirement.requirement_id, "relations", "missing_relations", `Missing ${requirement.predicate} relations`);
    }
  }
  scores.push(score("relations", relationSatisfied, relationRequired));

  let identifierSatisfied = 0;
  let identifierRequired = 0;
  for (const requirement of requirements.identifiers) {
    const result = identifierFacts(snapshot.entities, snapshot.cross_references, requirement);
    identifierSatisfied += result.satisfied;
    identifierRequired += result.required;
    if (result.satisfied < result.required) {
      addBlocker(blockers, requirement.requirement_id, "identifiers", "identity_not_closed", `Identity closure is incomplete for ${requirement.entity_type}`);
    }
    const conflicts = snapshot.cross_references.some((reference) => reference.entity_type === requirement.entity_type && reference.conflict);
    if (conflicts) {
      addBlocker(blockers, requirement.requirement_id, "identifiers", "cross_reference_not_closed", `Conflicting cross-references exist for ${requirement.entity_type}`);
    }
  }
  scores.push(score("identifiers", identifierSatisfied, identifierRequired));

  let provenanceSatisfied = 0;
  let provenanceRequired = 0;
  for (const requirement of requirements.provenance) {
    const result = provenanceFacts(snapshot.provenance, requirement);
    provenanceSatisfied += Math.min(result.satisfied, result.required);
    provenanceRequired += result.required;
    if (result.satisfied < result.required) {
      addBlocker(blockers, requirement.requirement_id, "provenance", "provenance_incomplete", "Provenance closure is incomplete");
    }
  }
  scores.push(score("provenance", provenanceSatisfied, provenanceRequired));

  let confidenceSatisfied = 0;
  let confidenceRequired = 0;
  for (const requirement of requirements.confidence) {
    const result = confidenceFacts(snapshot.confidence, requirement);
    confidenceSatisfied += result.satisfied;
    confidenceRequired += result.required;
    if (result.pending > requirement.max_pending_reviews) {
      addBlocker(blockers, requirement.requirement_id, "confidence", "human_review_pending", "Human confidence review is pending");
    } else if (result.satisfied < result.required) {
      addBlocker(blockers, requirement.requirement_id, "confidence", "confidence_below_threshold", "Confidence requirements are not satisfied");
    }
  }
  scores.push(score("confidence", confidenceSatisfied, confidenceRequired));

  let artifactSatisfied = 0;
  let artifactRequired = 0;
  for (const requirement of requirements.artifacts) {
    const result = artifactFacts(snapshot.artifacts, requirement);
    artifactSatisfied += Math.min(result.satisfied, result.required);
    artifactRequired += result.required;
    if (result.satisfied < result.required) {
      addBlocker(blockers, requirement.requirement_id, "reproducibility", "artifact_incomplete", "Required artifact roles or hashes are missing");
    }
  }
  scores.push(score("reproducibility", artifactSatisfied, artifactRequired));

  const semanticBlockers = blockers.filter((blocker) => blocker.dimension !== "reproducibility");
  const productStatus: ProductStatus = blockers.length === 0
    ? "publishable"
    : semanticBlockers.length === 0
      ? "validated"
      : "incomplete";

  return {
    schema_version: "1.0",
    requirement_id: requirements.requirement_id,
    package_id: requirements.package_id,
    package_version: requirements.package_version,
    product_status: productStatus,
    scores,
    missing_requirements: [...new Set(blockers.map((blocker) => blocker.requirement_id))].sort(),
    blockers,
  };
}
