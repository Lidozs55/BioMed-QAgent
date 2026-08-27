import { createHash } from "node:crypto";
import { copyFile, mkdir, rm, stat } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import type { OperationResultManifest } from "@biomed/contracts";
import { parseOperationResultManifest } from "../contracts/operation-result.js";
import type { RegisteredTableAdapterResult, RegisteredTableSink, RegisteredTableRow } from "../adapters/registered/types.js";
import { RegisteredTableAdapter } from "../adapters/registered/index.js";
import type { SourceAssetRegistry } from "../../runtime/source-assets/registry.js";
import type { BrowserParserRecipeResolver } from "./browser-formalization.js";

export interface BrowserCarrierParserExecutionInput {
  taskId: string;
  runId: string;
  requirementId: string;
  outputDir: string;
  assetId: string;
  requestIdentityDigest: string;
  schemaRef: string;
  recipeId: string;
  recipeVersion: string;
  recipeRegistry: BrowserParserRecipeResolver;
  implementationDigest: string;
  tableId: string;
  familyId: string;
  rowGranularity: string;
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

export interface BrowserCarrierIntegrationInput {
  parsed: BrowserCarrierParserExecutionResult;
  taskId: string;
  runId: string;
  requirementId: string;
  outputDir: string;
  familyId: string;
  rowGranularity: string;
  requestIdentityDigest: string;
  implementationDigest: string;
}

export interface BrowserCarrierIntegrationResult {
  operationResult: OperationResultManifest;
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
export async function integrateBrowserParsedTable(
  input: BrowserCarrierIntegrationInput,
): Promise<BrowserCarrierIntegrationResult> {
  if (input.parsed.operationResult.status !== "succeeded" || input.parsed.operationResult.output_kind !== "parsed_table") {
    throw new Error("browser integration requires a succeeded parsed-table OperationResult");
  }
  const relativePath = `tables/${input.parsed.tableId}.csv`;
  const absolutePath = path.join(input.outputDir, ...relativePath.split("/"));
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await copyFile(input.parsed.absolutePath, absolutePath);
  const info = await stat(absolutePath);
  const sha256 = await sha256File(absolutePath);
  if (info.size !== input.parsed.sizeBytes || sha256 !== input.parsed.sha256) {
    await rm(absolutePath, { force: true });
    throw new Error("browser integration output drifted from parsed-table bytes");
  }
  const parameterDigest = createHash("sha256").update(JSON.stringify({ table_id: input.parsed.tableId, family_id: input.familyId }), "utf8").digest("hex");
  const operationResult = parseOperationResultManifest({
    schema_version: "1.0",
    result_manifest_id: `result_${input.requirementId}_${input.parsed.tableId}_integrated`,
    task_id: input.taskId,
    run_id: input.runId,
    requirement_id: input.requirementId,
    operation_id: `integrate_browser_${input.parsed.tableId}`,
    operation_kind: "integrate",
    operation_attempt_id: `attempt_${input.requirementId}_${input.parsed.tableId}_integrated`,
    attempt: 1,
    status: "succeeded",
    input_digest: input.parsed.operationResult.output_digest,
    parameter_digest: parameterDigest,
    implementation_digest: input.implementationDigest,
    output_digest: sha256,
    output_kind: "integrated_table",
    output_summary: {
      table_id: input.parsed.tableId,
      dataset_family: input.familyId,
      row_granularity: input.rowGranularity,
      schema_ref: input.parsed.operationResult.output_summary.schema_ref,
      row_count: input.parsed.adapter.audit.accepted_row_count,
      column_count: input.parsed.adapter.schema.fields.length,
      primary_file_sha256: sha256,
    },
    output_files: [{ relative_path: relativePath, size_bytes: info.size, sha256 }],
    dependency_closure: {
      input_asset_ids: input.parsed.operationResult.dependency_closure.input_asset_ids,
      upstream_result_manifest_ids: [input.parsed.operationResult.result_manifest_id],
      parameter_digest: parameterDigest,
      implementation_digest: input.implementationDigest,
    },
    commit: { state: "committed", commit_id: `commit_${input.requirementId}_${input.parsed.tableId}_integrated`, committed_at: new Date().toISOString() },
  }, input.taskId, input.runId, input.requirementId);
  return { operationResult, relativePath, absolutePath, sha256, sizeBytes: info.size };
}

async function sha256File(filePath: string): Promise<string> {
  const bytes = await (await import("node:fs/promises")).readFile(filePath);
  return createHash("sha256").update(bytes).digest("hex");
}

export async function executeBrowserCarrierParser(
  input: BrowserCarrierParserExecutionInput,
): Promise<BrowserCarrierParserExecutionResult> {
  const resolved = await input.sourceAssetRegistry.resolveCoreAcquired(
    input.assetId,
    input.requestIdentityDigest,
    "carrier",
  );
  const evidence = {
    schema_version: "1.0" as const,
    evidence_id: `carrier_${input.assetId}`,
    task_id: input.taskId,
    run_id: input.runId,
    requested_url: resolved.acquisition_provenance.canonical_accession ?? resolved.registration_receipt.relative_path,
    final_url: resolved.acquisition_provenance.canonical_accession ?? resolved.registration_receipt.relative_path,
    redirect_chain: [],
    status: 200,
    media_type: resolved.registration_receipt.media_type,
    retrieved_at: resolved.acquisition_provenance.provider_revision_token ?? new Date().toISOString(),
    bytes_received: resolved.registration_receipt.size_bytes,
    sha256: resolved.registration_receipt.sha256,
    browser_policy_revision: "public-http-browser.v1" as const,
    source_asset_id: resolved.registration_receipt.asset_ref.asset_id,
    source_id: resolved.registration_receipt.source_id,
    relative_path: resolved.registration_receipt.relative_path,
    download_attempt_id: "formalized",
    provider_id: "browser.snapshot.v1" as const,
    provider_implementation_digest: resolved.acquisition_provenance.implementation_digest,
  };
  const recipe = input.recipeRegistry.resolve(input.recipeId, input.recipeVersion, evidence);
  const registeredTables = {
    resolve: (adapterId: string, parserVersion: string) => input.recipeRegistry.resolveRegisteredTable(adapterId, parserVersion),
  };
  const adapter = new RegisteredTableAdapter(registeredTables);
  const registration = registeredTables.resolve(recipe.adapter_id, recipe.parser_version);
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
      adapter_id: recipe.adapter_id,
      parser_version: recipe.parser_version,
    }, resolved, sink, input.signal);
    await sink.close();
    const info = await stat(absolutePath);
    if (info.size !== sink.sizeBytes) throw new Error("browser parser output size changed during commit");
    const outputSha256 = sink.sha256;
    const parameterDigest = createHash("sha256")
      .update(JSON.stringify({ table_id: input.tableId, recipe_id: recipe.ref.recipe_id, recipe_version: recipe.ref.recipe_version }), "utf8")
      .digest("hex");
    const operationResult = parseOperationResultManifest({
      schema_version: "1.0",
      result_manifest_id: `result_${input.requirementId}_${input.tableId}`,
      task_id: input.taskId,
      run_id: input.runId,
      requirement_id: input.requirementId,
      operation_id: `parse_browser_${input.tableId}`,
      operation_kind: "parse",
      operation_attempt_id: `attempt_${input.requirementId}_${input.tableId}`,
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
        row_granularity: input.rowGranularity,
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
      commit: { state: "committed", commit_id: `commit_${input.requirementId}_${input.tableId}`, committed_at: new Date().toISOString() },
    }, input.taskId, input.runId, input.requirementId);
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
