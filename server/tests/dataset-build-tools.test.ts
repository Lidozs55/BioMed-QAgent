import { describe, expect, test, vi } from "vitest";

import type { DatasetBridgeResponse } from "@biomed/contracts";
import { createDatasetBuildTools } from "../src/agent/tools/dataset-build.js";
import { datasetBuildSpec as spec } from "./dataset-bridge-fixture.js";

describe("Pi DatasetBuild tools", () => {
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
      runId: () => "run_tool",
    });
    const controller = new AbortController();

    await validateTool!.execute({ spec }, controller.signal, { toolCallId: "call_validate" });
    const result = await executeTool!.execute(
      { spec, source_files: { binding: "source_assets/file.tsv" }, mapping_files: {} },
      controller.signal,
      { toolCallId: "call_execute" },
    );

    expect(validate).toHaveBeenCalledWith(expect.objectContaining({ signal: controller.signal }));
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ signal: controller.signal }));
    expect(result).toMatchObject({ isError: true, details: { code: "no_data" } });
  });

  test("does not execute a rejected spec and emits bounded diagnostics", async () => {
    const validate = vi.fn(async (): Promise<DatasetBridgeResponse> => ({
      version: 1, request_id: "request_reject", ok: false, data: null,
      error: { code: "spec_rejected", message: "Rejected", retryable: false, details: { reason_codes: ["unknown_schema"] } },
    }));
    const execute = vi.fn();
    const diagnostic = vi.fn();
    const tools = createDatasetBuildTools({
      client: { validate, execute }, taskId: "task_tool", runId: () => "run_tool", onDiagnostic: diagnostic,
    });
    const result = await tools[1]!.execute(
      { spec, source_files: {}, mapping_files: {} },
      undefined,
      { toolCallId: "x".repeat(500) },
    );

    expect(execute).not.toHaveBeenCalled();
    expect(result).toMatchObject({ isError: true, details: { code: "spec_rejected" } });
    expect(diagnostic).toHaveBeenCalledWith(expect.objectContaining({ toolCallId: "x".repeat(128), toolName: "execute_dataset_build", requestId: "request_reject" }));
  });
});
