import { createHash } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import * as XLSX from "xlsx";
import type { DatasetSchemaV2, JsonValue, SchemaFieldV2 } from "@biomed/contracts";

import {
  assertExactKeys,
  assertNonEmptyString,
  assertRecord,
  assertSafeId,
} from "../../contracts/primitives.js";
import {
  parseRegisteredSourceAssetRef,
  parseSourceAssetRegistrationReceipt,
} from "../../contracts/source.js";
import { parseDatasetSchemaV2 } from "../../contracts/schema.js";
import { throwIfAborted } from "../../cooperative.js";
import { RegisteredTableRegistry } from "./registry.js";
import type {
  CoreResolvedRegisteredAsset,
  RegisteredDelimitedParserDefinition,
  RegisteredJsonParserDefinition,
  RegisteredXlsxParserDefinition,
  RegisteredTableAdapterRequest,
  RegisteredTableAdapterResult,
  RegisteredTableAudit,
  RegisteredTableParserDefinition,
  RegisteredTableRejectedRow,
  RegisteredTableRejectionCode,
  RegisteredTableRow,
  RegisteredTableSink,
  RegisteredTableValue,
} from "./types.js";

const REQUEST_KEYS = [
  "schema_version",
  "task_id",
  "asset_id",
  "schema_ref",
  "adapter_id",
  "parser_version",
] as const;
const SUPPORTED_TYPES = new Set(["string", "integer", "float", "number", "boolean", "date", "datetime", "json"]);

export class RegisteredTableAdapterError extends Error {
  constructor(
    message: string,
    readonly audit: RegisteredTableAudit,
  ) {
    super(message);
    this.name = "RegisteredTableAdapterError";
  }
}

export function parseRegisteredTableAdapterRequest(value: unknown): RegisteredTableAdapterRequest {
  const record = assertRecord(value, "RegisteredTableAdapterRequest");
  assertExactKeys(record, REQUEST_KEYS, "RegisteredTableAdapterRequest");
  if (record.schema_version !== "1.0") {
    throw new TypeError("RegisteredTableAdapterRequest.schema_version must be 1.0");
  }
  const taskId = assertSafeId(record.task_id, "RegisteredTableAdapterRequest.task_id");
  const assetId = assertSafeId(record.asset_id, "RegisteredTableAdapterRequest.asset_id");
  parseRegisteredSourceAssetRef({ schema_version: "1.0", asset_id: assetId, task_id: taskId, role: "source" }, taskId);
  return {
    schema_version: "1.0",
    task_id: taskId,
    asset_id: assetId,
    schema_ref: assertNonEmptyString(record.schema_ref, "RegisteredTableAdapterRequest.schema_ref"),
    adapter_id: parserIdentifier(record.adapter_id, "RegisteredTableAdapterRequest.adapter_id"),
    parser_version: parserIdentifier(record.parser_version, "RegisteredTableAdapterRequest.parser_version"),
  };
}

function parserIdentifier(value: unknown, name: string): string {
  const identifier = assertNonEmptyString(value, name);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(identifier) || identifier.includes("..")) {
    throw new TypeError(`${name} must be a registered parser identifier`);
  }
  return identifier;
}

function initialAudit(
  request: RegisteredTableAdapterRequest,
  asset: CoreResolvedRegisteredAsset,
  schema: DatasetSchemaV2,
  parser: RegisteredTableParserDefinition,
): RegisteredTableAudit {
  const receipt = asset.registration_receipt;
  return {
    schema_version: "1.0",
    status: "rejected",
    task_id: request.task_id,
    asset_id: request.asset_id,
    registration_receipt_id: receipt.receipt_id,
    source_id: receipt.source_id,
    schema_ref: request.schema_ref,
    dataset_family: schema.dataset_family,
    row_granularity: schema.row_granularity,
    adapter_id: request.adapter_id,
    parser_version: request.parser_version,
    format: parser.format,
    locator_version: parser.format === "json" ? "2.0" : "1.0",
    media_type: receipt.media_type,
    declared_size_bytes: receipt.size_bytes,
    actual_size_bytes: null,
    declared_sha256: receipt.sha256,
    actual_sha256: null,
    accepted_row_count: 0,
    rejected_row_count: 0,
    rejection_reason_counts: {},
    rejected_rows: [],
    fatal_reason_code: null,
    fatal_reason: null,
  };
}

function fatal(audit: RegisteredTableAudit, code: string, message: string): RegisteredTableAudit {
  return { ...audit, status: "rejected", fatal_reason_code: code, fatal_reason: message };
}

function rejectCount(audit: RegisteredTableAudit, code: RegisteredTableRejectionCode): void {
  audit.rejected_row_count += 1;
  audit.rejection_reason_counts = {
    ...audit.rejection_reason_counts,
    [code]: (audit.rejection_reason_counts[code] ?? 0) + 1,
  };
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function convertValue(value: unknown, field: SchemaFieldV2): RegisteredTableValue {
  if (value === null || value === undefined || value === "") {
    if (field.nullable) return null;
    throw new Error("value is null or blank but field is not nullable");
  }
  if (!SUPPORTED_TYPES.has(field.data_type)) {
    throw new Error(`unsupported schema data type ${field.data_type}`);
  }
  switch (field.data_type) {
    case "string":
      if (typeof value !== "string") throw new Error("value must be a string");
      return value;
    case "integer": {
      if ((typeof value !== "string" && typeof value !== "number") || !/^[+-]?\d+$/.test(String(value))) {
        throw new Error("value must be an integer");
      }
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed)) throw new Error("integer is outside the safe range");
      return parsed;
    }
    case "float":
    case "number": {
      if ((typeof value !== "string" && typeof value !== "number") || String(value).trim() === "") {
        throw new Error("value must be numeric");
      }
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) throw new Error("value must be a finite number");
      return parsed;
    }
    case "boolean":
      if (value === true || value === "true") return true;
      if (value === false || value === "false") return false;
      throw new Error("value must be true or false");
    case "date":
      if (typeof value !== "string" || !validDate(value)) throw new Error("value must be an ISO date");
      return value;
    case "datetime":
      if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value) || Number.isNaN(Date.parse(value))) {
        throw new Error("value must be an ISO datetime");
      }
      return value;
    case "json": {
      const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
      if (!isJsonValue(parsed)) throw new Error("value must be JSON-compatible");
      return parsed;
    }
    default:
      throw new Error(`unsupported schema data type ${field.data_type}`);
  }
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return typeof value === "object" && value !== null && Object.values(value).every(isJsonValue);
}

function pointerSegments(pointer: string): string[] {
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) throw new Error(`JSON pointer must be empty or start with '/': ${pointer}`);
  return pointer.slice(1).split("/").map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function jsonPointer(value: unknown, pointer: string): unknown {
  let current = value;
  for (const segment of pointerSegments(pointer)) {
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(segment)) return undefined;
      current = current[Number(segment)];
    } else if (current !== null && typeof current === "object") {
      current = Reflect.get(current, segment);
    } else {
      return undefined;
    }
  }
  return current;
}

function validateRegistration(
  request: RegisteredTableAdapterRequest,
  asset: CoreResolvedRegisteredAsset,
  parser: RegisteredTableParserDefinition,
  allowedRole: "source" | "carrier" = "source",
): void {
  const receipt = parseSourceAssetRegistrationReceipt(asset.registration_receipt, request.task_id);
  if (receipt.asset_ref.asset_id !== request.asset_id) throw new Error("resolved receipt does not match requested asset ID");
  if (receipt.asset_ref.role !== allowedRole) throw new Error(`registered-table adapter requires a ${allowedRole}-role asset`);
  if (receipt.path_compatibility.mode !== "asset_id") throw new Error("legacy task paths are not trusted registered-table inputs");
  if (!parser.media_types.includes(receipt.media_type.toLowerCase())) {
    throw new Error(`registered asset media type is not allowed by parser: ${receipt.media_type}`);
  }
}

function validateParser(schema: DatasetSchemaV2, parser: RegisteredTableParserDefinition): void {
  parseDatasetSchemaV2(schema);
  const targetFields = parser.fields.map((field) => field.target_field);
  const expected = schema.fields.map((field) => field.name);
  if (targetFields.length !== expected.length || targetFields.some((field, index) => field !== expected[index])) {
    throw new Error("registered parser fields must match the schema exactly and preserve order");
  }
  if (new Set(targetFields).size !== targetFields.length) throw new Error("registered parser target fields must be unique");
  if (parser.fields.some((field) => parser.format === "json" ? !(field as { source_pointer: string }).source_pointer.startsWith("/") : !(field as { source_column: string }).source_column)) {
    throw new Error("registered parser source mapping is invalid");
  }
  if (parser.limits.max_columns < expected.length || Object.values(parser.limits).some((value) => !Number.isSafeInteger(value) || value < 1)) {
    throw new Error("registered parser limits are invalid");
  }
}

function verifyDigest(audit: RegisteredTableAudit, size: number, digest: string): void {
  audit.actual_size_bytes = size;
  audit.actual_sha256 = digest;
  if (size !== audit.declared_size_bytes) throw new Error("registered asset size drift detected");
  if (digest !== audit.declared_sha256) throw new Error("registered asset hash drift detected");
}

async function collectVerifiedBytes(
  content: AsyncIterable<Uint8Array>,
  parser: RegisteredTableParserDefinition,
  audit: RegisteredTableAudit,
  signal?: AbortSignal | null,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const hasher = createHash("sha256");
  let size = 0;
  for await (const chunk of content) {
    throwIfAborted(signal);
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > parser.limits.max_bytes) throw new Error(`asset exceeds parser max_bytes (${parser.limits.max_bytes})`);
    hasher.update(bytes);
    chunks.push(bytes);
  }
  verifyDigest(audit, size, hasher.digest("hex"));
  return Buffer.concat(chunks, size);
}

function parseStrictDelimitedLine(line: string, delimiter: string): string[] {
  if (line.length === 0) return [];
  const fields: string[] = [];
  let field = "";
  let quoted = false;
  let closedQuote = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quoted) {
      if (character === '"') {
        if (line[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
          closedQuote = true;
        }
      } else {
        field += character;
      }
    } else if (character === delimiter) {
      fields.push(field);
      field = "";
      closedQuote = false;
    } else if (character === '"') {
      if (field.length > 0 || closedQuote) throw new Error("quote must begin an empty field");
      quoted = true;
    } else {
      if (closedQuote) throw new Error("characters after a closing quote are forbidden");
      field += character;
    }
  }
  if (quoted) throw new Error("quoted field is not closed on the same row");
  fields.push(field);
  return fields;
}

function nextLineBreak(text: string): { index: number; length: number } | null {
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") return { index, length: 1 };
    if (text[index] === "\r") {
      if (index + 1 >= text.length) return null;
      return { index, length: text[index + 1] === "\n" ? 2 : 1 };
    }
  }
  return null;
}

function delimitedLocator(assetId: string, logicalFile: string, line: number, column: number, name: string, raw: string) {
  return {
    schema_version: "1.0" as const,
    asset_id: assetId,
    logical_file: logicalFile,
    source_line_number: line,
    source_column_index: column,
    source_column_name: name,
    raw_value: raw,
  };
}

async function parseDelimited(
  content: AsyncIterable<Uint8Array>,
  receipt: CoreResolvedRegisteredAsset["registration_receipt"],
  schema: DatasetSchemaV2,
  parser: RegisteredDelimitedParserDefinition,
  sink: RegisteredTableSink,
  audit: RegisteredTableAudit,
  signal?: AbortSignal | null,
): Promise<void> {
  const expectedHeader = parser.fields.map((field) => field.source_column);
  const delimiter = parser.format === "csv" ? "," : "\t";
  const decoder = new StringDecoder("utf8");
  const hasher = createHash("sha256");
  let pending = "";
  let size = 0;
  let line = 0;
  let dataRows = 0;
  let headerSeen = false;

  const consumeLine = async (raw: string): Promise<void> => {
    line += 1;
    if (raw.length > parser.limits.max_line_characters) {
      throw new Error(`line ${line} exceeds max_line_characters`);
    }
    let values: string[];
    try {
      values = parseStrictDelimitedLine(raw, delimiter);
    } catch (error) {
      if (!headerSeen) throw new Error("delimited header is malformed", { cause: error });
      dataRows += 1;
      await writeRejection(sink, audit, {
        row_index: line,
        reason_code: "malformed_delimited_row",
        reason: error instanceof Error ? error.message : String(error),
        source_locator: delimitedLocator(receipt.asset_ref.asset_id, receipt.relative_path, line, 0, "", raw),
      });
      return;
    }
    if (!headerSeen) {
      headerSeen = true;
      if (values.length > parser.limits.max_columns) throw new Error("header exceeds parser max_columns");
      if (values.length !== expectedHeader.length || values.some((value, index) => value !== expectedHeader[index])) {
        throw new Error(`header mismatch: actual=${JSON.stringify(values)} expected=${JSON.stringify(expectedHeader)}`);
      }
      return;
    }
    dataRows += 1;
    if (dataRows > parser.limits.max_rows) throw new Error(`asset exceeds parser max_rows (${parser.limits.max_rows})`);
    if (values.length !== expectedHeader.length) {
      await writeRejection(sink, audit, {
        row_index: line,
        reason_code: "row_width_mismatch",
        reason: `row has ${values.length} fields; expected ${expectedHeader.length}`,
        source_locator: delimitedLocator(receipt.asset_ref.asset_id, receipt.relative_path, line, 0, "", raw),
      });
      return;
    }
    const parsed = rowFromValues(
      values,
      schema,
      (fieldIndex) => delimitedLocator(receipt.asset_ref.asset_id, receipt.relative_path, line, fieldIndex, expectedHeader[fieldIndex] ?? "", values[fieldIndex] ?? ""),
      line,
    );
    if (parsed.rejection !== null) await writeRejection(sink, audit, parsed.rejection);
    else {
      await sink.writeRow(parsed.row);
      audit.accepted_row_count += 1;
    }
  };

  for await (const chunk of content) {
    throwIfAborted(signal);
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > parser.limits.max_bytes) throw new Error(`asset exceeds parser max_bytes (${parser.limits.max_bytes})`);
    hasher.update(bytes);
    pending += decoder.write(bytes);
    while (true) {
      const lineBreak = nextLineBreak(pending);
      if (lineBreak === null) break;
      const raw = pending.slice(0, lineBreak.index);
      pending = pending.slice(lineBreak.index + lineBreak.length);
      await consumeLine(raw);
    }
    if (pending.length > parser.limits.max_line_characters) {
      throw new Error(`line ${line + 1} exceeds max_line_characters`);
    }
  }
  pending += decoder.end();
  if (pending.endsWith("\r")) {
    const finalLine = pending.slice(0, -1);
    if (finalLine.length > 0) await consumeLine(finalLine);
    pending = "";
  }
  if (pending.length > 0) await consumeLine(pending);
  if (!headerSeen) throw new Error("delimited asset is empty and has no header");
  verifyDigest(audit, size, hasher.digest("hex"));
}

function rowFromValues(
  values: readonly unknown[],
  schema: DatasetSchemaV2,
  locator: (fieldIndex: number) => RegisteredTableRow["locators"][string],
  rowIndex: number,
): { row: RegisteredTableRow; rejection: null } | { row: null; rejection: RegisteredTableRejectedRow } {
  const converted: Record<string, RegisteredTableValue> = {};
  const locators: Record<string, RegisteredTableRow["locators"][string]> = {};
  for (let index = 0; index < schema.fields.length; index += 1) {
    const field = schema.fields[index];
    const raw = values[index];
    const sourceLocator = locator(index);
    try {
      converted[field.name] = convertValue(raw, field);
      locators[field.name] = sourceLocator;
    } catch (error) {
      const blank = raw === undefined || raw === null || raw === "";
      return {
        row: null,
        rejection: {
          row_index: rowIndex,
          reason_code: blank ? (raw === undefined ? "missing_field" : "nullability_violation") : "type_mismatch",
          reason: `${field.name}: ${error instanceof Error ? error.message : String(error)}`,
          source_locator: sourceLocator,
        },
      };
    }
  }
  return { row: { row_index: rowIndex, values: converted, locators }, rejection: null };
}

async function parseXlsx(
  bytes: Buffer,
  receipt: CoreResolvedRegisteredAsset["registration_receipt"],
  schema: DatasetSchemaV2,
  parser: RegisteredXlsxParserDefinition,
  sink: RegisteredTableSink,
  audit: RegisteredTableAudit,
): Promise<void> {
  const workbook = XLSX.read(bytes, { type: "buffer", cellDates: false, cellNF: false, cellText: false });
  const sheet = workbook.Sheets[parser.sheet_name];
  if (sheet === undefined) throw new Error(`xlsx sheet not found: ${parser.sheet_name}`);
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true, defval: null, blankrows: false });
  if (rows.length === 0) throw new Error("xlsx sheet has no header row");
  const expectedHeader = parser.fields.map((field) => field.source_column);
  const header = rows[0]?.map((value) => value === null ? "" : String(value)) ?? [];
  if (header.length !== expectedHeader.length || header.some((value, index) => value !== expectedHeader[index])) {
    throw new Error(`xlsx header mismatch: actual=${JSON.stringify(header)} expected=${JSON.stringify(expectedHeader)}`);
  }
  if (rows.length - 1 > parser.limits.max_rows) throw new Error(`asset exceeds parser max_rows (${parser.limits.max_rows})`);
  for (let index = 1; index < rows.length; index += 1) {
    const values = rows[index] ?? [];
    if (values.length > parser.limits.max_columns) throw new Error("xlsx row exceeds parser max_columns");
    if (values.length !== expectedHeader.length) {
      await writeRejection(sink, audit, {
        row_index: index,
        reason_code: "row_width_mismatch",
        reason: `row has ${values.length} fields; expected ${expectedHeader.length}`,
        source_locator: { locator_version: "2.0", locator_type: "xml_cell", asset_id: receipt.asset_ref.asset_id, logical_file: receipt.relative_path, raw_value: JSON.stringify(values), xml_path: `/${parser.sheet_name}/row[${index + 1}]`, table_id: parser.sheet_name, row_index: index, column_index: 0 },
      });
      continue;
    }
    const parsed = rowFromValues(values, schema, (fieldIndex) => ({
      locator_version: "2.0",
      locator_type: "xml_cell",
      asset_id: receipt.asset_ref.asset_id,
      logical_file: `${receipt.relative_path}#${parser.sheet_name}`,
      raw_value: String(values[fieldIndex] ?? ""),
      xml_path: `/${parser.sheet_name}/row[${index + 1}]/cell[${fieldIndex + 1}]`,
      table_id: parser.sheet_name,
      row_index: index,
      column_index: fieldIndex,
    }), index);
    if (parsed.rejection !== null) await writeRejection(sink, audit, parsed.rejection);
    else { await sink.writeRow(parsed.row); audit.accepted_row_count += 1; }
  }
}

async function parseJson(
  bytes: Buffer,
  receipt: CoreResolvedRegisteredAsset["registration_receipt"],
  schema: DatasetSchemaV2,
  parser: RegisteredJsonParserDefinition,
  sink: RegisteredTableSink,
  audit: RegisteredTableAudit,
): Promise<void> {
  let document: unknown;
  try {
    document = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch (error) {
    throw new Error(
      `invalid JSON asset: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const rows = jsonPointer(document, parser.rows_pointer);
  if (!Array.isArray(rows)) throw new Error(`rows_pointer does not resolve to an array: ${parser.rows_pointer}`);
  if (rows.length > parser.limits.max_rows) throw new Error(`asset exceeds parser max_rows (${parser.limits.max_rows})`);
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const values = parser.fields.map((field) => jsonPointer(row, field.source_pointer));
    const pointers = parser.fields.map((field) => `${parser.rows_pointer}/${index}${field.source_pointer}`);
    const parsed = rowFromValues(
      values,
      schema,
      (fieldIndex) => ({
        locator_version: "2.0",
        locator_type: "json_pointer",
        asset_id: receipt.asset_ref.asset_id,
        logical_file: receipt.relative_path,
        raw_value: JSON.stringify(values[fieldIndex] ?? null),
        json_pointer: pointers[fieldIndex] ?? `${parser.rows_pointer}/${index}`,
      }),
      index,
    );
    if (parsed.rejection !== null) await writeRejection(sink, audit, parsed.rejection);
    else {
      await sink.writeRow(parsed.row);
      audit.accepted_row_count += 1;
    }
  }
}

async function writeRejection(
  sink: RegisteredTableSink,
  audit: RegisteredTableAudit,
  rejection: RegisteredTableRejectedRow,
): Promise<void> {
  rejectCount(audit, rejection.reason_code);
  audit.rejected_rows = [...audit.rejected_rows, rejection];
  await sink.writeRejectedRow(rejection);
}

function ensureNoRejectedRows(audit: RegisteredTableAudit): void {
  if (audit.rejected_row_count > 0) {
    throw new Error(`${audit.rejected_row_count} row(s) failed strict schema validation`);
  }
  if (audit.accepted_row_count === 0) throw new Error("registered table contains no accepted rows");
}

export class RegisteredTableAdapter {
  constructor(private readonly registry: Pick<RegisteredTableRegistry, "resolve">) {}

  async parse(
    requestValue: unknown,
    asset: CoreResolvedRegisteredAsset,
    sink: RegisteredTableSink,
    signal?: AbortSignal | null,
  ): Promise<RegisteredTableAdapterResult> {
    return this.#parse(requestValue, asset, sink, signal, "source");
  }

  async parseCarrier(
    requestValue: unknown,
    asset: CoreResolvedRegisteredAsset,
    sink: RegisteredTableSink,
    signal?: AbortSignal | null,
  ): Promise<RegisteredTableAdapterResult> {
    return this.#parse(requestValue, asset, sink, signal, "carrier");
  }

  async #parse(
    requestValue: unknown,
    asset: CoreResolvedRegisteredAsset,
    sink: RegisteredTableSink,
    signal: AbortSignal | null | undefined,
    allowedRole: "source" | "carrier",
  ): Promise<RegisteredTableAdapterResult> {
    const request = parseRegisteredTableAdapterRequest(requestValue);
    let schema: DatasetSchemaV2 = {
      schema_version: "2.0",
      schema_id: request.schema_ref,
      dataset_family: "unknown",
      row_granularity: "unknown",
      primary_key: ["unknown"],
      fields: [{ schema_version: "2.0", name: "unknown", data_type: "string", semantic_role: "unknown", required: true, nullable: false, unit_policy: null, ontology: null, description: "", derivation_policy: null }],
    };
    let parser: RegisteredTableParserDefinition = {
      adapter_id: request.adapter_id,
      parser_version: request.parser_version,
      schema_ref: request.schema_ref,
      format: "json",
      rows_pointer: "/",
      fields: [{ source_pointer: "/", target_field: "unknown" }],
      media_types: [],
      limits: { max_bytes: 1, max_rows: 1, max_columns: 1, max_line_characters: 1 },
    };
    let audit = initialAudit(request, asset, schema, parser);
    try {
      const registration = this.registry.resolve(request.adapter_id, request.parser_version);
      schema = registration.schema;
      parser = registration.parser;
      audit = initialAudit(request, asset, schema, parser);
      if (request.schema_ref !== schema.schema_id || parser.schema_ref !== schema.schema_id) {
        throw new Error(`unknown or mismatched schema_ref: ${request.schema_ref}`);
      }
      validateParser(schema, parser);
      validateRegistration(request, asset, parser, allowedRole);
      if (parser.format === "json") {
        const bytes = await collectVerifiedBytes(asset.content, parser, audit, signal);
        await parseJson(bytes, asset.registration_receipt, schema, parser, sink, audit);
      } else if (parser.format === "xlsx") {
        const bytes = await collectVerifiedBytes(asset.content, parser, audit, signal);
        await parseXlsx(bytes, asset.registration_receipt, schema, parser, sink, audit);
      } else {
        await parseDelimited(asset.content, asset.registration_receipt, schema, parser, sink, audit, signal);
      }
      ensureNoRejectedRows(audit);
      audit.status = "accepted";
      const result = { schema, audit };
      await sink.commit(result);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = message.includes("hash drift") ? "hash_drift"
        : message.includes("size drift") ? "size_drift"
          : message.includes("row(s) failed") ? "rejected_rows"
            : "registered_table_rejected";
      audit = fatal(audit, code, message);
      await sink.rollback(audit);
      throw new RegisteredTableAdapterError(message, audit);
    }
  }
}
