export * from "./types.js";
export * from "./registry.js";
export * from "./expression.js";

import { geneExpressionAssembler } from "./expression.js";
import { FamilyAssemblerRegistry } from "./registry.js";

export function createDefaultFamilyAssemblerRegistry(): FamilyAssemblerRegistry {
  return new FamilyAssemblerRegistry([geneExpressionAssembler]);
}
