import { createHash } from "node:crypto";

import type {
  FieldMappingProposal,
  UnitConversionProposal,
} from "@biomed/contracts";
import { parseCleaningRuleProposals } from "@biomed/contracts";

import { NORMALIZATION_PROFILES } from "../canonicalizer/profiles.js";
import type { DatasetFamilyRegistry } from "../families/registry.js";
import { rankMappingCandidates } from "./string-similarity.js";

export type CleaningRuleDecision = "accepted_registered_rule" | "needs_hil" | "rejected";

export interface CleaningRulePreflightItem {
  proposal_id: string;
  decision: CleaningRuleDecision;
  reason: string;
  rule_id: string | null;
  candidate_set_digest: string | null;
}

export interface CleaningRulePreflightResult {
  proposals_digest: string;
  items: CleaningRulePreflightItem[];
  candidate_sets: Record<string, ReturnType<typeof rankMappingCandidates>>;
  receipt_digest: string | null;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function schemaFields(
  registry: DatasetFamilyRegistry,
  proposal: FieldMappingProposal,
): string[] {
  for (const definition of registry.definitionsList()) {
    const schema = definition.schemas.find((candidate) => candidate.schema_id === proposal.target_schema_ref);
    if (schema !== undefined) return schema.fields.map((field) => field.name);
  }
  return [];
}

function registeredUnitRule(
  proposal: UnitConversionProposal,
): { ruleId: string; reason: string } | null {
  const matches = Object.values(NORMALIZATION_PROFILES).flatMap((profile) =>
    profile.unit_conversions
      .filter((rule) => rule.from_unit === proposal.from_unit && rule.to_unit === proposal.to_unit)
      .map((rule) => ({ profile, rule })),
  );
  if (matches.length !== 1) return null;
  const { profile, rule } = matches[0]!;
  if (!profile.allowed_units.includes(proposal.to_unit)) return null;
  const formula = rule.formula.trim().toLowerCase();
  const expected = proposal.offset === 0
    ? `value * ${proposal.factor}`
    : null;
  if (expected === null || formula !== expected) return null;
  return { ruleId: rule.rule_id, reason: "unique registered normalization rule" };
}

export function preflightCleaningRules(
  registry: DatasetFamilyRegistry,
  value: unknown,
): CleaningRulePreflightResult {
  const proposals = parseCleaningRuleProposals(value);
  const proposalsDigest = digest(proposals);
  const candidateSets: Record<string, ReturnType<typeof rankMappingCandidates>> = {};
  const items = proposals.map((proposal): CleaningRulePreflightItem => {
    if (proposal.kind === "unit_conversion") {
      const registered = registeredUnitRule(proposal);
      return registered === null
        ? {
            proposal_id: proposal.proposal_id,
            decision: "needs_hil",
            reason: "unit conversion does not match a unique registered rule",
            rule_id: null,
            candidate_set_digest: null,
          }
        : {
            proposal_id: proposal.proposal_id,
            decision: "accepted_registered_rule",
            reason: registered.reason,
            rule_id: registered.ruleId,
            candidate_set_digest: null,
          };
    }
    const targets = schemaFields(registry, proposal);
    const candidateSet = rankMappingCandidates([proposal.source_field], targets);
    candidateSets[proposal.proposal_id] = candidateSet;
    const candidate = candidateSet.candidates.find((entry) => entry.target_field === proposal.target_field && entry.rank === 1);
    const digestMatches = proposal.candidate_set_digest === null || proposal.candidate_set_digest === candidateSet.digest;
    const unique = candidateSet.states[proposal.source_field] === "accepted_candidate";
    if (candidate === undefined || !unique || !digestMatches) {
      return {
        proposal_id: proposal.proposal_id,
        decision: "needs_hil",
        reason: candidate === undefined ? "target is not the unique top candidate" : "mapping candidate is ambiguous or stale",
        rule_id: null,
        candidate_set_digest: candidateSet.digest,
      };
    }
    if (
      proposal.source_schema_ref === proposal.target_schema_ref &&
      proposal.source_field === proposal.target_field &&
      proposal.transform === "identity"
    ) {
      return {
        proposal_id: proposal.proposal_id,
        decision: "accepted_registered_rule",
        reason: "exact schema-registered identity mapping",
        rule_id: `schema.${proposal.target_schema_ref}.${proposal.target_field}.identity`,
        candidate_set_digest: candidateSet.digest,
      };
    }
    return {
      proposal_id: proposal.proposal_id,
      decision: "needs_hil",
      reason: "unique similarity candidate has no registered semantic mapping rule",
      rule_id: null,
      candidate_set_digest: candidateSet.digest,
    };
  });
  return {
    proposals_digest: proposalsDigest,
    items,
    candidate_sets: candidateSets,
    receipt_digest: items.some((item) => item.decision === "accepted_registered_rule")
      ? digest({ proposals_digest: proposalsDigest, items })
      : null,
  };
}
