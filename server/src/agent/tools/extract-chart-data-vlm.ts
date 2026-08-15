/**
 * ``extract_chart_data_vlm`` tool (P5-08B, Python
 * ``skills/builtin/processing/extract_chart_data_vlm.py`` parity).
 *
 * Wraps the TS three-tier chart extraction (``server/src/processing/vlm/``):
 * L1 Qwen-VL → L2 PDF tables → L3 captions; all-tiers-failed is an error,
 * never an empty success. VLM credentials come from injected config with
 * ``DASHSCOPE_API_KEY`` / ``DASHSCOPE_BASE_URL`` env fallbacks.
 */

import path from "node:path";

import type { BioMedAgentTool } from "../contracts.js";
import { noopHooks, type ToolHooks, type ToolServiceDeps } from "./tool-hooks.js";
import {
  createVlmTools,
  type VlmConfig,
  type VlmResult,
  type VlmToolHooks,
} from "../../processing/vlm/index.js";
import type { PublicHttpClient } from "../../external/network/http-client.js";

export const EXTRACT_CHART_DATA_VLM_TOOL_NAME = "extract_chart_data_vlm";

export interface ChartDataVlmToolDeps extends ToolServiceDeps {
  hooks?: ToolHooks;
  vlmConfig?: Partial<VlmConfig>;
  /** Injectable HTTP client (fixture tests; default is the public policy client). */
  httpClient?: PublicHttpClient;
  /** Warning surface (Python ``run_ctx.add_warning`` parity). */
  onWarning?: (severity: string, message: string, source: string) => void;
}

function expectString(value: unknown, field: string, fallback: string): string {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string") throw new TypeError(`${field} must be a string`);
  return value;
}

/**
 * Create the chart-extraction tool. Returns a one-element array for symmetry
 * with ``createPdfTools`` and the P5-12 bundle flattener.
 */
export function createChartDataVlmTool(deps: ChartDataVlmToolDeps): BioMedAgentTool[] {
  const hooks = noopHooks(deps.hooks);
  const vlmHooks: VlmToolHooks = {
    onQueryStarted: hooks.onQueryStarted,
    onQuery: hooks.onQuery,
    onProgress: hooks.onProgress,
    onWarning: deps.onWarning,
  };
  const tools = createVlmTools({
    taskRoot: deps.taskRoot,
    hooks: vlmHooks,
    vlmConfig: deps.vlmConfig,
    httpClient: deps.httpClient,
  });

  const tool: BioMedAgentTool = {
    name: EXTRACT_CHART_DATA_VLM_TOOL_NAME,
    label: "Extract chart data via Qwen-VL",
    description:
      "Extract structured chart data (chart_type, axes, data_points, legend) " +
      "from a paper figure image or PDF using the Qwen-VL visual model. " +
      "Accepts PNG/JPG/WEBP/GIF images (e.g., from capture_web_page) or PDF " +
      "files (e.g., from download_supplementary). For PDFs, extracts embedded " +
      "images and runs VLM on each (up to 10 per file). Writes chart_data.csv " +
      "and chart_data_points.csv to parsed/chart_data/. Falls back to PDF " +
      "tables (L2) then caption text (L3) if VLM fails. Returns an error if " +
      "all tiers fail.",
    parameters: {
      type: "object",
      properties: {
        source_path: {
          type: "string",
          description:
            "Path to a PNG/JPG/WEBP/GIF image or a PDF file under the task " +
            "work directory (typically source_assets/figures/ for images or " +
            "source_assets/ for PDFs).",
        },
        hint: {
          type: "string",
          description:
            "Optional extraction hint (e.g., 'scatter plot, log scale'). " +
            "Appended to the VLM prompt to improve accuracy.",
        },
      },
      required: ["source_path"],
      additionalProperties: false,
    },
    execute: async (argumentsValue, signal) => {
      const record = argumentsValue as Record<string, unknown>;
      const sourcePath = expectString(record.source_path, "source_path", "");
      if (sourcePath.trim() === "") {
        throw new TypeError("source_path must be a non-empty string");
      }
      const hint = expectString(record.hint, "hint", "");
      let result: VlmResult;
      try {
        result = await tools.extractChartDataVlm(sourcePath, hint, signal);
      } catch (error) {
        return {
          content: JSON.stringify({
            status: "error",
            error: `unexpected error: ${error instanceof Error ? error.message : String(error)}`,
            source_file: path.basename(sourcePath),
          }),
        };
      }
      return { content: JSON.stringify(result, null, 2) };
    },
  };

  return [tool];
}
