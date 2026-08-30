import {
  BIOACTIVITY_CHART_PRODUCT_PROFILE_REF,
  createDefaultCoreProductTopologyRequirements,
} from "../families/index.js";
import type { CoreProductTopologyRequirements } from "./product-requirements.js";

const DEFAULT_REQUIREMENTS = new Map<string, CoreProductTopologyRequirements>([
  ...createDefaultCoreProductTopologyRequirements().map((requirements) => [
    requirements.profile_ref,
    requirements,
  ] as const),
]);

export { BIOACTIVITY_CHART_PRODUCT_PROFILE_REF };

export function listCoreProductTopologyRequirements(): readonly CoreProductTopologyRequirements[] {
  return Object.freeze([...DEFAULT_REQUIREMENTS.values()]);
}

export function resolveCoreProductTopologyRequirements(
  profileRef: string,
): CoreProductTopologyRequirements {
  const requirements = DEFAULT_REQUIREMENTS.get(profileRef);
  if (requirements === undefined) {
    throw new TypeError(
      `unknown Core product requirement profile '${profileRef}'; available profiles: ${[...DEFAULT_REQUIREMENTS.keys()].join(", ")}`,
    );
  }
  return requirements;
}
