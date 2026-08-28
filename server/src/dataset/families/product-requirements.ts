import {
  parseCoreProductTopologyRequirements,
  type CoreProductTopologyRequirements,
} from "../dynamic-family/product-requirements.js";
import {
  bioactivityRelations,
  bioactivityTableEntries,
} from "./bioactivity-measurement/schemas.js";
import { BIOACTIVITY_FAMILY_ID } from "./bioactivity-measurement/types.js";
import {
  chartEvidenceRelations,
  chartEvidenceTables,
} from "./bioactivity-measurement/chart-evidence/schemas.js";

export const BIOACTIVITY_CHART_PRODUCT_PROFILE_REF =
  "bioactivity_measurement.chart_evidence.release.v1";

export function createDefaultCoreProductTopologyRequirements(): readonly CoreProductTopologyRequirements[] {
  return Object.freeze([parseCoreProductTopologyRequirements({
    schema_version: "1.0",
    profile_ref: BIOACTIVITY_CHART_PRODUCT_PROFILE_REF,
    dataset_family: BIOACTIVITY_FAMILY_ID,
    tables: [
      ...bioactivityTableEntries().map((entry) => ({
        table_id: entry.definition.table_id,
        role: entry.definition.role,
        schema_ref: entry.definition.schema_ref,
        min_rows: entry.definition.allow_empty ? 0 : 1,
      })),
      ...chartEvidenceTables.map((entry) => ({
        table_id: entry.definition.table_id,
        role: entry.definition.role,
        schema_ref: entry.definition.schema_ref,
        min_rows: entry.definition.allow_empty ? 0 : 1,
      })),
    ],
    relations: [
      ...bioactivityRelations.map((relation) => relation.relation_id),
      ...chartEvidenceRelations.map((relation) => relation.relation_id),
    ],
  })]);
}

