export * from "./types.js";
export * from "./registry.js";
export * from "./expression.js";
export * from "./registered-multitable.js";

import { geneExpressionAssembler } from "./expression.js";
import { FamilyAssemblerRegistry } from "./registry.js";
import {
  bioactivityRegisteredAssembler,
  gutMicrobiomeRegisteredAssembler,
  inheritedDiseaseEvidenceRegisteredAssembler,
  literatureEvidenceRegisteredAssembler,
  proteinStructureRegisteredAssembler,
  targetEvidenceRegisteredAssembler,
  variantEvidenceRegisteredAssembler,
} from "./registered-multitable.js";

export function createDefaultFamilyAssemblerRegistry(): FamilyAssemblerRegistry {
  return new FamilyAssemblerRegistry([
    geneExpressionAssembler,
    literatureEvidenceRegisteredAssembler,
    targetEvidenceRegisteredAssembler,
    variantEvidenceRegisteredAssembler,
    proteinStructureRegisteredAssembler,
    bioactivityRegisteredAssembler,
    gutMicrobiomeRegisteredAssembler,
    inheritedDiseaseEvidenceRegisteredAssembler,
  ]);
}
