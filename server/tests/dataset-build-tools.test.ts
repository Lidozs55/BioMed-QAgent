import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import type { DatasetBridgeResponse } from "@biomed/contracts";
import { createDatasetBuildTools } from "../src/agent/tools/dataset-build.js";
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
        additionalProperties: boolean;
        required: string[];
        properties: Record<string, Record<string, unknown>>;
      }>;
    };
    const schemaRef = (
      variant: { properties: Record<string, Record<string, unknown>> },
    ): string => (variant.properties.schema_ref.enum as string[])[0]!;
    const geneVariant = expressionSchema.oneOf.find(
      (variant) => schemaRef(variant) === "gene_expression.long.v1",
    )!;
    const probeVariant = expressionSchema.oneOf.find(
      (variant) => schemaRef(variant) === "gene_expression.probe_long.v1",
    )!;

    expect(expressionSchema.oneOf).toHaveLength(2);
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
        source_files: { binding: "source_assets/file.tsv" },
        mapping_files: {},
        metadata_files: { binding: "source_assets/series.soft" },
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
      metadataFiles: { binding: "source_assets/series.soft" },
    }));
    expect(result).toMatchObject({ isError: true, details: { code: "no_data" } });
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
        source_files: { binding: "source_assets/file.tsv" },
        mapping_files: { binding: "source_assets/annot.txt" },
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
    expect(record?.source_files).toEqual({ binding: "source_assets/file.tsv" });
    expect(record?.mapping_files).toEqual({ binding: "source_assets/annot.txt" });
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
        properties: Record<string, Record<string, unknown>>;
        required: string[];
        additionalProperties: boolean;
      }>;
    };
    expect(expressionSchema.oneOf).toHaveLength(2);
    for (const variant of expressionSchema.oneOf) {
      expect(variant.additionalProperties).toBe(false);
      expect(variant.required).toContain("schema_ref");
      expect(variant.required).toContain("validation_profile_ref");
      expect(variant.required).toContain("source_bindings");
      expect(variant.properties.schema_ref.enum).toHaveLength(1);
      expect(variant.properties.validation_profile_ref.enum).toHaveLength(1);
    }
  });
});
