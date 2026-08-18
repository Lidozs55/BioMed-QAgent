/**
 * Schema Registry (migration plan Phase 4 step 2). ``DatasetSchema`` /
 * ``SchemaField`` types come from the contracts module; the built-in field
 * tables and the versioned registry live here.
 */

export * from "./fields.js";
export * from "./expression.js";
export * from "./registry.js";
export * from "./store.js";
export * from "./common/index.js";
export type { DatasetSchema, SchemaField } from "../contracts/index.js";