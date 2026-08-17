/**
 * PDF extraction tools: ``extract_pdf_tables`` + ``extract_pdf_metadata``
 * (P5-08B, Python ``skills/builtin/processing/extract_tables.py`` parity).
 *
 * Thin BioMedAgentTool wrappers over the processing tier
 * (``server/src/processing/pdf/``); file paths mirror Python
 * ``resolve_task_local_file`` (task-root relative or absolute inside the
 * task root only; escapes rejected before any file I/O).
 */

import path from "node:path";

import type { BioMedAgentTool } from "../contracts.js";
import { noopHooks, type ToolHooks, type ToolServiceDeps } from "./tool-hooks.js";
import { jsonContent } from "./result.js";
import {
  extractPdfMetadata as extractPdfMetadataImpl,
  extractPdfTables as extractPdfTablesImpl,
  type PdfMetadataResult,
  type PdfTablesResult,
} from "../../processing/pdf/index.js";

export const EXTRACT_PDF_TABLES_TOOL_NAME = "extract_pdf_tables";
export const EXTRACT_PDF_METADATA_TOOL_NAME = "extract_pdf_metadata";

export interface PdfToolDeps extends ToolServiceDeps {
  hooks?: ToolHooks;
}

function expectFilePath(value: unknown, toolName: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${toolName}: file_path must be a non-empty string`);
  }
  return value.trim();
}

/**
 * Create the two pdf_extraction tools. ``deps.taskRoot`` is the absolute
 * task work directory; outputs land in ``<taskRoot>/parsed/``.
 */
export function createPdfTools(deps: PdfToolDeps): BioMedAgentTool[] {
  const hooks = noopHooks(deps.hooks);
  const { taskRoot } = deps;

  const extractPdfTablesTool: BioMedAgentTool = {
    name: EXTRACT_PDF_TABLES_TOOL_NAME,
    label: "Extract PDF tables",
    description:
      "Extract all tables from a PDF and save each as CSV to parsed/. " +
      "Each table is saved as {pdf_stem}_table_{N}.csv. Image-only (scanned) " +
      "PDFs return an explicit warning pointing at extract_chart_data_vlm — " +
      "they are never reported as a silent success.",
    parameters: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "Path to the PDF file under the task work directory (e.g. source_assets/paper.pdf).",
        },
      },
      required: ["file_path"],
      additionalProperties: false,
    },
    execute: async (argumentsValue) => {
      const record = argumentsValue as Record<string, unknown>;
      const filePath = expectFilePath(record.file_path, EXTRACT_PDF_TABLES_TOOL_NAME);
      hooks.onQueryStarted?.(filePath, "pdf_extraction");
      let result: PdfTablesResult;
      try {
        result = await extractPdfTablesImpl(filePath, { taskRoot });
      } catch (error) {
        hooks.onQuery?.(filePath, "pdf_extraction", "failed", 0);
        return jsonContent({
          status: "error",
          error: `unexpected error: ${error instanceof Error ? error.message : String(error)}`,
          source_file: filePath,
        });
      }
      if (result.status === "ok") {
        hooks.onQuery?.(filePath, "pdf_extraction", "success", result.summary.total_tables);
        if (result.summary.total_tables > 0) {
          hooks.onProgress?.("processing", "pdf_tables_extracted", {
            source: "extract_pdf_tables",
            source_file: path.basename(result.source_file),
            tables: result.summary.total_tables,
          });
        }
      } else {
        hooks.onQuery?.(filePath, "pdf_extraction", "failed", 0);
      }
      return jsonContent(result);
    },
  };

  const extractPdfMetadataTool: BioMedAgentTool = {
    name: EXTRACT_PDF_METADATA_TOOL_NAME,
    label: "Extract PDF metadata",
    description:
      "Extract paper metadata (title, authors, DOI, abstract, figure/table " +
      "captions, page count) from a PDF and save it as {pdf_stem}_metadata.json " +
      "in parsed/.",
    parameters: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "Path to the PDF file under the task work directory (e.g. source_assets/paper.pdf).",
        },
      },
      required: ["file_path"],
      additionalProperties: false,
    },
    execute: async (argumentsValue) => {
      const record = argumentsValue as Record<string, unknown>;
      const filePath = expectFilePath(record.file_path, EXTRACT_PDF_METADATA_TOOL_NAME);
      hooks.onQueryStarted?.(filePath, "pdf_extraction");
      let result: PdfMetadataResult;
      try {
        result = await extractPdfMetadataImpl(filePath, { taskRoot });
      } catch (error) {
        hooks.onQuery?.(filePath, "pdf_extraction", "failed", 0);
        return jsonContent({
          status: "error",
          error: `unexpected error: ${error instanceof Error ? error.message : String(error)}`,
          source_file: filePath,
        });
      }
      if (result.status === "ok") {
        hooks.onQuery?.(filePath, "pdf_extraction", "success", 1);
      } else {
        hooks.onQuery?.(filePath, "pdf_extraction", "failed", 0);
      }
      return jsonContent(result);
    },
  };

  return [extractPdfTablesTool, extractPdfMetadataTool];
}
