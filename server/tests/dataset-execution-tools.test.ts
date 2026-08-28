import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import type { DatasetBridgeResponse } from "@biomed/contracts";
import { createDatasetExecutionTools } from "../src/agent/tools/dataset-execution.js";
import { createDefaultDatasetFamilyRegistry } from "../src/dataset/families/index.js";
import { CoreAcquisitionError } from "../src/dataset/acquisition/runtime.js";
import { readExecutionContinuation } from "../src/runtime/execution-continuation.js";
import { datasetExecutionSpec as spec } from "./dataset-bridge-fixture.js";

const roots: string[] = [];

async function toolTaskRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biomed-tool-cont-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Pi DatasetExecution tools", () => {
  test("exposes a compact DatasetExecutionSpec contract while retaining Core validation", async () => {
    const [validateTool, executeTool] = createDatasetExecutionTools({
      familyRegistry: createDefaultDatasetFamilyRegistry(),
      client: { validate: vi.fn(), execute: vi.fn() },
      taskId: "task_tool",
      taskRoot: await toolTaskRoot(),
      runId: () => "run_tool",
      piSessionId: () => "pi_tool",
    });
    const validateParameters = validateTool!.parameters as {
      properties: { spec: Record<string, unknown> };
    };
    const specWrapper = validateParameters.properties.spec as {
      anyOf: Array<Record<string, unknown>>;
    };
    const compactSchema = specWrapper.anyOf[0] as {
      type: string;
      properties: Record<string, Record<string, unknown>>;
      required: string[];
      additionalProperties: boolean;
    };
    expect(compactSchema.type).toBe("object");
    expect(compactSchema.additionalProperties).toBe(false);
    expect(compactSchema.required).toEqual([
      "requirement_id",
      "objective",
      "dataset_family",
      "row_granularity",
      "schema_ref",
      "source_bindings",
      "validation_profile_ref",
    ]);
    expect(compactSchema.properties.dataset_family.enum).toContain("gene_expression");
    expect(compactSchema.properties.dataset_family.enum).toContain("bioactivity_measurement");
    expect(compactSchema.properties.schema_ref.enum).toContain("gene_expression.long.v1");
    expect(compactSchema.properties.schema_ref.enum).toContain("variant_evidence.assertion.v1");
    const sourceBinding = compactSchema.properties.source_bindings as {
      items: { properties: Record<string, Record<string, unknown>> };
    };
    expect(sourceBinding.items.properties.source.enum).toContain("geo");
    expect(sourceBinding.items.properties.adapter_id.enum).toContain(
      "geo.expression.v1",
    );
    expect(sourceBinding.items.properties.parameters).toMatchObject({
      type: "object",
      additionalProperties: true,
    });

    const executeParameters = executeTool!.parameters as {
      properties: Record<string, Record<string, unknown>>;
      required: string[];
    };
    expect(executeParameters.properties.source_files.description).toContain(
      "asset.relative_path",
    );
    expect(executeParameters.properties.source_files.description).toContain(
      "Core acquisition provider",
    );
    expect(executeParameters.properties.mapping_files.description).toContain(
      "Optional",
    );
    expect(executeParameters.required).toEqual(["spec"]);
    expect((specWrapper.anyOf[1] as Record<string, unknown>).type).toBe("string");
    expect(JSON.stringify(validateTool!.parameters).length).toBeLessThan(20_000);
    expect(JSON.stringify(executeTool!.parameters).length).toBeLessThan(22_000);
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
    const [validateTool, executeTool] = createDatasetExecutionTools({
      familyRegistry: createDefaultDatasetFamilyRegistry(),
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

  test("routes non-retryable static transform rejection to the dynamic family tool", async () => {
    const execute = vi.fn(async (): Promise<DatasetBridgeResponse> => ({
      version: 1, request_id: "request_execute", ok: false, data: null,
      error: {
        code: "invalid_input",
        message: "ChEMBL bioactivity transform rejected: activity value is required",
        retryable: false,
        details: {},
      },
    }));
    const validate = vi.fn(async (): Promise<DatasetBridgeResponse> => ({
      version: 1, request_id: "request_validate", ok: true,
      data: { valid: true, reason_codes: [], reasons: [] }, error: null,
    }));
    const tools = createDatasetExecutionTools({
      familyRegistry: createDefaultDatasetFamilyRegistry(),
      client: { validate, execute },
      taskId: "task_tool", taskRoot: await toolTaskRoot(),
      runId: () => "run_tool", piSessionId: () => "pi_tool",
    });
    const result = await tools[1]!.execute({
      spec,
      source_files: { binding_gdc: "source_assets/file.tsv" },
      mapping_files: {}, metadata_files: {},
    });
    expect(result).toMatchObject({
      isError: true,
      details: {
        route_scope: "static_registered_family",
        dynamic_provider_availability_evaluated: false,
        do_not_retry_static: true,
        recommended_next_action: expect.stringContaining("submit_dynamic_family_publication"),
      },
    });
    expect(result.content).toContain("This result covers only the static registered-family route");
    expect(result.content).toContain("Stop static schema/required_fields probing");
  });

  test("labels DatasetExecutionSpec tools as static-route capabilities", async () => {
    const tools = createDatasetExecutionTools({
      familyRegistry: createDefaultDatasetFamilyRegistry(),
      client: { validate: vi.fn(), execute: vi.fn() },
      taskId: "task_tool", taskRoot: await toolTaskRoot(),
      runId: () => "run_tool", piSessionId: () => "pi_tool",
    });
    expect(tools[0]?.description).toMatch(/static registered-family route only/i);
    expect(tools[0]?.description).toMatch(/does not test Dynamic Family provider availability/i);
    expect(tools[1]?.description).toMatch(/static registered-family route only/i);
  });

  test("accepts a JSON-encoded string spec (agent serialization slip)", async () => {
    const validate = vi.fn(async (): Promise<DatasetBridgeResponse> => ({
      version: 1, request_id: "request_validate", ok: true,
      data: { valid: true, reason_codes: [], reasons: [] }, error: null,
    }));
    const [validateTool, executeTool] = createDatasetExecutionTools({
      familyRegistry: createDefaultDatasetFamilyRegistry(),
      client: { validate, execute: vi.fn() },
      taskId: "task_tool",
      taskRoot: await toolTaskRoot(),
      runId: () => "run_tool",
      piSessionId: () => "pi_tool",
    });

    const encodedSpec: string = JSON.stringify(spec);
    const result = await validateTool!.execute(
      { spec: encodedSpec },
      new AbortController().signal,
      { toolCallId: "call_validate_string" },
    );

    expect(result).toMatchObject({ isError: false });
    expect(validate).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: expect.objectContaining({
          requirement_id: spec.requirement_id,
          dataset_family: spec.dataset_family,
        }),
      }),
    );
    const executeParameters = executeTool!.parameters as {
      properties: Record<string, Record<string, unknown>>;
    };
    expect(executeParameters.properties.spec).toMatchObject({
      anyOf: [{ type: "object" }, { type: "string" }],
    });
  });

  test("rejects duplicate decoded keys in a JSON-encoded spec", async () => {
    const [validateTool] = createDatasetExecutionTools({
      familyRegistry: createDefaultDatasetFamilyRegistry(),
      client: { validate: vi.fn(), execute: vi.fn() },
      taskId: "task_tool",
      taskRoot: await toolTaskRoot(),
      runId: () => "run_tool",
      piSessionId: () => "pi_tool",
    });
    const duplicated = JSON.stringify(spec).replace(
      `"requirement_id":"${spec.requirement_id}"`,
      `"requirement_id":"${spec.requirement_id}","\\u0072equirement_id":"requirement_shadow"`,
    );
    const result = await validateTool!.execute(
      { spec: duplicated },
      new AbortController().signal,
      { toolCallId: "call_duplicate_string" },
    );
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).toContain("duplicate object key");
  });

  test("reports a clear error when the spec string is not valid JSON", async () => {
    const [validateTool] = createDatasetExecutionTools({
      familyRegistry: createDefaultDatasetFamilyRegistry(),
      client: { validate: vi.fn(), execute: vi.fn() },
      taskId: "task_tool",
      taskRoot: await toolTaskRoot(),
      runId: () => "run_tool",
      piSessionId: () => "pi_tool",
    });
    const result = await validateTool!.execute(
      { spec: "{not json" },
      new AbortController().signal,
      { toolCallId: "call_bad_string" },
    );
    expect(result).toMatchObject({ isError: true });
    const text = JSON.stringify(result);
    expect(text).toContain("JSON-encoded string");
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
    const [, tool] = createDatasetExecutionTools({
      familyRegistry: createDefaultDatasetFamilyRegistry(),
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

    const invalidTool = createDatasetExecutionTools({
      familyRegistry: createDefaultDatasetFamilyRegistry(),
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

    const acquisitionTool = createDatasetExecutionTools({
      familyRegistry: createDefaultDatasetFamilyRegistry(),
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
    const tools = createDatasetExecutionTools({
      familyRegistry: createDefaultDatasetFamilyRegistry(),
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
        requirement_id: spec.requirement_id,
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
    const tools = createDatasetExecutionTools({
      familyRegistry: createDefaultDatasetFamilyRegistry(),
      client: { validate, acquire, execute },
      taskId: "task_tool",
      taskRoot: await toolTaskRoot(),
      runId: () => "run_tool",
      piSessionId: () => "pi_tool",
    });
    const pdbSpec = {
      ...spec,
      requirement_id: "build_pdb_provider",
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

    acquire.mockClear();
    const chemblSpec = {
      ...spec,
      requirement_id: "build_chembl_provider",
      dataset_family: "bioactivity_measurement",
      entities: {
        chembl_compounds: ["CHEMBL100", "CHEMBL200"],
        activity_types: ["IC50", "Ki"],
      },
      source_bindings: [{
        ...spec.source_bindings[0]!,
        binding_id: "binding_chembl",
        source: "chembl",
        acquisition: {
          schema_version: "1.0" as const,
          mode: "builtin" as const,
          provider_id: "chembl.files.v1",
          recipe_id: null,
          recipe_version: null,
        },
        adapter_id: "bioactivity.chembl_json.v1",
        accession: "CHEMBL9999",
        parameters: {},
      }],
    };
    await tools[1]!.execute({ spec: chemblSpec, mapping_files: {} });
    expect(acquire).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({
        provider_id: "chembl.files.v1",
        parameters: {
          source: "chembl",
          accession: "CHEMBL9999",
          entities: {
            chembl_compounds: ["CHEMBL100", "CHEMBL200"],
            activity_types: ["IC50", "Ki"],
          },
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
    const tools = createDatasetExecutionTools({
      familyRegistry: createDefaultDatasetFamilyRegistry(),
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

  test("forwards a Core-owned Publication receipt after successful execution", async () => {
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
        requirement_id: spec.requirement_id,
        publication_id: publication.publication_id,
        publication,
        manifest: {
          requirement_id: spec.requirement_id,
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
    const tools = createDatasetExecutionTools({
      familyRegistry: createDefaultDatasetFamilyRegistry(),
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

    const result = await tools[1]!.execute({
      spec,
      source_files: { binding_gdc: "source_assets/file.tsv" },
      mapping_files: {},
    });

    const summary = JSON.parse(result.content) as Record<string, unknown>;
    expect(summary).toMatchObject({
      code: "ok",
      requirement_id: spec.requirement_id,
      publication_id: publication.publication_id,
      artifact_count: 0,
    });
    expect(onPublication).toHaveBeenCalledOnce();
    expect(onPublication).toHaveBeenCalledWith(response.data);
  });

  test("rejects unknown mapping and metadata bindings before acquisition or execution", async () => {
    const validate = vi.fn(async (): Promise<DatasetBridgeResponse> => ({
      version: 1, request_id: "request_validate", ok: true,
      data: { valid: true, reason_codes: [], reasons: [] }, error: null,
    }));
    const acquire = vi.fn();
    const execute = vi.fn();
    const tools = createDatasetExecutionTools({
      familyRegistry: createDefaultDatasetFamilyRegistry(),
      client: { validate, acquire, execute },
      taskId: "task_tool",
      taskRoot: await toolTaskRoot(),
      runId: () => "run_tool",
      piSessionId: () => "pi_tool",
    });

    for (const [field, value] of [
      ["mapping_files", { unknown_binding: "source_assets/unknown.tsv" }],
      ["metadata_files", { unknown_binding: "source_assets/unknown.tsv" }],
    ] as const) {
      const result = await tools[1]!.execute({ spec, [field]: value });
      expect(result).toMatchObject({ isError: true, details: { code: "invalid_input" } });
      expect(result.content).toContain(`${field} contains unknown binding IDs`);
    }
    expect(acquire).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  test("persists a continuation record before handing execution to the core", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "biomed-tool-cont-"));
    roots.push(root);
    const execute = vi.fn(async (): Promise<DatasetBridgeResponse> => ({
      version: 1, request_id: "request_execute", ok: false, data: null,
      error: {
        code: "no_data",
        message: "No primary rows were found",
        retryable: false,
        details: { requirement_id: spec.requirement_id, reason_codes: ["no_primary_data"] },
      },
    }));
    const tools = createDatasetExecutionTools({
      familyRegistry: createDefaultDatasetFamilyRegistry(),
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
    const record = await readExecutionContinuation(root, spec.requirement_id);
    expect(record).not.toBeNull();
    expect(record).toMatchObject({
      schema_version: 1,
      requirement_id: spec.requirement_id,
      task_id: "task_tool",
      run_id: "run_tool",
      pi_session_id: "pi_tool",
      tool_call_id: "call_execute",
    });
    expect(record?.source_files).toEqual({ binding_gdc: "source_assets/file.tsv" });
    expect(record?.registered_source_asset_ids).toEqual([]);
    expect(record?.mapping_files).toEqual({ binding_gdc: "source_assets/annot.txt" });
    expect(record?.spec.requirement_id).toBe(spec.requirement_id);
    // The record exists before the core was invoked: a crash during the
    // execution can always be resumed deterministically.
    expect(execute).toHaveBeenCalledTimes(1);
  });

  test("strictly parses the spec before calling the Dataset Core", async () => {
    const validate = vi.fn();
    const tools = createDatasetExecutionTools({
      familyRegistry: createDefaultDatasetFamilyRegistry(),
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
    const tools = createDatasetExecutionTools({
      familyRegistry: createDefaultDatasetFamilyRegistry(),
      client: { validate, execute }, taskId: "task_tool", taskRoot: await toolTaskRoot(), runId: () => "run_tool", piSessionId: () => "pi_tool", onDiagnostic: diagnostic,
    });
    const result = await tools[1]!.execute(
      { spec, source_files: {}, mapping_files: {} },
      undefined,
      { toolCallId: "x".repeat(500) },
    );

    expect(execute).not.toHaveBeenCalled();
    expect(result).toMatchObject({ isError: true, details: { code: "spec_rejected" } });
    expect(diagnostic).toHaveBeenCalledWith(expect.objectContaining({
      taskId: "task_tool",
      runId: "run_tool",
      piSessionId: "pi_tool",
      toolCallId: "x".repeat(128),
      toolName: "execute_dataset_execution",
      requestId: "request_reject",
    }));
  });

  test("exposes a compact typed DatasetExecutionSpec schema", async () => {
    const tools = createDatasetExecutionTools({
      familyRegistry: createDefaultDatasetFamilyRegistry(),
      client: { validate: async () => ({ version: 1, request_id: "r", ok: true, data: { valid: true, reason_codes: [], reasons: [] }, error: null }), execute: async () => ({ version: 1, request_id: "r", ok: false, data: null, error: { code: "no_data", message: "x", retryable: false, details: {} } }) },
      taskId: "task_tool",
      taskRoot: await toolTaskRoot(),
      runId: () => "run_tool",
      piSessionId: () => "pi_tool",
    });
    const specWrapper = (tools[0]!.parameters as {
      properties?: Record<string, unknown>;
    }).properties?.spec as {
      anyOf: Array<Record<string, unknown>>;
    };
    expect((specWrapper.anyOf[1] as Record<string, unknown>).type).toBe("string");
    const compactSchema = specWrapper.anyOf[0] as {
      properties: Record<string, Record<string, unknown>>;
      required: string[];
      additionalProperties: boolean;
    };
    expect(compactSchema.additionalProperties).toBe(false);
    expect(compactSchema.required).toContain("schema_ref");
    expect(compactSchema.required).toContain("validation_profile_ref");
    expect(compactSchema.required).toContain("source_bindings");
    expect(compactSchema.properties.schema_ref.enum).toContain("gene_expression.long.v1");
    expect(compactSchema.properties.validation_profile_ref.enum).toContain(
      "gene_expression.release.v1",
    );
    expect(JSON.stringify(tools[0]!.parameters).length).toBeLessThan(20_000);
  });

  test("keeps family/schema compatibility authoritative after schema compaction", async () => {
    const validate = vi.fn(async (): Promise<DatasetBridgeResponse> => ({
      version: 1,
      request_id: "request_validate",
      ok: false,
      data: null,
      error: {
        code: "spec_rejected",
        message: "family/schema mismatch",
        retryable: false,
        details: { reason_codes: ["family_schema_mismatch"] },
      },
    }));
    const [validateTool] = createDatasetExecutionTools({
      familyRegistry: createDefaultDatasetFamilyRegistry(),
      client: { validate, execute: vi.fn() },
      taskId: "task_tool",
      taskRoot: await toolTaskRoot(),
      runId: () => "run_tool",
      piSessionId: () => "pi_tool",
    });
    const result = await validateTool!.execute({
      spec: { ...spec, dataset_family: "variant_evidence" },
    });
    expect(validate).toHaveBeenCalledWith(expect.objectContaining({
      spec: expect.objectContaining({ dataset_family: "variant_evidence" }),
    }));
    expect(result).toMatchObject({ isError: true, details: { code: "spec_rejected" } });
  });
});
