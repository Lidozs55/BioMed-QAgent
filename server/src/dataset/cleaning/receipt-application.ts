import type { CleaningRulePreflightReceipt } from "@biomed/contracts";

import { registeredUnitCorrection } from "../review/hil-policy.js";
import type { NormalizationProfile } from "../contracts/profiles.js";
import type { UnitCorrection } from "../canonicalizer/canonicalizer.js";

/**
 * Resolve the Core-approved unit action for one binding. Field mappings are
 * intentionally excluded: their transform remains HIL/audit-only until a
 * schema-owned executable mapping registry exists.
 */
export function unitCorrectionFromReceipt(
  receipt: CleaningRulePreflightReceipt | null | undefined,
  bindingId: string,
  profile: NormalizationProfile,
): UnitCorrection | undefined {
  const proposal = receipt?.accepted.find(
    (item) => item.kind === "unit_conversion" && item.binding_id === bindingId,
  );
  if (proposal === undefined || proposal.kind !== "unit_conversion") return undefined;
  const correction = registeredUnitCorrection(proposal.from_unit, profile);
  if (
    correction === null ||
    correction.to_unit !== proposal.to_unit ||
    correction.factor !== proposal.factor ||
    correction.offset !== proposal.offset
  ) {
    throw new Error(`cleaning receipt unit rule is no longer registered for binding '${bindingId}'`);
  }
  return correction;
}
