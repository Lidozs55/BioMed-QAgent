import { createDefaultDatasetFamilyRegistry } from "../families/index.js";
import { SchemaRegistry } from "./store.js";

export {
  buildGeneExpressionSchema,
  buildProbeExpressionSchema,
} from "./expression.js";
export { SchemaRegistry, schemasDeepEqual } from "./store.js";

export function createDefaultSchemaRegistry(): SchemaRegistry {
  return createDefaultDatasetFamilyRegistry().schemaRegistry();
}
