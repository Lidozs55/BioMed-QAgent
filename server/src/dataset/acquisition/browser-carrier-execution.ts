import { createHash } from "node:crypto";
import { mkdir, rm, stat } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
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
  tableId: string;
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
    return { adapter: result, tableId: input.tableId, relativePath, absolutePath, sha256: sink.sha256, sizeBytes: info.size };
  } catch (error) {
    await sink.rollback();
    throw error;
  }
}
