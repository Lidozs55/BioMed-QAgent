import { describe, expect, test } from "vitest";

import {
  parseDatasetBridgeRequest,
  parseDatasetBridgeResponse,
  type DatasetBuildSpec,
} from "../src/index.js";

const spec: DatasetBuildSpec = {
  schema_version: "1.0",
  build_id: "build_bridge_1",
  objective: "Build a fixture dataset",
  dataset_family: "gene_expression",
  row_granularity: "gene_sample_measurement",
  entities: {},
  cohort_filters: {},
  required_fields: [],
  schema_ref: "gene_expression.long.v1",
  source_bindings: [
    {
      schema_version: "1.0",
      binding_id: "binding_gdc",
      source: "gdc",
      acquisition: {
        schema_version: "1.0",
        mode: "builtin",
        provider_id: "gdc.v1",
        recipe_id: null,
        recipe_version: null,
      },
      adapter_id: "gdc.expression.v1",
      accession: null,
      parameters: {},
    },
  ],
  normalization_profile_ref: "gene_expression.normalization.v1",
  merge_strategy: "append_by_canonical_row",
  validation_profile_ref: "gene_expression.release.v1",
  output_format: "csv",
  target_entity_level: null,
};

function request() {
  return {
    version: 1,
    request_id: "request_bridge_1",
    task_id: "task_bridge_1",
    run_id: "run_bridge_1",
    pi_session_id: "pi_bridge_1",
    tool_call_id: "tool_bridge_1",
    op: "execute_dataset_build",
    args: {
      spec,
      source_files: { binding_gdc: "source_assets/gdc.tsv" },
      mapping_files: {},
      metadata_files: { binding_gdc: "source_assets/gdc.soft" },
    },
  } as const;
}

describe("Dataset Core bridge contracts", () => {
  test("strictly parses the versioned named-operation request", () => {
    expect(parseDatasetBridgeRequest(request())).toEqual(request());
  });

  test("keeps target_entity_level family-neutral at the wire boundary", () => {
    const variant = {
      ...request(),
      args: {
        ...request().args,
        spec: { ...spec, target_entity_level: "variant" },
      },
    };
    expect(parseDatasetBridgeRequest(variant)).toEqual(variant);
    expect(() => parseDatasetBridgeRequest({
      ...variant,
      args: { ...variant.args, spec: { ...variant.args.spec, target_entity_level: "" } },
    })).toThrow(/must be a non-empty string/);
    expect(() => parseDatasetBridgeRequest({
      ...variant,
      args: { ...variant.args, spec: { ...variant.args.spec, target_entity_level: 1 } },
    })).toThrow(/non-empty string/);
  });

  test.each([
    { ...request(), extra: true },
    { ...request(), version: 2 },
    { ...request(), request_id: "../escape" },
    { ...request(), op: "run_python" },
    { ...request(), args: { ...request().args, extra: true } },
    { ...request(), args: { ...request().args, source_files: { binding_gdc: "../escape" } } },
    { ...request(), args: { ...request().args, source_files: { binding_gdc: "C:\\secret.tsv" } } },
    { ...request(), args: { ...request().args, metadata_files: { binding_gdc: "../escape.soft" } } },
  ])("rejects unknown fields, operations, IDs, and unsafe refs", (value) => {
    expect(() => parseDatasetBridgeRequest(value)).toThrow();
  });

  test("correlates and strictly validates a response", () => {
    const response = {
      version: 1,
      request_id: "request_bridge_1",
      ok: true,
      data: { valid: true, reason_codes: [], reasons: [] },
      error: null,
    } as const;
    expect(parseDatasetBridgeResponse(response, "request_bridge_1")).toEqual(response);
    expect(() => parseDatasetBridgeResponse(response, "another_request")).toThrow();
    expect(() => parseDatasetBridgeResponse({ ...response, extra: true }, "request_bridge_1")).toThrow();
  });
});
