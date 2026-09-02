/**
 * Z1 (gold10 2026-09-02) — extracted archive members must bind into formal
 * builds. Extract paths already register members at write time as task-owned
 * assets with provenance (core asset extract tool: derived provenance; the
 * acquisition runtime: acquisition provenance). The remaining Z1 gap was on
 * the Dataset Core binding side: for a registered member whose layout is
 * ``source_assets/extracted/...`` (or ``source_assets/extract/...``) instead
 * of the legacy ``source_assets/<asset_id>/`` directory, the layout-agnostic
 * fallback in ``uniqueAssetFile`` handed an ABSOLUTE path to
 * ``registry.register``, which died on "source asset path must be a relative
 * source_assets path" — both the asset-id form and the relative-path form
 * (reversed through ``resolveByRelativePath``) rejected. This suite pins that
 * both forms bind with full validation intact, and unregistered paths stay
 * rejected with an actionable error.
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveAssetReferences } from "../src/agent/tools/dataset-execution.js";
import { crc32 } from "../src/dataset/acquisition/zip-members.js";
import { parseDatasetExecutionSpec } from "../src/dataset/contracts/index.js";
import { TypeScriptDatasetCore } from "../src/dataset/service/ts-core.js";
import { TsDatasetCoreAdapter, type AssetResolutionRecord } from "../src/dataset/service/dataset-core.js";
import { SourceAssetRegistry } from "../src/runtime/source-assets/registry.js";
import { createCoreAssetTools } from "../src/agent/tools/core-asset-tools.js";

const cleanupRoots: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function u16(value: number): Buffer {
  return Buffer.from([value & 0xff, (value >>> 8) & 0xff]);
}

function u32(value: number): Buffer {
  return Buffer.from([value & 0xff, (value & 0xff00) >>> 8, (value & 0xff0000) >>> 16, (value >>> 24) & 0xff]);
}

/** Build a STORE-method zip; the extract tool CRC-verifies each member. */
function storedZip(entries: ReadonlyArray<{ name: string; data: Buffer }>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localBytes = 0;
  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, "utf8");
    const local = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(crc32(entry.data)), u32(entry.data.byteLength), u32(entry.data.byteLength),
      u16(nameBytes.byteLength), u16(0), nameBytes, entry.data,
    ]);
    localParts.push(local);
    centralParts.push(Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(crc32(entry.data)), u32(entry.data.byteLength), u32(entry.data.byteLength),
      u16(nameBytes.byteLength), u16(0), u16(0), u16(0), u16(0), u32(0),
      u32(localBytes), nameBytes,
    ]));
    localBytes += local.byteLength;
  }
  const directory = Buffer.concat(centralParts);
  const eocd = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length),
    u32(directory.byteLength), u32(localBytes), u16(0),
  ]);
  return Buffer.concat([...localParts, directory, eocd]);
}

const TSV_CONTENT = "gene_id\tS1\tS2\nTP53\t1.5\t2\nBRCA1\t3\t4.25\n";

function spec(requirementId: string): ReturnType<typeof parseDatasetExecutionSpec> {
  return parseDatasetExecutionSpec({
    schema_version: "1.0",
    requirement_id: requirementId,
    objective: "Z1 extracted member binding",
    dataset_family: "gene_expression",
    row_granularity: "gene_sample_measurement",
    schema_ref: "gene_expression.long.v1",
    source_bindings: [{
      schema_version: "1.0",
      binding_id: "binding_gdc",
      source: "gdc",
      acquisition: { schema_version: "1.0", mode: "builtin", provider_id: "gdc.files.v1" },
      adapter_id: "gdc.expression.v1",
    }],
    validation_profile_ref: "gene_expression.release.v1",
  });
}

interface Fixture {
  root: string;
  registry: SourceAssetRegistry;
}

async function createFixture(taskId: string): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), "z1-binding-"));
  cleanupRoots.push(root);
  await mkdir(path.join(root, "source_assets"), { recursive: true });
  return { root, registry: new SourceAssetRegistry(taskId, root) };
}

describe("extracted member formal binding (Z1)", () => {
  it("binds an extract_core_archive member by reverse-looked-up relative path with derived provenance", async () => {
    const { root, registry } = await createFixture("task_z1_extract");
    const archive = storedZip([{ name: "binding_table.tsv", data: Buffer.from(TSV_CONTENT, "utf8") }]);
    await writeFile(path.join(root, "source_assets", "supplement.zip"), archive);
    // Acquired carriers register with acquisition provenance (as the download
    // tools and the acquisition runtime do) so extract can derive from them.
    const carrier = await registry.register({
      sourceId: "supplement_fixture",
      relativePath: "source_assets/supplement.zip",
      role: "carrier",
      mediaType: "application/zip",
    });
    await registry.registerCoreAcquisitionProvenance(carrier, {
      provider_id: "fixture.provider",
      implementation_digest: "a".repeat(64),
      request_identity_digest: "b".repeat(64),
      canonical_accession: "supplement.zip",
    });
    const [, extract] = createCoreAssetTools({
      taskId: "task_z1_extract",
      sourceAssetRegistry: registry,
      sourceAssetsRoot: root,
    });
    const extracted = await extract.execute({ asset_id: carrier.asset_ref.asset_id, member: "binding_table.tsv" });
    expect(extracted.isError).not.toBe(true);
    const member = JSON.parse(extracted.content) as {
      ok: boolean;
      asset_id: string;
      relative_path: string;
      media_type: string;
    };
    expect(member.ok).toBe(true);
    expect(member.media_type).toBe("text/tab-separated-values");

    // Derived provenance points back at the parent carrier and the member.
    const provenance = await registry.resolveDerivedProvenance(member.asset_id);
    expect(provenance.parent_asset_ids).toEqual([carrier.asset_ref.asset_id]);
    expect(provenance.output_digest).toBe(member.asset_id.slice("asset_".length));
    const closure = await registry.resolveFormalProvenanceClosure(member.asset_id);
    expect(closure).toHaveLength(2);

    // The extract tool registered the member at write time, so the relative
    // path form resolves to the same asset id before the Core sees it.
    const resolved = await resolveAssetReferences(
      { binding_gdc: member.relative_path },
      "source_files",
      registry,
    );
    expect(resolved.binding_gdc).toBe(member.asset_id);

    const records: AssetResolutionRecord[] = [];
    const adapter = new TsDatasetCoreAdapter(
      new TypeScriptDatasetCore({ taskId: "task_z1_extract", taskRoot: root }),
      { onAssetResolved: (record) => records.push(record) },
    );
    const envelope = await adapter.execute({
      taskId: "task_z1_extract",
      runId: "run_z1_extract",
      piSessionId: "pi_z1",
      toolCallId: "t1",
      spec: spec("build_z1_extract"),
      sourceFiles: { binding_gdc: member.asset_id },
      mappingFiles: {},
    });
    expect(envelope.error?.message).toBeUndefined();
    expect(envelope.ok).toBe(true);
    if (envelope.ok && "registeredSourceAssetIds" in envelope.data) {
      expect(envelope.data.registeredSourceAssetIds).toEqual([member.asset_id]);
    }
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      bindingId: "binding_gdc",
      relativePath: member.relative_path,
      assetId: member.asset_id,
    });
  });

  it("binds an acquire-staged source_assets/extracted member registered as a carrier asset", async () => {
    const { root, registry } = await createFixture("task_z1_staged");
    // The acquisition runtime stages members under
    // source_assets/extracted/<request digest>/ and registers them with the
    // plan role (carrier for europepmc supplementary) plus acquisition
    // provenance; gold10's Z1 block came from binding exactly this shape.
    const memberPath = "source_assets/extracted/1fcb7e4918d53a3f9b7809d9733c9228317b7198a3c6f71adff372b70aa73565/2_table_p0.tsv";
    await mkdir(path.dirname(path.join(root, ...memberPath.split("/"))), { recursive: true });
    await writeFile(path.join(root, ...memberPath.split("/")), TSV_CONTENT);
    const receipt = await registry.register({
      sourceId: "supplement_fixture_x2",
      relativePath: memberPath,
      role: "carrier",
      mediaType: "text/tab-separated-values",
    });
    await registry.registerCoreAcquisitionProvenance(receipt, {
      provider_id: "europepmc.supplementary.v1",
      implementation_digest: "a".repeat(64),
      request_identity_digest: "c".repeat(64),
      canonical_accession: "PMC9005347",
    });
    const memberAssetId = receipt.asset_ref.asset_id;

    const resolved = await resolveAssetReferences({ binding_gdc: memberPath }, "source_files", registry);
    expect(resolved.binding_gdc).toBe(memberAssetId);

    const adapter = new TsDatasetCoreAdapter(
      new TypeScriptDatasetCore({ taskId: "task_z1_staged", taskRoot: root }),
    );
    const envelope = await adapter.execute({
      taskId: "task_z1_staged",
      runId: "run_z1_staged",
      piSessionId: "pi_z1",
      toolCallId: "t1",
      spec: spec("build_z1_staged"),
      sourceFiles: { binding_gdc: memberAssetId },
      mappingFiles: {},
    });
    expect(envelope.ok).toBe(true);
    if (envelope.ok && "registeredSourceAssetIds" in envelope.data) {
      expect(envelope.data.registeredSourceAssetIds).toEqual([memberAssetId]);
    }
  });

  it("keeps unregistered relative paths rejected with an actionable error", async () => {
    const { registry } = await createFixture("task_z1_unregistered");
    await expect(resolveAssetReferences(
      { binding_gdc: "source_assets/extracted/missing/0_table.csv" },
      "source_files",
      registry,
    )).rejects.toThrow(/unregistered path/);
  });
});
