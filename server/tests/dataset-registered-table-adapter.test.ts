import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import type {
  DatasetSchemaV2,
  SourceAssetRegistrationReceipt,
} from "@biomed/contracts";
import { describe, expect, it } from "vitest";

import {
  RegisteredTableAdapter,
  RegisteredTableAdapterError,
  RegisteredTableRegistry,
  parseRegisteredTableAdapterRequest,
  type RegisteredTableAdapterResult,
  type RegisteredTableAudit,
  type RegisteredTableRejectedRow,
  type RegisteredTableRow,
  type RegisteredTableSink,
} from "../src/dataset/adapters/registered/index.js";

const FIXTURES = path.join(import.meta.dirname, "fixtures", "registered-table");
const LIMITS = {
  max_bytes: 1024 * 1024,
  max_rows: 100,
  max_columns: 16,
  max_line_characters: 4096,
};

const field = (
  name: string,
  dataType: string,
  nullable = false,
): DatasetSchemaV2["fields"][number] => ({
  schema_version: "2.0",
  name,
  data_type: dataType,
  semantic_role: name === "accession" ? "identifier" : "attribute",
  required: true,
  nullable,
  unit_policy: null,
  ontology: null,
  description: name,
  derivation_policy: null,
});

const proteinSchema: DatasetSchemaV2 = {
  schema_version: "2.0",
  schema_id: "protein_record.v1",
  dataset_family: "target_evidence",
  row_granularity: "protein_record",
  primary_key: ["accession"],
  fields: [
    field("accession", "string"),
    field("entry_name", "string"),
    field("reviewed", "boolean"),
    field("taxon_id", "integer"),
    field("protein_name", "string"),
  ],
};

class MemorySink implements RegisteredTableSink {
  readonly stagedRows: RegisteredTableRow[] = [];
  readonly stagedRejectedRows: RegisteredTableRejectedRow[] = [];
  committed: RegisteredTableAdapterResult | null = null;
  rolledBack: RegisteredTableAudit | null = null;

  writeRow(row: RegisteredTableRow): void {
    this.stagedRows.push(row);
  }

  writeRejectedRow(row: RegisteredTableRejectedRow): void {
    this.stagedRejectedRows.push(row);
  }

  commit(result: RegisteredTableAdapterResult): void {
    this.committed = result;
  }

  rollback(audit: RegisteredTableAudit): void {
    this.rolledBack = audit;
    this.stagedRows.length = 0;
    this.stagedRejectedRows.length = 0;
  }
}

function registry(): RegisteredTableRegistry {
  const value = new RegisteredTableRegistry();
  const delimitedFields = proteinSchema.fields.map((item) => ({
    source_column: item.name,
    target_field: item.name,
  }));
  value.register({
    schema: proteinSchema,
    parser: {
      adapter_id: "registered_uniprot_json",
      parser_version: "1_0_0",
      schema_ref: proteinSchema.schema_id,
      format: "json",
      rows_pointer: "/results",
      fields: [
        { source_pointer: "/primaryAccession", target_field: "accession" },
        { source_pointer: "/uniProtkbId", target_field: "entry_name" },
        { source_pointer: "/reviewed", target_field: "reviewed" },
        { source_pointer: "/organism/taxonId", target_field: "taxon_id" },
        { source_pointer: "/proteinDescription/recommendedName/fullName/value", target_field: "protein_name" },
      ],
      media_types: ["application/json"],
      limits: LIMITS,
    },
  });
  value.register({
    schema: proteinSchema,
    parser: {
      adapter_id: "registered_protein_csv",
      parser_version: "1_0_0",
      schema_ref: proteinSchema.schema_id,
      format: "csv",
      fields: delimitedFields,
      media_types: ["text/csv"],
      limits: LIMITS,
    },
  });
  value.register({
    schema: proteinSchema,
    parser: {
      adapter_id: "registered_protein_tsv",
      parser_version: "1_0_0",
      schema_ref: proteinSchema.schema_id,
      format: "tsv",
      fields: delimitedFields,
      media_types: ["text/tab-separated-values"],
      limits: LIMITS,
    },
  });
  return value;
}

async function fixture(name: string): Promise<Buffer> {
  return readFile(path.join(FIXTURES, name));
}

function receipt(
  bytes: Buffer,
  mediaType: string,
  options: { sha256?: string; sizeBytes?: number; mode?: "asset_id" | "legacy_task_path" } = {},
): SourceAssetRegistrationReceipt {
  const sha256 = options.sha256 ?? createHash("sha256").update(bytes).digest("hex");
  const mode = options.mode ?? "asset_id";
  return {
    schema_version: "1.0",
    receipt_id: "receipt_1",
    task_id: "task_1",
    asset_ref: {
      schema_version: "1.0",
      asset_id: `asset_${sha256}`,
      task_id: "task_1",
      role: "source",
    },
    source_id: "uniprot_rest",
    relative_path: "source_assets/uniprot/search.json",
    sha256,
    size_bytes: options.sizeBytes ?? bytes.length,
    media_type: mediaType,
    registered_at: "2026-08-18T00:00:00Z",
    path_compatibility: mode === "asset_id"
      ? {
          schema_version: "1.0",
          mode: "asset_id",
          legacy_path: null,
          telemetry_event: "asset_ref_used",
        }
      : {
          schema_version: "1.0",
          mode: "legacy_task_path",
          legacy_path: "source_assets/uniprot/search.json",
          telemetry_event: "legacy_path_compatibility_used",
        },
  };
}

function request(assetId: string, adapterId: string) {
  return {
    schema_version: "1.0",
    task_id: "task_1",
    asset_id: assetId,
    schema_ref: proteinSchema.schema_id,
    adapter_id: adapterId,
    parser_version: "1_0_0",
  } as const;
}

async function parseFixture(name: string, mediaType: string, adapterId: string, sink = new MemorySink()) {
  const bytes = await fixture(name);
  const registrationReceipt = receipt(bytes, mediaType);
  const result = await new RegisteredTableAdapter(registry()).parse(
    request(registrationReceipt.asset_ref.asset_id, adapterId),
    {
      registration_receipt: registrationReceipt,
      content: (async function* () { yield bytes; })(),
    },
    sink,
  );
  return { result, sink, bytes, registrationReceipt };
}

async function expectRejected(action: Promise<unknown>): Promise<RegisteredTableAdapterError> {
  try {
    await action;
  } catch (error) {
    expect(error).toBeInstanceOf(RegisteredTableAdapterError);
    return error as RegisteredTableAdapterError;
  }
  throw new Error("expected registered table adapter rejection");
}

describe("schema-driven registered SourceAsset table adapter", () => {
  it("adapts a realistic UniProt REST JSON shape with typed values and JSON-pointer locators", async () => {
    const { result, sink, registrationReceipt } = await parseFixture(
      "uniprot-search.valid.json",
      "application/json",
      "registered_uniprot_json",
    );

    expect(result.audit).toMatchObject({
      status: "accepted",
      asset_id: registrationReceipt.asset_ref.asset_id,
      registration_receipt_id: "receipt_1",
      schema_ref: proteinSchema.schema_id,
      adapter_id: "registered_uniprot_json",
      parser_version: "1_0_0",
      format: "json",
      locator_version: "2.0",
      accepted_row_count: 1,
      rejected_row_count: 0,
      actual_sha256: registrationReceipt.sha256,
      actual_size_bytes: registrationReceipt.size_bytes,
    });
    expect(sink.stagedRows[0]?.values).toEqual({
      accession: "P04637",
      entry_name: "P53_HUMAN",
      reviewed: true,
      taxon_id: 9606,
      protein_name: "Cellular tumor antigen p53",
    });
    expect(sink.stagedRows[0]?.locators.accession).toEqual(expect.objectContaining({
      locator_type: "json_pointer",
      asset_id: registrationReceipt.asset_ref.asset_id,
      json_pointer: "/results/0/primaryAccession",
    }));
    expect(sink.committed?.audit.status).toBe("accepted");
    expect(sink.rolledBack).toBeNull();
  });

  it("supports strict CSV parsing with source line/column locators", async () => {
    const { result, sink } = await parseFixture(
      "proteins.valid.csv",
      "text/csv",
      "registered_protein_csv",
    );

    expect(result.audit).toMatchObject({ format: "csv", accepted_row_count: 2 });
    expect(sink.stagedRows[1]?.values.taxon_id).toBe(9606);
    expect(sink.stagedRows[1]?.locators.protein_name).toEqual(expect.objectContaining({
      source_line_number: 3,
      source_column_index: 4,
      source_column_name: "protein_name",
    }));
  });

  it("audits strict TSV row-width/type failures and rolls the staged table back", async () => {
    const bytes = await fixture("proteins.invalid.tsv");
    const registrationReceipt = receipt(bytes, "text/tab-separated-values");
    const sink = new MemorySink();
    const error = await expectRejected(new RegisteredTableAdapter(registry()).parse(
      request(registrationReceipt.asset_ref.asset_id, "registered_protein_tsv"),
      { registration_receipt: registrationReceipt, content: (async function* () { yield bytes; })() },
      sink,
    ));

    expect(error.audit).toMatchObject({
      status: "rejected",
      adapter_id: "registered_protein_tsv",
      parser_version: "1_0_0",
      accepted_row_count: 0,
      rejected_row_count: 2,
      fatal_reason_code: "rejected_rows",
      rejection_reason_counts: {
        row_width_mismatch: 1,
        type_mismatch: 1,
      },
      rejected_rows: [
        expect.objectContaining({ row_index: 2, reason_code: "row_width_mismatch" }),
        expect.objectContaining({ row_index: 3, reason_code: "type_mismatch" }),
      ],
    });
    expect(sink.stagedRows).toEqual([]);
    expect(sink.stagedRejectedRows).toEqual([]);
    expect(sink.committed).toBeNull();
    expect(sink.rolledBack?.rejected_row_count).toBe(2);
  });

  it("audits missing and typed fields in realistic JSON and fails the whole table closed", async () => {
    const bytes = await fixture("uniprot-search.invalid.json");
    const registrationReceipt = receipt(bytes, "application/json");
    const sink = new MemorySink();
    const error = await expectRejected(new RegisteredTableAdapter(registry()).parse(
      request(registrationReceipt.asset_ref.asset_id, "registered_uniprot_json"),
      { registration_receipt: registrationReceipt, content: (async function* () { yield bytes; })() },
      sink,
    ));

    expect(error.audit).toMatchObject({
      accepted_row_count: 0,
      rejected_row_count: 1,
      rejection_reason_counts: { type_mismatch: 1 },
      fatal_reason_code: "rejected_rows",
    });
    expect(sink.committed).toBeNull();
    expect(sink.rolledBack).not.toBeNull();
  });

  it("rejects hash and size drift before any table can commit", async () => {
    const bytes = await fixture("proteins.valid.csv");
    const registrationReceipt = receipt(bytes, "text/csv");
    const tampered = Buffer.concat([bytes, Buffer.from("tamper")]);
    const hashSink = new MemorySink();
    const hashError = await expectRejected(new RegisteredTableAdapter(registry()).parse(
      request(registrationReceipt.asset_ref.asset_id, "registered_protein_csv"),
      { registration_receipt: registrationReceipt, content: (async function* () { yield tampered; })() },
      hashSink,
    ));
    expect(hashError.audit.fatal_reason_code).toBe("size_drift");
    expect(hashSink.committed).toBeNull();

    const sameSizeTamper = Buffer.from(bytes);
    sameSizeTamper[sameSizeTamper.length - 2] ^= 1;
    const digestSink = new MemorySink();
    const digestError = await expectRejected(new RegisteredTableAdapter(registry()).parse(
      request(registrationReceipt.asset_ref.asset_id, "registered_protein_csv"),
      { registration_receipt: registrationReceipt, content: (async function* () { yield sameSizeTamper; })() },
      digestSink,
    ));
    expect(digestError.audit.fatal_reason_code).toBe("hash_drift");
    expect(digestSink.committed).toBeNull();
  });

  it("rejects legacy workspace/path compatibility, unknown schema/parser versions, and Agent code fields", async () => {
    const bytes = await fixture("uniprot-search.valid.json");
    const legacyReceipt = receipt(bytes, "application/json", { mode: "legacy_task_path" });
    const legacyError = await expectRejected(new RegisteredTableAdapter(registry()).parse(
      request(legacyReceipt.asset_ref.asset_id, "registered_uniprot_json"),
      { registration_receipt: legacyReceipt, content: (async function* () { yield bytes; })() },
      new MemorySink(),
    ));
    expect(legacyError.message).toContain("legacy task paths");

    const coreReceipt = receipt(bytes, "application/json");
    const unknownSchema = await expectRejected(new RegisteredTableAdapter(registry()).parse(
      { ...request(coreReceipt.asset_ref.asset_id, "registered_uniprot_json"), schema_ref: "unknown.v1" },
      { registration_receipt: coreReceipt, content: (async function* () { yield bytes; })() },
      new MemorySink(),
    ));
    expect(unknownSchema.message).toContain("unknown or mismatched schema_ref");

    const unknownParser = await expectRejected(new RegisteredTableAdapter(registry()).parse(
      { ...request(coreReceipt.asset_ref.asset_id, "registered_uniprot_json"), parser_version: "9_9_9" },
      { registration_receipt: coreReceipt, content: (async function* () { yield bytes; })() },
      new MemorySink(),
    ));
    expect(unknownParser.message).toContain("unknown registered parser");

    expect(() => parseRegisteredTableAdapterRequest({
      ...request(coreReceipt.asset_ref.asset_id, "registered_uniprot_json"),
      workspace_path: "data/workspaces/task_1/results.csv",
    })).toThrow(/unknown fields: workspace_path/);
    expect(() => parseRegisteredTableAdapterRequest({
      ...request(coreReceipt.asset_ref.asset_id, "registered_uniprot_json"),
      parser_code: "return row",
    })).toThrow(/unknown fields: parser_code/);
  });
});
