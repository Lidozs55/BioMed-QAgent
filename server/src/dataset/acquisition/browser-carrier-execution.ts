import { createHash } from "node:crypto";
import { mkdir, rm, stat } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import type { OperationResultManifest } from "@biomed/contracts";
import { parseOperationResultManifest } from "../contracts/operation-result.js";
import type { RegisteredTableAdapterResult, RegisteredTableSink, RegisteredTableRow } from "../adapters/registered/types.js";
import { RegisteredTableAdapter, createDefaultRegisteredTableRegistry } from "../adapters/registered/index.js";
import type { SourceAssetRegistry } from "../../runtime/source-assets/registry.js";

export interface BrowserCarrierParserExecutionInput {
  taskId: string;
  buildId: string;
  outputDir: string;
  assetId: string;
  requestIdentityDigest: string;
  schemaRef: string;
  adapterId: string;
  parserVersion: string;
  implementationDigest: string;
  tableId: string;
  familyId: string;
  sourceAssetRegistry: SourceAssetRegistry;
  signal?: AbortSignal | null;
}

export interface BrowserCarrierParserExecutionResult {
  adapter: RegisteredTableAdapterResult;
  tableId: string;
  relativePath: string;
  absolutePath: string;
  sha256: string;
  sizeBytes: number;
  operationResult: OperationResultManifest;
}

function csvCell(value: unknown): string {
  const text = value === null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

class CarrierCsvSink implements RegisteredTableSink {
  #stream: ReturnType<typeof createWriteStream>;
  #hasher = createHash("sha256");
  #size = 0;
  #committed: RegisteredTableAdapterResult | null = null;

  constructor(readonly absolutePath: string, readonly fields: readonly string[]) {
    this.#stream = createWriteStream(absolutePath, { encoding: "utf8" });
    this.#write(`${fields.join(",")}\n`);
  }

  writeRow(row: RegisteredTableRow): void {
    this.#write(`${this.fields.map((field) => csvCell(row.values[field])).join(",")}\n`);
  }

  writeRejectedRow(): void {
    // Strict parser rejection is surfaced by the adapter; rejected rows never enter the table.
  }

  async commit(result: RegisteredTableAdapterResult): Promise<void> {
    this.#committed = result;
    await new Promise<void>((resolve, reject) => {
      this.#stream.once("error", reject);
      this.#stream.end(() => resolve());
    });
  }

  async rollback(): Promise<void> {
    this.#stream.destroy();
    await rm(this.absolutePath, { force: true });
  }

  async close(): Promise<void> {
    if (this.#committed === null) await this.rollback();
  }

  get sizeBytes(): number { return this.#size; }
  get sha256(): string { return this.#hasher.digest("hex"); }

  #write(value: string): void {
    const bytes = Buffer.from(value, "utf8");
    this.#size += bytes.length;
    this.#hasher.update(bytes);
    if (!this.#stream.write(bytes)) {
      // The adapter is synchronous at the sink boundary; the stream's bounded
      // task output directory remains the ownership/quarantine boundary.
    }
  }
}

/** Core-only carrier parser boundary; it stops before OperationResult/publication. */
export async function executeBrowserCarrierParser(
  input: BrowserCarrierParserExecutionInput,
): Promise<BrowserCarrierParserExecutionResult> {
  const resolved = await input.sourceAssetRegistry.resolveCoreAcquired(
    input.assetId,
    input.requestIdentityDigest,
    "carrier",
  );
  const parser = createDefaultRegisteredTableRegistry();
  const adapter = new RegisteredTableAdapter(parser);
  const registration = parser.resolve(input.adapterId, input.parserVersion);
  if (registration.schema.schema_id !== input.schemaRef) throw new Error("browser carrier schema binding mismatch");
  const relativePath = `tables/${input.tableId}.csv`;
  const absolutePath = path.join(input.outputDir, ...relativePath.split("/"));
  await mkdir(path.dirname(absolutePath), { recursive: true });
  const sink = new CarrierCsvSink(absolutePath, registration.schema.fields.map((field) => field.name));
  try {
    const result = await adapter.parseCarrier({
      schema_version: "1.0",
      task_id: input.taskId,
      asset_id: input.assetId,
      schema_ref: input.schemaRef,
      adapter_id: input.adapterId,
      parser_version: input.parserVersion,
    }, resolved, sink, input.signal);
    await sink.close();
    const info = await stat(absolutePath);
    if (info.size !== sink.sizeBytes) throw new Error("browser parser output size changed during commit");
    const outputSha256 = sink.sha256;
    const parameterDigest = createHash("sha256")
      .update(JSON.stringify({ table_id: input.tableId, adapter_id: input.adapterId, parser_version: input.parserVersion }), "utf8")
      .digest("hex");
    const operationResult = parseOperationResultManifest({
      schema_version: "1.0",
      result_manifest_id: `result_${input.buildId}_${input.tableId}`,
      task_id: input.taskId,
      build_id: input.buildId,
      operation_id: `parse_browser_${input.tableId}`,
      operation_kind: "parse",
      operation_attempt_id: `attempt_${input.buildId}_${input.tableId}`,
      attempt: 1,
      status: "succeeded",
      input_digest: input.requestIdentityDigest,
      parameter_digest: parameterDigest,
      implementation_digest: input.implementationDigest,
      output_digest: outputSha256,
      output_kind: "parsed_table",
      output_summary: {
        table_id: input.tableId,
        dataset_family: input.familyId,
        schema_ref: input.schemaRef,
        row_count: result.audit.accepted_row_count,
        column_count: result.schema.fields.length,
      },
      output_files: [{ relative_path: relativePath, size_bytes: info.size, sha256: outputSha256 }],
      dependency_closure: {
        input_asset_ids: [input.assetId],
        upstream_result_manifest_ids: [],
        parameter_digest: parameterDigest,
        implementation_digest: input.implementationDigest,
      },
      commit: { state: "committed", commit_id: `commit_${input.buildId}_${input.tableId}`, committed_at: new Date().toISOString() },
      migration: { mode: "native", legacy_checkpoint_path: null, migrated_at: null },
    }, input.taskId, input.buildId);
    return {
      adapter: result,
      tableId: input.tableId,
      relativePath,
      absolutePath,
      sha256: outputSha256,
      sizeBytes: info.size,
      operationResult,
    };
  } catch (error) {
    await sink.rollback();
    throw error;
  }
}
