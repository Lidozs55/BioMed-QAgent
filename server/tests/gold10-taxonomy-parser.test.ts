import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { SourceAssetRegistrationReceipt } from "@biomed/contracts";
import {
  RegisteredTableAdapter,
  RegisteredTableAdapterResult,
  RegisteredTableAudit,
  RegisteredTableRejectedRow,
  RegisteredTableRow,
  RegisteredTableSink,
  createDefaultRegisteredTableRegistry,
} from "../src/dataset/adapters/registered/index.js";
import {
  createDefaultDatasetFamilyRegistry,
  registeredTableSchemasById,
} from "../src/dataset/families/index.js";
import {
  browserRecipeId,
  createDefaultBrowserParserRecipeRegistry,
} from "../src/dataset/acquisition/browser-recipe-registry.js";
import {
  GUT_MICROBIOME_FAMILY_ID,
  GUT_MICROBIOME_TAXON_LONG_TSV_ADAPTER_ID,
  GUT_MICROBIOME_TAXON_RECORD_SCHEMA_ID,
  GUT_MICROBIOME_TAXON_SCHEMA_ID,
  GUT_MICROBIOME_TAXON_TABLE_ID,
} from "../src/dataset/families/gut-microbiome/index.js";

const MEDIA_TYPE = "text/tab-separated-values";
const ADAPTER_ID = "registered_gut_microbiome_taxon_tsv";
const PARSER_VERSION = "1_0_0";
const CONTENT = Buffer.from(
  "#SampleID\tERR260132\tERR260133\n" +
  "Root;k__Bacteria;p__Firmicutes\t7\t9\n" +
  "Root;k__Bacteria;p__Actinobacteria\t2\t0\n",
  "utf8",
);

class MemorySink implements RegisteredTableSink {
  readonly stagedRows: RegisteredTableRow[] = [];
  readonly stagedRejectedRows: RegisteredTableRejectedRow[] = [];
  committed: RegisteredTableAdapterResult | null = null;
  rolledBack: RegisteredTableAudit | null = null;

  writeRow(row: RegisteredTableRow): void { this.stagedRows.push(row); }
  writeRejectedRow(row: RegisteredTableRejectedRow): void { this.stagedRejectedRows.push(row); }
  commit(result: RegisteredTableAdapterResult): void { this.committed = result; }
  rollback(audit: RegisteredTableAudit): void {
    this.rolledBack = audit;
    this.stagedRows.length = 0;
    this.stagedRejectedRows.length = 0;
  }
}

function receipt(bytes: Buffer): SourceAssetRegistrationReceipt {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return {
    schema_version: "1.0",
    receipt_id: "receipt_gold10_taxonomy",
    task_id: "task_gold10_taxonomy",
    asset_ref: {
      schema_version: "1.0",
      asset_id: `asset_${sha256}`,
      task_id: "task_gold10_taxonomy",
      role: "source",
    },
    source_id: "mgnify",
    relative_path: "source_assets/mgnify/ERP002469_taxonomy_abundances_v1.0.tsv",
    sha256,
    size_bytes: bytes.length,
    media_type: MEDIA_TYPE,
    registered_at: "2026-08-26T00:00:00Z",
    path_compatibility: {
      schema_version: "1.0",
      mode: "asset_id",
      legacy_path: null,
      telemetry_event: "asset_ref_used",
    },
  };
}

function request(assetId: string, schemaRef = GUT_MICROBIOME_TAXON_SCHEMA_ID) {
  return {
    schema_version: "1.0" as const,
    task_id: "task_gold10_taxonomy",
    asset_id: assetId,
    schema_ref: schemaRef,
    adapter_id: ADAPTER_ID,
    parser_version: PARSER_VERSION,
  };
}

describe("Gold10 MGnify taxonomy TSV binding", () => {
  it("reproduces the missing family/schema/media binding before parser registration", () => {
    const family = createDefaultDatasetFamilyRegistry().get(GUT_MICROBIOME_FAMILY_ID);
    const schema = family.schemas.find((item) => item.schema_id === GUT_MICROBIOME_TAXON_RECORD_SCHEMA_ID);
    expect(schema).toBeDefined();
    expect(schema?.dataset_family).toBe(GUT_MICROBIOME_FAMILY_ID);
    expect(schema?.schema_id).not.toContain("protein_structure");
    expect(registeredTableSchemasById(family).get(GUT_MICROBIOME_TAXON_TABLE_ID)?.schema_id)
      .toBe(GUT_MICROBIOME_TAXON_RECORD_SCHEMA_ID);

    const registration = createDefaultRegisteredTableRegistry().entries().find(
      (entry) => entry.parser.adapter_id === ADAPTER_ID,
    );
    expect(registration).toBeDefined();
    expect(registration?.schema.schema_id).toBe(GUT_MICROBIOME_TAXON_SCHEMA_ID);
    expect(registration?.parser.format).toBe("tsv");
    expect(registration?.parser.media_types).toEqual([MEDIA_TYPE]);
    expect(registration?.parser).toMatchObject({
      layout: "sample_matrix",
      sample_matrix: {
        sample_id_header: "#SampleID",
        row_label_column: "taxon_path",
        value_column: "abundance",
      },
    });
  });

  it("registers a separate strict long-form parser for the four-table family", async () => {
    const tables = createDefaultRegisteredTableRegistry();
    const registration = tables.resolve(GUT_MICROBIOME_TAXON_LONG_TSV_ADAPTER_ID, PARSER_VERSION);
    expect(registration.schema.schema_id).toBe(GUT_MICROBIOME_TAXON_RECORD_SCHEMA_ID);
    expect(registration.parser).toMatchObject({
      adapter_id: GUT_MICROBIOME_TAXON_LONG_TSV_ADAPTER_ID,
      format: "tsv",
      media_types: [MEDIA_TYPE],
    });
    expect(registration.parser.format).toBe("tsv");
    if (registration.parser.format !== "tsv") throw new Error("expected the formal taxon parser to be TSV");
    expect(registration.parser.layout).not.toBe("sample_matrix");
    expect(registration.parser.fields.map((field) => field.target_field)).toEqual([
      "study_id",
      "sample_id",
      "taxon_path",
      "taxon_id",
      "abundance",
      "source_id",
      "source_asset_id",
      "source_locator",
    ]);

    const registrationReceipt = receipt(CONTENT);
    const sink = new MemorySink();
    await expect(new RegisteredTableAdapter(tables).parse(
      {
        ...request(
          registrationReceipt.asset_ref.asset_id,
          GUT_MICROBIOME_TAXON_RECORD_SCHEMA_ID,
        ),
        adapter_id: GUT_MICROBIOME_TAXON_LONG_TSV_ADAPTER_ID,
      },
      {
        registration_receipt: registrationReceipt,
        content: (async function* () { yield CONTENT; })(),
      },
      sink,
    )).rejects.toThrow(/header mismatch/);
    expect(sink.committed).toBeNull();
    expect(sink.rolledBack?.fatal_reason_code).toBe("registered_table_rejected");
  });

  it("rejects a taxonomy carrier whose media type is not the promoted TSV type", async () => {
    const registrationReceipt = { ...receipt(CONTENT), media_type: "application/octet-stream" };
    const sink = new MemorySink();
    await expect(new RegisteredTableAdapter(createDefaultRegisteredTableRegistry()).parse(
      request(registrationReceipt.asset_ref.asset_id),
      {
        registration_receipt: registrationReceipt,
        content: (async function* () { yield CONTENT; })(),
      },
      sink,
    )).rejects.toThrow("media type is not allowed");
    expect(sink.committed).toBeNull();
    expect(sink.rolledBack?.fatal_reason_code).toBe("registered_table_rejected");
  });

  it("parses a strict MGnify taxonomy matrix and preserves receipt bytes/hash", async () => {
    const registrationReceipt = receipt(CONTENT);
    const sink = new MemorySink();
    const result = await new RegisteredTableAdapter(createDefaultRegisteredTableRegistry()).parse(
      request(registrationReceipt.asset_ref.asset_id),
      {
        registration_receipt: registrationReceipt,
        content: (async function* () { yield CONTENT; })(),
      },
      sink,
    );

    expect(result.audit).toMatchObject({
      status: "accepted",
      schema_ref: GUT_MICROBIOME_TAXON_SCHEMA_ID,
      dataset_family: GUT_MICROBIOME_FAMILY_ID,
      adapter_id: ADAPTER_ID,
      parser_version: PARSER_VERSION,
      format: "tsv",
      media_type: MEDIA_TYPE,
      actual_size_bytes: CONTENT.length,
      actual_sha256: registrationReceipt.sha256,
      accepted_row_count: 4,
      rejected_row_count: 0,
    });
      expect(sink.stagedRows.map((row) => row.values)).toEqual([
      { sample_id: "ERR260132", taxon_path: "Root;k__Bacteria;p__Firmicutes", abundance: 7 },
      { sample_id: "ERR260133", taxon_path: "Root;k__Bacteria;p__Firmicutes", abundance: 9 },
      { sample_id: "ERR260132", taxon_path: "Root;k__Bacteria;p__Actinobacteria", abundance: 2 },
      { sample_id: "ERR260133", taxon_path: "Root;k__Bacteria;p__Actinobacteria", abundance: 0 },
    ]);
    expect(sink.stagedRows[0]?.locators.abundance).toEqual(expect.objectContaining({
      source_line_number: 2,
      source_column_index: 1,
      source_column_name: "ERR260132",
    }));
    expect(sink.committed?.audit.status).toBe("accepted");
    expect(sink.rolledBack).toBeNull();
  });

  it("promotes only the schema-bound TSV recipe and keeps office formats fail-closed", () => {
    const tables = createDefaultRegisteredTableRegistry();
    const registration = tables.resolve(ADAPTER_ID, PARSER_VERSION);
    const recipes = createDefaultBrowserParserRecipeRegistry(tables);
    const recipeId = browserRecipeId(ADAPTER_ID, PARSER_VERSION);
    const resolved = recipes.resolve(recipeId, "1", {
      schema_version: "1.0",
      evidence_id: "browser_gold10_taxonomy",
      task_id: "task_gold10_taxonomy",
      run_id: "run_gold10_taxonomy",
      requested_url: "https://www.ebi.ac.uk/metagenomics/example.tsv",
      final_url: "https://www.ebi.ac.uk/metagenomics/example.tsv",
      redirect_chain: [],
      status: 200,
      media_type: MEDIA_TYPE,
      retrieved_at: "2026-08-26T00:00:00Z",
      bytes_received: CONTENT.length,
      sha256: "a".repeat(64),
      browser_policy_revision: "public-http-browser.v1",
      source_asset_id: "asset_gold10_taxonomy",
      source_id: "mgnify",
      relative_path: "source_assets/mgnify/example.tsv",
      download_attempt_id: "download_gold10_taxonomy",
      provider_id: "browser.snapshot.v1",
      provider_implementation_digest: "b".repeat(64),
    });

    expect(resolved).toMatchObject({
      schema_ref: GUT_MICROBIOME_TAXON_SCHEMA_ID,
      adapter_id: ADAPTER_ID,
      parser_version: PARSER_VERSION,
      media_types: [MEDIA_TYPE],
    });
    expect(resolved.ref.implementation_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(registration.schema.schema_id).not.toContain("protein_structure");
    expect(recipes.list()).toContain(`${recipeId}@1`);
    expect(recipes.list()).toContain(
      `${browserRecipeId("registered_gut_microbiome_study_json", PARSER_VERSION)}@1`,
    );
    expect(recipes.list().some((id) => id.includes("docx") || id.includes(".xls."))).toBe(false);
  });
});
