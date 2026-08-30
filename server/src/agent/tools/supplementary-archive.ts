import type { BioMedAgentTool, BioMedToolResult } from "../contracts.js";
import type { ArchiveExtractionResult } from "../../dataset/archive/zip-members.js";
import type { ParsedArchiveMembersResult } from "../../dataset/archive/member-parsers.js";

export type SupplementaryArchiveFormalizationResult =
  ArchiveExtractionResult & ParsedArchiveMembersResult;

export interface SupplementaryArchiveExtractionToolOptions {
  readonly extract: (
    pmcid: string,
    signal: AbortSignal | undefined,
  ) => Promise<SupplementaryArchiveFormalizationResult>;
}

/** Core acquisition + bounded member extraction; never invokes shell/Python/tar. */
export function createSupplementaryArchiveExtractionTool(
  options: SupplementaryArchiveExtractionToolOptions,
): BioMedAgentTool {
  return {
    name: "extract_supplementary_archive",
    label: "Extract Supplementary Archive",
    description:
      "Acquire one official Europe PMC supplementary ZIP through Dataset Core, extract bounded members without shell/Python/tar, and run fixed CSV/TSV, XLSX, and PDF-table parsers. Returns task-owned member/parsed asset receipts, durable OperationResults, parent ZIP hash, member path/hash/media/size, and the registered relative path used by SourceLocator. Parsed asset IDs can be registered profile inputs; workspace extraction is never formal.",
    parameters: {
      type: "object",
      properties: {
        pmcid: { type: "string", pattern: "^PMC[1-9][0-9]*$" },
      },
      required: ["pmcid"],
      additionalProperties: false,
    },
    async execute(value, signal): Promise<BioMedToolResult> {
      try {
        const pmcid = (value as { pmcid?: unknown }).pmcid;
        if (typeof pmcid !== "string" || !/^PMC[1-9][0-9]*$/u.test(pmcid)) {
          throw new TypeError("pmcid must be an uppercase PMC accession");
        }
        const extraction = await options.extract(pmcid, signal);
        const details = {
          ok: true,
          status: "extracted",
          ...extraction,
          operation_result: extraction.operation_result,
          parser_operation_results: extraction.operation_results,
          parsed_assets: extraction.parsed_assets.map((asset) => ({
            parser_id: asset.parser_id,
            source_member_asset_id: asset.source_member_asset_id,
            logical_table: asset.logical_table,
            asset_id: asset.receipt.asset_ref.asset_id,
            sha256: asset.receipt.sha256,
            operation_result_id: asset.provenance.operation_result_id,
          })),
          members: extraction.members.map((member) => ({
            member_path: member.member_path,
            member_sha256: member.member_sha256,
            size_bytes: member.size_bytes,
            media_type: member.media_type,
            registered_relative_path: member.receipt.relative_path,
            asset_id: member.receipt.asset_ref.asset_id,
            registration_receipt_id: member.receipt.receipt_id,
            operation_result_id: member.provenance.operation_result_id,
          })),
        };
        return { content: JSON.stringify(details), details };
      } catch (error) {
        const details = {
          ok: false,
          error: {
            code: "supplementary_archive_extraction_rejected",
            message: error instanceof Error ? error.message : String(error),
            retryable: false,
            unchanged_retry_forbidden: true,
          },
        };
        return { content: JSON.stringify(details), details, isError: true };
      }
    },
  };
}
