import { RegisteredTableRegistry } from "./registry.js";
import { literatureEvidenceAdapterRegistrations } from "../../families/literature-evidence/index.js";
import { createTargetEvidenceRegisteredTableRegistry } from "../../families/target-evidence/index.js";
import { createVariantEvidenceRegisteredTableRegistry } from "../../families/variant-evidence/index.js";
import { createProteinStructureRegisteredTableRegistry } from "../../families/protein-structure/index.js";
import { createBioactivityRegisteredTableRegistry } from "../../families/bioactivity-measurement/index.js";

export function createDefaultRegisteredTableRegistry(): RegisteredTableRegistry {
  const registry = new RegisteredTableRegistry();
  for (const registration of literatureEvidenceAdapterRegistrations) registry.register(registration);
  for (const familyRegistry of [
    createTargetEvidenceRegisteredTableRegistry(),
    createVariantEvidenceRegisteredTableRegistry(),
    createProteinStructureRegisteredTableRegistry(),
    createBioactivityRegisteredTableRegistry(),
  ]) {
    for (const registration of familyRegistry.entries()) registry.register(registration);
  }
  return registry;
}
