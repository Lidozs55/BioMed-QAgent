import type { Projection, RelationDefinition, TableDefinition } from "@biomed/contracts";

import {
  bioactivityRelations,
  bioactivityTableEntries,
} from "./bioactivity-measurement/schemas.js";
import {
  chartEvidenceRelations,
  chartEvidenceTables,
} from "./bioactivity-measurement/chart-evidence/schemas.js";
import {
  LITERATURE_EXPERIMENT_CHART_FAMILY_ID,
  LITERATURE_EXPERIMENT_CHART_PROFILE_REF,
  literatureExperimentChartProjection,
  literatureExperimentChartRelations,
  literatureExperimentChartTables,
} from "./literature-experiment-chart/profile.js";
import { BIOACTIVITY_CHART_PRODUCT_PROFILE_REF } from "./product-requirements.js";

export interface CoreProductProfileDescriptor {
  readonly familyId: string;
  readonly projection: Projection;
  readonly tables: readonly TableDefinition[];
  readonly relations: readonly RelationDefinition[];
}
function bioactivityChartProjection(): Projection {
  const base = bioactivityTableEntries().map((entry) => entry.definition);
  const charts = chartEvidenceTables.map((entry) => entry.definition);
  const tables = [...base, ...charts];
  return {
    projection_id: "bioactivity_measurement.chart_evidence.eight_table.v1",
    schema_version: "2.0",
    primary_tables: tables.filter((item) => item.role === "primary").map((item) => item.table_id),
    supporting_tables: tables.filter((item) => item.role === "supporting").map((item) => item.table_id),
    derived_tables: tables.filter((item) => item.role === "derived").map((item) => item.table_id),
    required: tables.filter((item) => item.required).map((item) => item.table_id),
    optional: tables.filter((item) => !item.required).map((item) => item.table_id),
    allow_empty: tables.filter((item) => item.allow_empty).map((item) => item.table_id),
    relations: [...bioactivityRelations, ...chartEvidenceRelations].map((item) => item.relation_id),
    row_granularity: "activity_measurement_with_chart_evidence",
    compatibility_dimensions: ["activity_type", "raw_relation", "raw_unit", "standardized_unit"],
    merge_identity_fields: ["activity_id"],
    validation_policy_ref: "bioactivity_measurement.chart_evidence.validation.v1",
    assessment_policy_ref: BIOACTIVITY_CHART_PRODUCT_PROFILE_REF,
  };
}

export function resolveCoreProductProfileDescriptor(
  profileRef: string,
): CoreProductProfileDescriptor {
  if (profileRef === BIOACTIVITY_CHART_PRODUCT_PROFILE_REF) {
    return {
      familyId: "bioactivity_measurement",
      projection: bioactivityChartProjection(),
      tables: [
        ...bioactivityTableEntries().map((entry) => entry.definition),
        ...chartEvidenceTables.map((entry) => entry.definition),
      ],
      relations: [...bioactivityRelations, ...chartEvidenceRelations],
    };
  }
  if (profileRef === LITERATURE_EXPERIMENT_CHART_PROFILE_REF) {
    return {
      familyId: LITERATURE_EXPERIMENT_CHART_FAMILY_ID,
      projection: literatureExperimentChartProjection,
      tables: literatureExperimentChartTables,
      relations: literatureExperimentChartRelations,
    };
  }
  throw new TypeError(`Core product profile '${profileRef}' has no registered scaffold`);
}
