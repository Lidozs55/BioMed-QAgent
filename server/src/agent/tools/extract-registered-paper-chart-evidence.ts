/**
 * ``extract_registered_paper_chart_evidence`` tool (Gold6 vision repair T5).
 *
 * The governed paper chart promotion path: consumes ONLY task-owned
 * ``SourceAsset`` registrations (paper full-text XML, paper PDF, supplementary
 * carriers), runs the configured visual model through the live
 * ``resolveVlmConfig`` seam, and registers ONE content-addressed evidence
 * carrier through the task ``SourceAssetRegistry``. VLM-derived points stay
 * ``estimated`` + pending review; this tool registers candidate evidence and
 * never publishes a Publication.
 */

import type { BioMedAgentTool } from "../contracts.js";
import type { ToolApprovalGate, ToolServiceDeps } from "./tool-hooks.js";
import {
  extractRegisteredPaperChartEvidence,
  type RegisteredPaperChartEvidenceResult,
} from "../../processing/vlm/registered-paper-chart-extraction.js";
import type { VlmConfig } from "../../processing/vlm/vlm-client.js";
import type { PublicHttpClient } from "../../external/network/http-client.js";
import type { SourceAssetRegistry } from "../../runtime/source-assets/registry.js";
import { errorResult } from "./result.js";

export const EXTRACT_REGISTERED_PAPER_CHART_EVIDENCE_TOOL_NAME =
  "extract_registered_paper_chart_evidence";

export interface RegisteredPaperChartEvidenceToolDeps extends ToolServiceDeps {
  /** Task-owned registration seam; required for the governed path. */
  sourceAssetRegistry: SourceAssetRegistry;
  /** Live visual-model resolver consulted per extraction call. */
  resolveVlmConfig?: () => Promise<VlmConfig>;
  /** Injectable HTTP client (fixture tests; default is the public policy client). */
  httpClient?: PublicHttpClient;
  /** Durable credential approval gate (VLM access is credentialed). */
  approvalGate?: ToolApprovalGate | null;
}

function requireAssetIdArgument(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^asset_[0-9a-f]{64}$/.test(value)) {
    throw new TypeError(`${field} must be a registered asset id (asset_<sha256>)`);
  }
  return value;
}

/**
 * Create the governed registered-paper chart evidence tool. Returns a
 * one-element array for symmetry with the P5-12 bundle flattener.
 */
export function createRegisteredPaperChartEvidenceTool(
  deps: RegisteredPaperChartEvidenceToolDeps,
): BioMedAgentTool[] {
  const tool: BioMedAgentTool = {
    name: EXTRACT_REGISTERED_PAPER_CHART_EVIDENCE_TOOL_NAME,
    label: "Extract registered paper chart evidence",
    description:
      "Governed paper chart evidence extraction: reads a registered paper " +
      "full-text XML asset and a registered paper PDF asset (plus optional " +
      "registered supplementary assets) through the task SourceAssetRegistry, " +
      "extracts paper, experiment, activity, chart series, and chart point " +
      "candidates with the configured visual model, and registers ONE " +
      "content-addressed evidence carrier. Returns the registration receipt, " +
      "row counts, and pending review ids. Inputs must be registered asset ids " +
      "(asset_<sha256>), never paths or browser screenshots. VLM-derived " +
      "points are estimated and pending review; this tool registers candidate " +
      "evidence and cannot publish.",
    parameters: {
      type: "object",
      properties: {
        paper_xml_asset_id: {
          type: "string",
          description:
            "Registered asset id (asset_<sha256>) of the paper full-text XML " +
            "(application/xml or text/xml) for this task.",
        },
        paper_pdf_asset_id: {
          type: "string",
          description:
            "Registered asset id (asset_<sha256>) of the paper PDF " +
            "(application/pdf) for this task.",
        },
        supplementary_asset_ids: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional registered asset ids of supplementary carriers for the " +
            "same paper. Browser screenshots are rejected.",
        },
        paper_id: {
          type: "string",
          description: "Paper identifier as assigned by paper_id_namespace.",
        },
        paper_id_namespace: {
          type: "string",
          description: "Authority for paper_id: pubmed, pmc, or doi.",
        },
      },
      required: ["paper_xml_asset_id", "paper_pdf_asset_id", "paper_id", "paper_id_namespace"],
      additionalProperties: false,
    },
    execute: async (argumentsValue, signal) => {
      const record = argumentsValue as Record<string, unknown>;
      const request = {
        paper_xml_asset_id: requireAssetIdArgument(record.paper_xml_asset_id, "paper_xml_asset_id"),
        paper_pdf_asset_id: requireAssetIdArgument(record.paper_pdf_asset_id, "paper_pdf_asset_id"),
        supplementary_asset_ids: record.supplementary_asset_ids === undefined
          ? []
          : (() => {
              if (!Array.isArray(record.supplementary_asset_ids)) {
                throw new TypeError("supplementary_asset_ids must be an array of registered asset ids");
              }
              return record.supplementary_asset_ids.map((id) =>
                requireAssetIdArgument(id, "supplementary_asset_ids"));
            })(),
        paper_id: (() => {
          if (typeof record.paper_id !== "string" || record.paper_id.trim() === "") {
            throw new TypeError("paper_id must be a non-empty string");
          }
          return record.paper_id;
        })(),
        paper_id_namespace: (() => {
          if (typeof record.paper_id_namespace !== "string" || record.paper_id_namespace.trim() === "") {
            throw new TypeError("paper_id_namespace must be a non-empty string");
          }
          return record.paper_id_namespace;
        })(),
      };
      if (deps.approvalGate === undefined || deps.approvalGate === null) {
        return {
          content: JSON.stringify({
            status: "error",
            code: "permission_gate_unavailable",
            retryable: false,
            error: "credential permission gate is required for governed VLM paper extraction",
          }),
          isError: true,
        };
      }
      const permission = await deps.approvalGate.request(
        EXTRACT_REGISTERED_PAPER_CHART_EVIDENCE_TOOL_NAME,
        signal,
      );
      if (permission === "reject") {
        return {
          content: JSON.stringify({
            status: "error",
            code: "permission_denied",
            retryable: false,
            error: "credential permission was rejected for governed VLM paper extraction",
          }),
          isError: true,
        };
      }
      if (deps.resolveVlmConfig === undefined) {
        return {
          content: JSON.stringify({
            status: "error",
            code: "vlm_config_unavailable",
            retryable: false,
            error: "no visual model role is configured; governed paper chart extraction is unavailable",
          }),
          isError: true,
        };
      }
      let result: RegisteredPaperChartEvidenceResult;
      try {
        result = await extractRegisteredPaperChartEvidence(request, {
          taskRoot: deps.taskRoot,
          sourceAssetRegistry: deps.sourceAssetRegistry,
          resolveVlmConfig: deps.resolveVlmConfig,
          httpClient: deps.httpClient,
        }, signal);
      } catch (error) {
        const failure = errorResult(error);
        return {
          content: JSON.stringify({ status: "error", ...(failure.details as object) }),
          details: failure.details,
          isError: true,
        };
      }
      return { content: JSON.stringify(result, null, 2) };
    },
  };

  return [tool];
}
