export const CLEANING_RULES_SCHEMA_VERSION = "1.0" as const;
export type CleaningRuleKind = "unit_conversion" | "field_mapping";

export interface UnitConversionProposal {
  kind: "unit_conversion";
  proposal_id: string;
  binding_id: string;
  from_unit: string;
  to_unit: string;
  factor: number;
  offset: number;
  evidence: string;
}

export interface FieldMappingProposal {
  kind: "field_mapping";
  proposal_id: string;
  binding_id: string;
  source_schema_ref: string;
  target_schema_ref: string;
  source_field: string;
  target_field: string;
  transform: string;
  candidate_set_digest: string | null;
  evidence: string;
}

export type CleaningRuleProposal = UnitConversionProposal | FieldMappingProposal;

export interface CleaningRulePreflightReceipt {
  schema_version: typeof CLEANING_RULES_SCHEMA_VERSION;
  task_id: string;
  run_id: string;
  requirement_id: string;
  proposals_digest: string;
  accepted: CleaningRuleProposal[];
  needs_review: CleaningRuleProposal[];
  receipt_digest: string;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

function object(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: readonly string[], name: string): void {
  const extras = Object.keys(value).filter((key) => !keys.includes(key));
  if (extras.length > 0) throw new TypeError(`${name} has unknown fields: ${extras.join(", ")}`);
}

function id(value: unknown, name: string): string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) throw new TypeError(`${name} must be a safe identifier`);
  return value;
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be non-empty`);
  return value;
}

function finite(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError(`${name} must be finite`);
  return value;
}


export function parseCleaningRuleProposal(value: unknown): CleaningRuleProposal {
  const record = object(value, "CleaningRuleProposal");
  const kind = record.kind;
  if (kind === "unit_conversion") {
    exact(record, ["kind", "proposal_id", "binding_id", "from_unit", "to_unit", "factor", "offset", "evidence"], "UnitConversionProposal");
    return {
      kind,
      proposal_id: id(record.proposal_id, "proposal_id"),
      binding_id: id(record.binding_id, "binding_id"),
      from_unit: text(record.from_unit, "from_unit"),
      to_unit: text(record.to_unit, "to_unit"),
      factor: finite(record.factor, "factor"),
      offset: finite(record.offset, "offset"),
      evidence: text(record.evidence, "evidence"),
    };
  }
  if (kind === "field_mapping") {
    exact(record, ["kind", "proposal_id", "binding_id", "source_schema_ref", "target_schema_ref", "source_field", "target_field", "transform", "candidate_set_digest", "evidence"], "FieldMappingProposal");
    const candidateSetDigest = record.candidate_set_digest;
    if (candidateSetDigest !== null && (typeof candidateSetDigest !== "string" || !SHA256.test(candidateSetDigest))) {
      throw new TypeError("candidate_set_digest must be null or a SHA-256 digest");
    }
    return {
      kind,
      proposal_id: id(record.proposal_id, "proposal_id"),
      binding_id: id(record.binding_id, "binding_id"),
      source_schema_ref: text(record.source_schema_ref, "source_schema_ref"),
      target_schema_ref: text(record.target_schema_ref, "target_schema_ref"),
      source_field: text(record.source_field, "source_field"),
      target_field: text(record.target_field, "target_field"),
      transform: text(record.transform, "transform"),
      candidate_set_digest: candidateSetDigest,
      evidence: text(record.evidence, "evidence"),
    };
  }
  throw new TypeError("CleaningRuleProposal.kind is invalid");
}

export function parseCleaningRuleProposals(value: unknown): CleaningRuleProposal[] {
  if (!Array.isArray(value)) throw new TypeError("cleaning proposals must be an array");
  const proposals = value.map(parseCleaningRuleProposal);
  const ids = new Set<string>();
  for (const proposal of proposals) {
    if (ids.has(proposal.proposal_id)) throw new TypeError("cleaning proposal ids must be unique");
    ids.add(proposal.proposal_id);
  }
  return proposals;
}

export function parseCleaningRulePreflightReceipt(value: unknown): CleaningRulePreflightReceipt {
  const record = object(value, "CleaningRulePreflightReceipt");
  exact(record, ["schema_version", "task_id", "run_id", "requirement_id", "proposals_digest", "accepted", "needs_review", "receipt_digest"], "CleaningRulePreflightReceipt");
  if (record.schema_version !== CLEANING_RULES_SCHEMA_VERSION) throw new TypeError("unsupported cleaning rules schema_version");
  const proposalsDigest = record.proposals_digest;
  const receiptDigest = record.receipt_digest;
  if (typeof proposalsDigest !== "string" || !SHA256.test(proposalsDigest)) throw new TypeError("proposals_digest must be a SHA-256 digest");
  if (typeof receiptDigest !== "string" || !SHA256.test(receiptDigest)) throw new TypeError("receipt_digest must be a SHA-256 digest");
  return {
    schema_version: CLEANING_RULES_SCHEMA_VERSION,
    task_id: id(record.task_id, "task_id"),
    run_id: id(record.run_id, "run_id"),
    requirement_id: id(record.requirement_id, "requirement_id"),
    proposals_digest: proposalsDigest,
    accepted: parseCleaningRuleProposals(record.accepted),
    needs_review: parseCleaningRuleProposals(record.needs_review),
    receipt_digest: receiptDigest,
  };
}
