import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import type { DatasetBridgeResponse } from "@biomed/contracts";
import { createDatasetBuildTools } from "../src/agent/tools/dataset-build.js";
import { CoreAcquisitionError } from "../src/dataset/acquisition/runtime.js";
import { readBuildContinuation } from "../src/runtime/build-continuation.js";
import { datasetBuildSpec as spec } from "./dataset-bridge-fixture.js";

const roots: string[] = [];

async function toolTaskRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biomed-tool-cont-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Pi DatasetBuild tools", () => {
  test("exposes the frozen DatasetBuildSpec contract to the model", async () => {
    const [validateTool, executeTool] = createDatasetBuildTools({
      client: { validate: vi.fn(), execute: vi.fn() },
      taskId: "task_tool",
      taskRoot: await toolTaskRoot(),
      runId: () => "run_tool",
      piSessionId: () => "pi_tool",
    });
    const validateParameters = validateTool!.parameters as {
      properties: { spec: Record<string, unknown> };
    };
    const expressionSchema = validateParameters.properties.spec as {
      oneOf: Array<{
        additionalProperties?: boolean;
        required?: string[];
        properties?: Record<string, Record<string, unknown>>;
        oneOf?: Array<{
          additionalProperties: boolean;
          required: string[];
          properties: Record<string, Record<string, unknown>>;
        }>;
      }>;
    };
    type SchemaVariant = {
      additionalProperties: boolean;
      required: string[];
      properties: Record<string, Record<string, unknown>>;
    };
    const variants = expressionSchema.oneOf.flatMap((variant): SchemaVariant[] => {
      if (variant.oneOf !== undefined) return variant.oneOf;
      if (variant.properties === undefined || variant.required === undefined || variant.additionalProperties === undefined) return [];
      return [{ additionalProperties: variant.additionalProperties, required: variant.required, properties: variant.properties }];
    });
    const schemaRef = (
      variant: { properties: Record<string, Record<string, unknown>> },
    ): string => (variant.properties.schema_ref.enum as string[])[0]!;
    const geneVariant = variants.find(
      (variant) => schemaRef(variant) === "gene_expression.long.v1",
    )!;
    const probeVariant = variants.find(
      (variant) => schemaRef(variant) === "gene_expression.probe_long.v1",
    )!;

    expect(variants.length).toBeGreaterThanOrEqual(2);
    expect(geneVariant.properties.dataset_family.enum).toEqual(["gene_expression"]);
    expect(geneVariant.additionalProperties).toBe(false);
    expect(geneVariant.required).toEqual([
      "build_id",
      "objective",
      "dataset_family",
      "row_granularity",
      "schema_ref",
      "source_bindings",
      "validation_profile_ref",
    ]);
    expect(geneVariant.properties.validation_profile_ref.enum).toEqual([
      "gene_expression.release.v1",
    ]);
    expect(probeVariant.properties.validation_profile_ref.enum).toEqual([
      "gene_expression.probe_release.v1",
    ]);

    const sourceBindings = geneVariant.properties.source_bindings as {
      items: {
        oneOf: Array<{
          properties: Record<string, Record<string, unknown>>;
          required: string[];
        }>;
      };
    };
    const sourceOptions = sourceBindings.items.oneOf;
    const adapterId = (
      option: { properties: Record<string, Record<string, unknown>> },
    ): string => (option.properties.adapter_id.enum as string[])[0]!;
    expect(sourceOptions.map((option) => adapterId(option))).toEqual([
      "gdc.expression.v1",
      "geo.expression.v1",
      "xena.matrix.v1",
    ]);
    const geoSource = sourceOptions.find(
      (option) => adapterId(option) === "geo.expression.v1",
    )!;
    const gdcSource = sourceOptions.find(
      (option) => adapterId(option) === "gdc.expression.v1",
    )!;
    expect(gdcSource.properties.parameters).toMatchObject({
      properties: {},
      additionalProperties: false,
    });
    expect(geoSource.required).toContain("parameters");
    expect(geoSource.properties.parameters.required).toEqual([
      "format",
      "value_semantics",
      "value_scale",
      "expression_unit",
    ]);
    expect(geoSource.properties.parameters.properties).toMatchObject({
      format: { enum: ["tximport_counts", "series_matrix", "supplementary_matrix"] },
      value_semantics: {
        enum: ["expression_value", "normalized_expression", "raw_count"],
      },
      value_scale: { enum: ["linear", "log2", "log10", "unknown"] },
      expression_unit: { type: "string" },
      is_normalized: { type: "boolean" },
      platform_ids: { type: "array" },
    });
    const probeSources = probeVariant.properties.source_bindings as {
      items: {
        oneOf: Array<{ properties: Record<string, Record<string, unknown>> }>;
      };
    };
    expect(probeSources.items.oneOf.map((option) => adapterId(option))).toEqual([
      "geo.expression.v1",
    ]);

    const bioactivityVariant = variants.find(
      (variant) => schemaRef(variant) === "bioactivity_measurement.activity.v1",
    )!;
    const bioactivitySources = bioactivityVariant.properties.source_bindings as {
      items: {
        oneOf: Array<{ properties: Record<string, Record<string, unknown>> }>;
      };
    };
    expect(bioactivitySources.items.oneOf.map((option) => adapterId(option))).toEqual([
      "bioactivity.chembl_json.v1",
      "registered_bioactivity_activities_json",
      "registered_bioactivity_assays_json",
      "registered_bioactivity_compounds_json",
      "registered_bioactivity_targets_json",
    ]);

    const executeParameters = executeTool!.parameters as {
      properties: Record<string, Record<string, unknown>>;
    };
    expect(executeParameters.properties.source_files.description).toContain(
      "asset.relative_path",
    );
  });

  test("validates before execute and propagates the Pi AbortSignal", async () => {
    const validate = vi.fn(async (): Promise<DatasetBridgeResponse> => ({
      version: 1, request_id: "request_validate", ok: true,
      data: { valid: true, reason_codes: [], reasons: [] }, error: null,
    }));
    const execute = vi.fn(async (): Promise<DatasetBridgeResponse> => ({
      version: 1, request_id: "request_execute", ok: false, data: null,
      error: { code: "no_data", message: "No data", retryable: false, details: {} },
    }));
    const [validateTool, executeTool] = createDatasetBuildTools({
      client: { validate, execute },
      taskId: "task_tool",
      taskRoot: await toolTaskRoot(),
      runId: () => "run_tool",
      piSessionId: () => "pi_tool",
    });
    const controller = new AbortController();

    await validateTool!.execute({ spec }, controller.signal, { toolCallId: "call_validate" });
    const result = await executeTool!.execute(
      {
        spec,
        source_files: { binding_gdc: "source_assets/file.tsv" },
        mapping_files: {},
        metadata_files: { binding_gdc: "source_assets/series.soft" },
      },
      controller.signal,
      { toolCallId: "call_execute" },
    );

    expect(validate).toHaveBeenCalledWith(expect.objectContaining({
      signal: controller.signal,
      piSessionId: "pi_tool",
      toolCallId: "call_validate",
    }));
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      signal: controller.signal,
      piSessionId: "pi_tool",
      toolCallId: "call_execute",
      metadataFiles: { binding_gdc: "source_assets/series.soft" },
    }));
    expect(result).toMatchObject({
      isError: true,
      details: { code: "no_data", retryable: false },
    });
  });

  test("preserves Core retryability and classifies thrown tool errors", async () => {
    const retryableExecute = vi.fn(async (): Promise<DatasetBridgeResponse> => ({
      version: 1,
      request_id: "request_execute",
      ok: false,
      data: null,
      error: {
        code: "core_execution_error",
        message: "temporary provider failure",
        retryable: true,
        details: { category: "network" },
      },
    }));
    const [, tool] = createDatasetBuildTools({
      client: {
        validate: async () => ({
          version: 1,
          request_id: "request_validate",
          ok: true,
          data: { valid: true, reason_codes: [], reasons: [] },
          error: null,
        }),
        execute: retryableExecute,
      },
      taskId: "task_tool",
      taskRoot: await toolTaskRoot(),
      runId: () => "run_tool",
      piSessionId: () => "pi_tool",
    });

    const result = await tool!.execute({
      spec,
      source_files: { binding_gdc: "source_assets/input.tsv" },
      mapping_files: {},
    });
    expect(result).toMatchObject({
      isError: true,
      details: {
        code: "core_execution_error",
        retryable: true,
        category: "network",
      },
    });

    const invalidTool = createDatasetBuildTools({
      client: {
        validate: async () => {
          throw new TypeError("malformed spec");
        },
        execute: retryableExecute,
      },
      taskId: "task_tool",
      taskRoot: await toolTaskRoot(),
      runId: () => "run_tool",
      piSessionId: () => "pi_tool",
    })[0]!;
    await expect(invalidTool.execute({ spec })).resolves.toMatchObject({
      isError: true,
      details: { code: "invalid_input", retryable: false },
    });

    const acquisitionTool = createDatasetBuildTools({
      client: {
        validate: async () => ({
          version: 1,
          request_id: "request_validate",
          ok: true,
          data: { valid: true, reason_codes: [], reasons: [] },
          error: null,
        }),
        acquire: async () => {
          throw new CoreAcquisitionError(
            "acquisition failed: network_error",
            { provider_id: "gdc.v1", error_code: "network_error", attempts: 3 },
            false,
          );
        },
        execute: retryableExecute,
      },
      taskId: "task_tool",
      taskRoot: await toolTaskRoot(),
      runId: () => "run_tool",
      piSessionId: () => "pi_tool",
    })[1]!;
    await expect(acquisitionTool.execute({ spec, mapping_files: {} })).resolves.toMatchObject({
      isError: true,
      details: {
        code: "acquisition_failed",
        retryable: false,
        provider_id: "gdc.v1",
        error_code: "network_error",
        attempts: 3,
      },
    });
  });

  test("acquires missing source bindings after validation and preserves explicit files", async () => {
    const assetId = `asset_${"a".repeat(64)}`;
    const validate = vi.fn(async (): Promise<DatasetBridgeResponse> => ({
      version: 1, request_id: "request_validate", ok: true,
      data: { valid: true, reason_codes: [], reasons: [] }, error: null,
    }));
    const acquire = vi.fn(async () => ({
      requestIdentityDigest: "b".repeat(64),
      attempts: [],
      sourceAsset: {
        schema_version: "1.0" as const,
        asset_id: assetId,
        task_id: "task_tool",
        role: "source" as const,
      },
      extractionAssets: [],
    }));
    const execute = vi.fn(async (): Promise<DatasetBridgeResponse> => ({
      version: 1, request_id: "request_execute", ok: false, data: null,
      error: { code: "no_data", message: "No data", retryable: false, details: {} },
    }));
    const tools = createDatasetBuildTools({
      client: { validate, acquire, execute },
      taskId: "task_tool",
      taskRoot: await toolTaskRoot(),
      runId: () => "run_tool",
      piSessionId: () => "pi_tool",
    });

    await tools[1]!.execute({ spec, mapping_files: {} });

    expect(acquire).toHaveBeenCalledWith(expect.objectContaining({
      taskId: "task_tool",
      runId: "run_tool",
      request: expect.objectContaining({
        schema_version: "1.0",
        task_id: "task_tool",
        build_id: spec.build_id,
        binding_id: "binding_gdc",
        mode: "builtin",
        provider_id: "gdc.v1",
        parameters: {},
      }),
    }));
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      sourceFiles: { binding_gdc: assetId },
    }));

    acquire.mockClear();
    await tools[1]!.execute({
      spec,
      source_files: { binding_gdc: "source_assets/explicit.tsv" },
      mapping_files: {},
    });
    expect(acquire).not.toHaveBeenCalled();
    expect(execute).toHaveBeenLastCalledWith(expect.objectContaining({
      sourceFiles: { binding_gdc: "source_assets/explicit.tsv" },
    }));
  });

  test("projects fixed provider accession and entities into the Core acquisition request", async () => {
    const validate = vi.fn(async (): Promise<DatasetBridgeResponse> => ({
      version: 1, request_id: "request_validate", ok: true,
      data: { valid: true, reason_codes: [], reasons: [] }, error: null,
    }));
    const acquire = vi.fn(async () => ({
      requestIdentityDigest: "b".repeat(64),
      attempts: [],
      sourceAsset: {
        schema_version: "1.0" as const,
        asset_id: `asset_${"a".repeat(64)}`,
        task_id: "task_tool",
        role: "carrier" as const,
      },
      extractionAssets: [],
    }));
    const execute = vi.fn(async (): Promise<DatasetBridgeResponse> => ({
      version: 1, request_id: "request_execute", ok: false, data: null,
      error: { code: "no_data", message: "No data", retryable: false, details: {} },
    }));
    const tools = createDatasetBuildTools({
      client: { validate, acquire, execute },
      taskId: "task_tool",
      taskRoot: await toolTaskRoot(),
      runId: () => "run_tool",
      piSessionId: () => "pi_tool",
    });
    const pdbSpec = {
      ...spec,
      build_id: "build_pdb_provider",
      entities: { pdb_ids: ["6M0J"] },
      source_bindings: [{
        ...spec.source_bindings[0]!,
        binding_id: "binding_pdb",
        source: "pdb",
        acquisition: {
          schema_version: "1.0" as const,
          mode: "builtin" as const,
          provider_id: "pdb.files.v1",
          recipe_id: null,
          recipe_version: null,
        },
        adapter_id: "protein.structure.carrier.v1",
        accession: null,
        parameters: {},
      }],
    };

    await tools[1]!.execute({ spec: pdbSpec, mapping_files: {} });

    expect(acquire).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({
        provider_id: "pdb.files.v1",
        parameters: {
          source: "pdb",
          accession: null,
          entities: { pdb_ids: ["6M0J"] },
        },
      }),
    }));
  });

  test("rejects unknown source_files bindings before acquisition or execution", async () => {
    const validate = vi.fn(async (): Promise<DatasetBridgeResponse> => ({
      version: 1, request_id: "request_validate", ok: true,
      data: { valid: true, reason_codes: [], reasons: [] }, error: null,
    }));
    const acquire = vi.fn();
    const execute = vi.fn();
    const tools = createDatasetBuildTools({
      client: { validate, acquire, execute },
      taskId: "task_tool",
      taskRoot: await toolTaskRoot(),
      runId: () => "run_tool",
      piSessionId: () => "pi_tool",
    });

    const result = await tools[1]!.execute({
      spec,
      source_files: { unknown_binding: "source_assets/unknown.tsv" },
      mapping_files: {},
    });

    expect(result).toMatchObject({ isError: true, details: { code: "invalid_input" } });
    expect(result.content).toContain("unknown binding IDs");
    expect(acquire).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  test("forwards a Core-owned publication receipt after a successful build", async () => {
    const publication = {
      schema_version: "1.1" as const,
      publication_id: "pub_build_receipt",
      manifest_ref: "manifest_build_receipt",
      manifest_sha256: "a".repeat(64),
      validation_result_ref: "validation_report.json",
      published_at: "2026-08-20T00:00:00.000Z",
      supersedes_publication_id: null,
    };
    const response: DatasetBridgeResponse = {
      version: 1,
      request_id: "request_execute",
      ok: true,
      data: {
        build_id: spec.build_id,
        build_result: {
          status: "succeeded",
          valid_row_count: 1,
          successful_sources: ["binding_gdc"],
          rejected_sources: [],
          available_artifact_roles: ["primary_dataset"],
          publication_id: publication.publication_id,
          reason_codes: [],
          user_summary: "published",
          recommended_next_action: "download artifacts",
          build_id: spec.build_id,
        },
        publication_id: publication.publication_id,
        publication,
        manifest: {
          build_id: spec.build_id,
          manifest_id: publication.manifest_ref,
          sha256: "b".repeat(64),
        },
        artifacts: [],
        validation_summary: null,
        registeredSourceAssetIds: [],
      },
      error: null,
    };
    const onPublication = vi.fn();
    const tools = createDatasetBuildTools({
      client: {
        validate: async () => ({
          version: 1,
          request_id: "request_validate",
          ok: true,
          data: { valid: true, reason_codes: [], reasons: [] },
          error: null,
        }),
        execute: async () => response,
      },
      taskId: "task_tool",
      taskRoot: await toolTaskRoot(),
      runId: () => "run_tool",
      piSessionId: () => "pi_tool",
      onPublication,
    });

    await tools[1]!.execute({
      spec,
      source_files: { binding_gdc: "source_assets/file.tsv" },
      mapping_files: {},
    });

    expect(onPublication).toHaveBeenCalledOnce();
    expect(onPublication).toHaveBeenCalledWith(response.data);
  });

  test("persists a continuation record before handing the build to the core", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "biomed-tool-cont-"));
    roots.push(root);
    const execute = vi.fn(async (): Promise<DatasetBridgeResponse> => ({
      version: 1, request_id: "request_execute", ok: true, data: {
        build_id: spec.build_id,
        build_result: {
          status: "succeeded" as const,
          valid_row_count: 0,
          successful_sources: [],
          rejected_sources: [],
          available_artifact_roles: [],
          publication_id: null,
          reason_codes: [],
          user_summary: "",
          recommended_next_action: "",
          build_id: spec.build_id,
        },
        publication_id: null,
        manifest: null,
        artifacts: [],
        validation_summary: null,
        registeredSourceAssetIds: [],
      }, error: null,
    }));
    const tools = createDatasetBuildTools({
      client: { validate: async () => ({ version: 1, request_id: "r", ok: true, data: { valid: true, reason_codes: [], reasons: [] }, error: null }), execute },
      taskId: "task_tool",
      taskRoot: root,
      runId: () => "run_tool",
      piSessionId: () => "pi_tool",
    });
    await tools[1]!.execute(
      {
        spec,
        source_files: { binding_gdc: "source_assets/file.tsv" },
        mapping_files: { binding_gdc: "source_assets/annot.txt" },
      },
      undefined,
      { toolCallId: "call_execute" },
    );
    const record = await readBuildContinuation(root, spec.build_id);
    expect(record).not.toBeNull();
    expect(record).toMatchObject({
      schema_version: 1,
      build_id: spec.build_id,
      task_id: "task_tool",
      run_id: "run_tool",
      pi_session_id: "pi_tool",
      tool_call_id: "call_execute",
    });
    expect(record?.source_files).toEqual({ binding_gdc: "source_assets/file.tsv" });
    expect(record?.registered_source_asset_ids).toEqual([]);
    expect(record?.mapping_files).toEqual({ binding_gdc: "source_assets/annot.txt" });
    expect(record?.spec.build_id).toBe(spec.build_id);
    // The record exists before the core was invoked: a crash during the
    // build can always be resumed deterministically.
    expect(execute).toHaveBeenCalledTimes(1);
  });

  test("strictly parses the spec before calling the Dataset Core", async () => {
    const validate = vi.fn();
    const tools = createDatasetBuildTools({
      client: { validate, execute: vi.fn() },
      taskId: "task_tool",
      taskRoot: await toolTaskRoot(),
      runId: () => "run_tool",
      piSessionId: () => "pi_tool",
    });

    const result = await tools[0]!.execute({
      spec: { ...spec, agent_threshold_override: 0 },
    });

    expect(validate).not.toHaveBeenCalled();
    expect(result).toMatchObject({ isError: true, details: { code: "invalid_input" } });
    expect(result.content).toContain("unknown fields");
  });

  test("does not execute a rejected spec and emits bounded diagnostics", async () => {
    const validate = vi.fn(async (): Promise<DatasetBridgeResponse> => ({
      version: 1, request_id: "request_reject", ok: false, data: null,
      error: { code: "spec_rejected", message: "Rejected", retryable: false, details: { reason_codes: ["unknown_schema"] } },
    }));
    const execute = vi.fn();
    const diagnostic = vi.fn();
    const onBuildResult = vi.fn();
    const tools = createDatasetBuildTools({
      client: { validate, execute }, taskId: "task_tool", taskRoot: await toolTaskRoot(), runId: () => "run_tool", piSessionId: () => "pi_tool", onDiagnostic: diagnostic, onBuildResult,
    });
    const result = await tools[1]!.execute(
      { spec, source_files: {}, mapping_files: {} },
      undefined,
      { toolCallId: "x".repeat(500) },
    );

    expect(execute).not.toHaveBeenCalled();
    expect(result).toMatchObject({ isError: true, details: { code: "spec_rejected" } });
    expect(onBuildResult).toHaveBeenCalledWith(expect.objectContaining({
      status: "spec_rejected",
      build_id: spec.build_id,
      reason_codes: ["unknown_schema"],
    }));
    expect(diagnostic).toHaveBeenCalledWith(expect.objectContaining({
      taskId: "task_tool",
      runId: "run_tool",
      piSessionId: "pi_tool",
      toolCallId: "x".repeat(128),
      toolName: "execute_dataset_build",
      requestId: "request_reject",
    }));
  });

  test("exposes a typed DatasetBuildSpec schema so the agent stops inventing wrapper structures", async () => {
    // Regression (e2e gold2): the spec parameter schema was an opaque
    // {type:"object", additionalProperties:true}, so the agent invented
    // {config:{schema:...}} and the validator saw schema_ref=None. The tool
    // schema must name the top-level fields and the registered values.
    const tools = createDatasetBuildTools({
      client: { validate: async () => ({ version: 1, request_id: "r", ok: true, data: { valid: true, reason_codes: [], reasons: [] }, error: null }), execute: async () => ({ version: 1, request_id: "r", ok: false, data: null, error: { code: "no_data", message: "x", retryable: false, details: {} } }) },
      taskId: "task_tool",
      taskRoot: await toolTaskRoot(),
      runId: () => "run_tool",
      piSessionId: () => "pi_tool",
    });
    const expressionSchema = (tools[0]!.parameters as {
      properties?: Record<string, unknown>;
    }).properties?.spec as {
      oneOf: Array<{
        properties?: Record<string, Record<string, unknown>>;
        required?: string[];
        additionalProperties?: boolean;
        oneOf?: Array<{
          properties: Record<string, Record<string, unknown>>;
          required: string[];
          additionalProperties: boolean;
        }>;
      }>;
    };
    type SchemaVariant = {
      properties: Record<string, Record<string, unknown>>;
      required: string[];
      additionalProperties: boolean;
    };
    const variants = expressionSchema.oneOf.flatMap((variant): SchemaVariant[] => {
      if (variant.oneOf !== undefined) return variant.oneOf;
      if (variant.properties === undefined || variant.required === undefined || variant.additionalProperties === undefined) return [];
      return [{ properties: variant.properties, required: variant.required, additionalProperties: variant.additionalProperties }];
    });
    expect(variants.length).toBeGreaterThanOrEqual(2);
    for (const variant of variants) {
      expect(variant.additionalProperties).toBe(false);
      expect(variant.required).toContain("schema_ref");
      expect(variant.required).toContain("validation_profile_ref");
      expect(variant.required).toContain("source_bindings");
      expect(variant.properties.schema_ref.enum).toHaveLength(1);
      expect(variant.properties.validation_profile_ref.enum).toHaveLength(1);
    }
  });
});
