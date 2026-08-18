import { describe, expect, it } from "vitest";

import {
  canTransitionDurableBuildStatus,
  parseDurableBuildApiError,
  parseStartDatasetBuildRequest,
} from "../src/runtime/contracts.js";

const spec = {
  schema_version: "1.0" as const,
  build_id: "build_server_contract_1",
  objective: "Verify the scheduler handoff",
  dataset_family: "gene_expression",
  row_granularity: "gene_sample_measurement",
  entities: {},
  cohort_filters: {},
  required_fields: [],
  schema_ref: "gene_expression.long.v1",
  source_bindings: [{
    schema_version: "1.0" as const,
    binding_id: "binding_1",
    source: "fixture",
    acquisition: {
      schema_version: "1.0" as const,
      mode: "builtin" as const,
      provider_id: "fixture.v1",
      recipe_id: null,
      recipe_version: null,
    },
    adapter_id: "fixture.expression.v1",
    accession: null,
    parameters: {},
  }],
  normalization_profile_ref: null,
  merge_strategy: "append_by_canonical_row",
  validation_profile_ref: "gene_expression.release.v1",
  output_format: "csv",
  target_entity_level: null,
};

describe("durable Build server contract handoff", () => {
  it("re-exports the shared request parser without implementing the scheduler", () => {
    expect(parseStartDatasetBuildRequest({
      schema_version: "1.0",
      idempotency_key: "idem_server_contract_1",
      task_id: "task_server_contract_1",
      run_id: "run_server_contract_1",
      spec,
    })).toMatchObject({
      task_id: "task_server_contract_1",
      run_id: "run_server_contract_1",
      spec: { build_id: "build_server_contract_1" },
    });
    expect(canTransitionDurableBuildStatus("running", "succeeded")).toBe(true);
  });

  it("requires structured error codes instead of error-string inference", () => {
    expect(parseDurableBuildApiError({
      schema_version: "1.0",
      code: "idempotency_key_reused",
      message: "Request content does not match the existing Build",
      retryable: false,
      task_id: "task_server_contract_1",
      run_id: "run_server_contract_1",
      build_id: "build_server_contract_1",
      current_status: "queued",
      details: { expected_request_digest: "a".repeat(64) },
    })).toMatchObject({
      code: "idempotency_key_reused",
      current_status: "queued",
    });
  });
});
