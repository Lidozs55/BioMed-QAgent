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
  LITERATURE_EXPERIMENT_CHART_FAMILY_ID,
  LITERATURE_EXPERIMENT_CHART_PROFILE_REF,
  literatureExperimentChartRelations,
  literatureExperimentChartTables,
} from "./literature-experiment-chart/profile.js";
import {
  SCIENTIFIC_ASSERTION_FAMILY_ID,
  SCIENTIFIC_ASSERTION_PROFILE_REF,
  scientificAssertionTables,
} from "./scientific-assertion/profile.js";
import {
  chartEvidenceRelations,
  chartEvidenceTables,
} from "./bioactivity-measurement/chart-evidence/schemas.js";

export const BIOACTIVITY_CHART_PRODUCT_PROFILE_REF =
  "bioactivity_measurement.chart_evidence.release.v1";

export function createDefaultCoreProductTopologyRequirements(): readonly CoreProductTopologyRequirements[] {
  return Object.freeze([
    parseCoreProductTopologyRequirements({
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
    }),
    parseCoreProductTopologyRequirements({
      schema_version: "1.0",
      profile_ref: LITERATURE_EXPERIMENT_CHART_PROFILE_REF,
      dataset_family: LITERATURE_EXPERIMENT_CHART_FAMILY_ID,
      tables: literatureExperimentChartTables.map((definition) => ({
        table_id: definition.table_id,
        role: definition.role,
        schema_ref: definition.schema_ref,
        min_rows: definition.allow_empty ? 0 : 1,
      })),
      relations: literatureExperimentChartRelations.map((relation) => relation.relation_id),
    }),
    parseCoreProductTopologyRequirements({
      schema_version: "1.0",
      profile_ref: SCIENTIFIC_ASSERTION_PROFILE_REF,
      dataset_family: SCIENTIFIC_ASSERTION_FAMILY_ID,
      tables: scientificAssertionTables.map((definition) => ({
        table_id: definition.table_id,
        role: definition.role,
        schema_ref: definition.schema_ref,
        min_rows: definition.allow_empty ? 0 : 1,
      })),
      relations: [],
    }),
  ]);
}

