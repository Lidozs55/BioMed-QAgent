import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  CoreDerivedAssetProvenance,
  OperationResultManifest,
  SourceAssetRegistrationReceipt,
} from "@biomed/contracts";
import * as XLSX from "xlsx";

import { csvLine, delimitedRowsWithLines } from "../adapters/text.js";
import { extractTablesRaw } from "../../processing/pdf/tables.js";
import type { SourceAssetRegistry } from "../../runtime/source-assets/registry.js";
import type { ArchiveMemberAsset } from "./zip-members.js";

export interface ParsedArchiveMemberAsset {
  parser_id: string;
  source_member_asset_id: string;
  logical_table: string;
  receipt: SourceAssetRegistrationReceipt;
  provenance: CoreDerivedAssetProvenance;
}

export interface ParsedArchiveMembersResult {
  parsed_assets: readonly ParsedArchiveMemberAsset[];
  operation_results: readonly OperationResultManifest[];
}

interface ParserOutput {
  logicalTable: string;
  content: string;
}

export interface RegisteredArchiveMemberParser {
  parserId: string;
  mediaTypes: ReadonlySet<string>;
  parse(file: string, bytes: Buffer): Promise<readonly ParserOutput[]>;
}

const MAX_MEMBER_PARSE_BYTES = 256 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 512 * 1024 * 1024;

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeTableName(value: string, fallback: string): string {
  const normalized = value.normalize("NFC").replace(/[^A-Za-z0-9._-]+/gu, "_").replace(/^_+|_+$/gu, "");
  return normalized === "" ? fallback : normalized.slice(0, 128);
}

function normalizedDelimited(delimiter: "," | "\t"): RegisteredArchiveMemberParser {
  const mediaType = delimiter === "," ? "text/csv" : "text/tab-separated-values";
  return {
    parserId: delimiter === "," ? "archive.csv_to_utf8_csv.v1" : "archive.tsv_to_utf8_csv.v1",
    mediaTypes: new Set([mediaType]),
    async parse(_file, bytes) {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const rows = delimitedRowsWithLines(text, delimiter);
      if (rows.length === 0 || rows[0]!.values.length === 0) throw new TypeError("delimited member has no header");
      const width = rows[0]!.values.length;
      if (width > 512 || rows.some((row) => row.values.length !== width)) {
        throw new TypeError("delimited member has an invalid row width");
      }
      return [{
        logicalTable: "table_1",
        content: rows.map((row) => csvLine(row.values)).join(""),
      }];
    },
  };
}

const XLSX_PARSER: RegisteredArchiveMemberParser = {
  parserId: "archive.xlsx_sheets_to_utf8_csv.v1",
  mediaTypes: new Set(["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"]),
  async parse(_file, bytes) {
    const workbook = XLSX.read(bytes, { type: "buffer", cellDates: false, cellNF: false, cellText: false });
    if (workbook.SheetNames.length === 0 || workbook.SheetNames.length > 128) {
      throw new TypeError("XLSX member has an invalid sheet count");
    }
    return workbook.SheetNames.map((sheetName, index) => {
      const sheet = workbook.Sheets[sheetName];
      if (sheet === undefined) throw new TypeError(`XLSX sheet '${sheetName}' is missing`);
      const content = XLSX.utils.sheet_to_csv(sheet, { FS: ",", RS: "\r\n", blankrows: false });
      if (content.trim() === "") throw new TypeError(`XLSX sheet '${sheetName}' is empty`);
      return { logicalTable: safeTableName(sheetName, `sheet_${index + 1}`), content };
    });
  },
};

const PDF_TABLE_PARSER: RegisteredArchiveMemberParser = {
  parserId: "archive.pdf_tables_to_utf8_csv.v1",
  mediaTypes: new Set(["application/pdf"]),
  async parse(file) {
    const extraction = await extractTablesRaw(file);
    if (extraction.tables.length === 0) throw new TypeError("PDF member contains no extractable table");
    return extraction.tables.map((table, index) => ({
      logicalTable: `page_${table.page ?? 1}_table_${index + 1}`,
      content: [table.header, ...table.rows].map((row) => csvLine(row)).join(""),
    }));
  },
};

export const REGISTERED_ARCHIVE_MEMBER_PARSERS: readonly RegisteredArchiveMemberParser[] = Object.freeze([
  normalizedDelimited(","),
  normalizedDelimited("\t"),
  XLSX_PARSER,
  PDF_TABLE_PARSER,
]);

function parserFor(mediaType: string): RegisteredArchiveMemberParser | null {
  return REGISTERED_ARCHIVE_MEMBER_PARSERS.find((parser) => parser.mediaTypes.has(mediaType)) ?? null;
}

/** Parse supported archive members through fixed, Core-owned parser registrations. */
export async function parseRegisteredArchiveMembers(options: {
  taskId: string;
  taskRoot: string;
  sourceAssetRegistry: SourceAssetRegistry;
  members: readonly ArchiveMemberAsset[];
}): Promise<ParsedArchiveMembersResult> {
  const parsedAssets: ParsedArchiveMemberAsset[] = [];
  const operationResults: OperationResultManifest[] = [];
  for (const member of options.members) {
    const parser = parserFor(member.media_type);
    if (parser === null) continue;
    if (member.size_bytes > MAX_MEMBER_PARSE_BYTES) {
      throw new TypeError(`archive member '${member.member_path}' exceeds the registered parser limit`);
    }
    const file = path.join(options.taskRoot, ...member.receipt.relative_path.split("/"));
    const bytes = await readFile(file);
    if (digest(bytes) !== member.member_sha256) throw new Error("archive member drifted before registered parsing");
    const parametersDigest = digest(JSON.stringify({
      parser_id: parser.parserId,
      source_member_asset_id: member.receipt.asset_ref.asset_id,
    }));
    const operationResultId = `result_parser_${digest(`${parser.parserId}\u0000${member.member_sha256}\u0000${parametersDigest}`).slice(0, 32)}`;
    const implementationDigest = digest(`${parser.parserId}@1.0.0`);
    let outputs: readonly ParserOutput[];
    try {
      outputs = await parser.parse(file, bytes);
      if (outputs.length === 0 || outputs.length > 128) {
        throw new TypeError("registered archive parser returned an invalid output count");
      }
    } catch (error) {
      const failure: OperationResultManifest = {
        schema_version: "1.0",
        result_manifest_id: operationResultId,
        task_id: options.taskId,
        run_id: "core",
        requirement_id: "archive_member_parse",
        operation_id: operationResultId,
        operation_kind: "parse",
        operation_attempt_id: `attempt_${operationResultId}`,
        attempt: 1,
        status: "failed",
        input_digest: member.member_sha256,
        parameter_digest: parametersDigest,
        implementation_digest: implementationDigest,
        output_digest: null,
        output_kind: "source_asset",
        output_summary: {
          parser_id: parser.parserId,
          source_member_asset_id: member.receipt.asset_ref.asset_id,
          error: error instanceof Error ? error.message : String(error),
        },
        output_files: [],
        dependency_closure: {
          input_asset_ids: [member.receipt.asset_ref.asset_id],
          upstream_result_manifest_ids: [member.provenance.operation_result_id],
          parameter_digest: parametersDigest,
          implementation_digest: implementationDigest,
        },
        commit: {
          state: "committed",
          commit_id: `commit_${operationResultId}`,
          committed_at: member.provenance.created_at,
        },
      };
      await options.sourceAssetRegistry.recordDerivedOperationResult(failure);
      operationResults.push(failure);
      continue;
    }
    const operationAssets: ParsedArchiveMemberAsset[] = [];
    let totalOutputBytes = 0;
    for (const output of outputs) {
      const outputBytes = Buffer.from(output.content, "utf8");
      totalOutputBytes += outputBytes.length;
      if (totalOutputBytes > MAX_OUTPUT_BYTES) throw new TypeError("registered archive parser output exceeds the Core limit");
      const outputSha = digest(outputBytes);
      const relativePath = `source_assets/parsed-members/${member.member_sha256}/${outputSha}.csv`;
      const absolutePath = path.join(options.taskRoot, ...relativePath.split("/"));
      await mkdir(path.dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, outputBytes, { flag: "wx" }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
      const storedOutput = await readFile(absolutePath);
      if (storedOutput.length !== outputBytes.length || digest(storedOutput) !== outputSha) {
        throw new Error("registered archive parser output bytes do not match the parser result");
      }
      const registered = await options.sourceAssetRegistry.registerDerived({
        sourceId: `parsed_member_${outputSha.slice(0, 24)}`,
        relativePath,
        role: "source",
        mediaType: "text/csv",
        parentAssetIds: [member.receipt.asset_ref.asset_id],
        operationKind: "registered_parser",
        operationResultId,
        implementationId: parser.parserId,
        implementationVersion: "1.0.0",
        parametersDigest,
        evidence: {
          parser_id: parser.parserId,
          source_member_asset_id: member.receipt.asset_ref.asset_id,
          source_member_path: member.member_path,
          source_member_sha256: member.member_sha256,
          logical_table: output.logicalTable,
          output_sha256: outputSha,
        },
      });
      if (
        registered.receipt.sha256 !== outputSha
        || registered.receipt.size_bytes !== outputBytes.length
      ) {
        throw new Error("registered archive parser output bytes do not match the parser result");
      }
      operationAssets.push({
        parser_id: parser.parserId,
        source_member_asset_id: member.receipt.asset_ref.asset_id,
        logical_table: output.logicalTable,
        receipt: registered.receipt,
        provenance: registered.provenance,
      });
    }
    const succeeded: OperationResultManifest = {
      schema_version: "1.0",
      result_manifest_id: operationResultId,
      task_id: options.taskId,
      run_id: "core",
      requirement_id: "archive_member_parse",
      operation_id: operationResultId,
      operation_kind: "parse",
      operation_attempt_id: `attempt_${operationResultId}`,
      attempt: 1,
      status: "succeeded",
      input_digest: member.member_sha256,
      parameter_digest: parametersDigest,
      implementation_digest: implementationDigest,
      output_digest: digest(operationAssets.map((asset) => asset.receipt.sha256).join("\u0000")),
      output_kind: "source_asset",
      output_summary: {
        parser_id: parser.parserId,
        source_member_asset_id: member.receipt.asset_ref.asset_id,
        output_count: operationAssets.length,
      },
      output_files: operationAssets.map((asset) => ({
        relative_path: asset.receipt.relative_path,
        size_bytes: asset.receipt.size_bytes,
        sha256: asset.receipt.sha256,
      })),
      dependency_closure: {
        input_asset_ids: [member.receipt.asset_ref.asset_id],
        upstream_result_manifest_ids: [member.provenance.operation_result_id],
        parameter_digest: parametersDigest,
        implementation_digest: implementationDigest,
      },
      commit: {
        state: "committed",
        commit_id: `commit_${operationResultId}`,
        committed_at: operationAssets[0]?.provenance.created_at ?? member.provenance.created_at,
      },
    };
    await options.sourceAssetRegistry.recordDerivedOperationResult(succeeded);
    operationResults.push(succeeded);
    parsedAssets.push(...operationAssets);
  }
  return Object.freeze({
    parsed_assets: Object.freeze(parsedAssets),
    operation_results: Object.freeze(operationResults),
  });
}
