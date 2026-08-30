import { createHash } from "node:crypto";

import type {
  CleaningRulePreflightReceipt,
  FieldMappingProposal,
  UnitConversionProposal,
} from "@biomed/contracts";
import {
  parseCleaningRulePreflightReceipt,
  parseCleaningRuleProposals,
} from "@biomed/contracts";

import { NORMALIZATION_PROFILES } from "../canonicalizer/profiles.js";
import type { DatasetFamilyRegistry } from "../families/registry.js";
import { registeredUnitCorrection } from "../review/hil-policy.js";
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
  receipt: CleaningRulePreflightReceipt | null;
}

function receiptBody(receipt: CleaningRulePreflightReceipt): Omit<CleaningRulePreflightReceipt, "receipt_digest"> {
  const { receipt_digest, ...body } = receipt;
  void receipt_digest;
  return body;
}

export function validateCleaningRuleReceipt(
  registry: DatasetFamilyRegistry,
  receipt: CleaningRulePreflightReceipt,
  identity: {
    task_id: string;
    run_id: string;
    requirement_id: string;
    binding_ids?: readonly string[];
  },
): CleaningRulePreflightReceipt {
  const parsed = parseCleaningRulePreflightReceipt(receipt);
  if (
    parsed.task_id !== identity.task_id ||
    parsed.run_id !== identity.run_id ||
    parsed.requirement_id !== identity.requirement_id
  ) {
    throw new Error("cleaning rule receipt identity does not match the execution");
  }
  if (digest(receiptBody(parsed)) !== parsed.receipt_digest) {
    throw new Error("cleaning rule receipt digest is invalid");
  }
  if (identity.binding_ids !== undefined) {
    const allowed = new Set(identity.binding_ids);
    for (const proposal of [...parsed.accepted, ...parsed.needs_review]) {
      if (!allowed.has(proposal.binding_id)) {
        throw new Error(`cleaning rule receipt binding '${proposal.binding_id}' is not in the execution spec`);
      }
    }
  }
  const reprojection = preflightCleaningRules(registry, {
    ...identity,
    proposals: [...parsed.accepted, ...parsed.needs_review],
  });
  if (
    reprojection.proposals_digest !== parsed.proposals_digest ||
    JSON.stringify(reprojection.receipt) !== JSON.stringify(parsed)
  ) {
    throw new Error("cleaning rule receipt does not match Core preflight facts");
  }
  return parsed;
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
  const matches = Object.values(NORMALIZATION_PROFILES).flatMap((profile) => {
    const correction = registeredUnitCorrection(proposal.from_unit, profile);
    if (
      correction === null ||
      correction.to_unit !== proposal.to_unit ||
      correction.factor !== proposal.factor ||
      correction.offset !== proposal.offset
    ) return [];
    return profile.unit_conversions
      .filter((rule) => rule.from_unit === proposal.from_unit && rule.to_unit === proposal.to_unit)
      .map((rule) => ({ rule }));
  });
  if (matches.length !== 1) return null;
  return { ruleId: matches[0]!.rule.rule_id, reason: "unique registered normalization rule" };
}

export function preflightCleaningRules(
  registry: DatasetFamilyRegistry,
  input: {
    task_id: string;
    run_id: string;
    requirement_id: string;
    proposals: unknown;
  },
): CleaningRulePreflightResult {
  const proposals = parseCleaningRuleProposals(input.proposals);
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
  const accepted = proposals.filter((proposal) =>
    items.find((item) => item.proposal_id === proposal.proposal_id)?.decision === "accepted_registered_rule",
  );
  const needsReview = proposals.filter((proposal) =>
    items.find((item) => item.proposal_id === proposal.proposal_id)?.decision !== "accepted_registered_rule",
  );
  const receiptBody = {
    schema_version: "1.0" as const,
    task_id: input.task_id,
    run_id: input.run_id,
    requirement_id: input.requirement_id,
    proposals_digest: proposalsDigest,
    accepted,
    needs_review: needsReview,
  };
  const receipt = accepted.length === 0 || needsReview.length > 0
    ? null
    : parseCleaningRulePreflightReceipt({
        ...receiptBody,
        receipt_digest: digest(receiptBody),
      });
  return {
    proposals_digest: proposalsDigest,
    items,
    candidate_sets: candidateSets,
    receipt,
  };
}
