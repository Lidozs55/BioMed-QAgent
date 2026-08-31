import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { extractRegisteredZipMembers } from "../src/dataset/archive/zip-members.js";
import { parseRegisteredArchiveMembers } from "../src/dataset/archive/member-parsers.js";
import { SourceAssetRegistry } from "../src/runtime/source-assets/registry.js";

const roots: string[] = [];

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipStored(entries: readonly { name: string; content: string }[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const content = Buffer.from(entry.content, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc32(content), 14);
    local.writeUInt32LE(content.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, content);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(crc32(content), 16);
    central.writeUInt32LE(content.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, name);
    localOffset += local.length + name.length + content.length;
  }
  const central = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, central, eocd]);
}

async function registeredArchive(bytes: Buffer) {
  const root = await mkdtemp(path.join(os.tmpdir(), "biomed-archive-"));
  roots.push(root);
  await mkdir(path.join(root, "source_assets"), { recursive: true });
  await writeFile(path.join(root, "source_assets", "supplementary.zip"), bytes);
  const registry = new SourceAssetRegistry("task_archive", root, {
    now: () => new Date("2026-08-28T00:00:00.000Z"),
  });
  const receipt = await registry.register({
    sourceId: "source_europepmc",
    relativePath: "source_assets/supplementary.zip",
    role: "carrier",
    mediaType: "application/zip",
  });
  await registry.registerCoreAcquisitionProvenance(receipt, {
    provider_id: "europepmc.supplementary.v1",
    implementation_digest: "a".repeat(64),
    request_identity_digest: "b".repeat(64),
    canonical_accession: "PMC123",
    provider_snapshot_identity: "official",
    provider_revision_token: null,
  });
  return { root, registry, receipt };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Core supplementary archive member extraction", () => {
  it("registers each member with parent archive and member hash lineage", async () => {
    const input = await registeredArchive(zipStored([
      { name: "tables/data.csv", content: "id,value\n1,2\n" },
      { name: "figures/panel.txt", content: "figure caption" },
    ]));
    const result = await extractRegisteredZipMembers({
      taskId: "task_archive",
      taskRoot: input.root,
      archiveAssetId: input.receipt.asset_ref.asset_id,
      sourceAssetRegistry: input.registry,
    });

    expect(result.members).toHaveLength(2);
    expect(result.members[0]).toMatchObject({
      member_path: "tables/data.csv",
      media_type: "text/csv",
      provenance: {
        operation_kind: "archive_member_extraction",
        parent_asset_ids: [input.receipt.asset_ref.asset_id],
      },
    });
    expect(result.members[0]?.member_sha256).toBe(
      createHash("sha256").update("id,value\n1,2\n").digest("hex"),
    );
    expect(result.operation_result).toMatchObject({
      operation_kind: "parse",
      output_kind: "source_asset",
      dependency_closure: { input_asset_ids: [input.receipt.asset_ref.asset_id] },
    });
    await expect(input.registry.resolveDerivedOperationResult(result.operation_result_id))
      .resolves.toEqual(result.operation_result);
    await expect(input.registry.resolveFormalInput(result.members[0]!.receipt.asset_ref.asset_id))
      .resolves.toMatchObject({ acquisition_provenance: null });

    const parsed = await parseRegisteredArchiveMembers({
      taskId: "task_archive",
      taskRoot: input.root,
      sourceAssetRegistry: input.registry,
      members: result.members,
    });
    expect(parsed.parsed_assets).toHaveLength(1);
    expect(parsed.parsed_assets[0]).toMatchObject({
      parser_id: "archive.csv_to_utf8_csv.v1",
      source_member_asset_id: result.members[0]!.receipt.asset_ref.asset_id,
      provenance: { operation_kind: "registered_parser" },
    });
    expect(parsed.operation_results[0]).toMatchObject({
      operation_kind: "parse",
      output_kind: "source_asset",
      dependency_closure: {
        input_asset_ids: [result.members[0]!.receipt.asset_ref.asset_id],
        upstream_result_manifest_ids: [result.operation_result_id],
      },
    });
    await expect(input.registry.resolveDerivedOperationResult(
      parsed.operation_results[0]!.result_manifest_id,
    )).resolves.toEqual(parsed.operation_results[0]);
    await expect(input.registry.resolveDerivedProvenanceClosure(
      parsed.parsed_assets[0]!.receipt.asset_ref.asset_id,
    )).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ operation_kind: "archive_member_extraction" }),
      expect.objectContaining({ operation_kind: "registered_parser" }),
    ]));
  });

  it("rejects a pre-seeded parser output path whose bytes do not match its content hash", async () => {
    const input = await registeredArchive(zipStored([
      { name: "data.csv", content: "id,value\n1,2\n" },
    ]));
    const extraction = await extractRegisteredZipMembers({
      taskId: "task_archive",
      taskRoot: input.root,
      archiveAssetId: input.receipt.asset_ref.asset_id,
      sourceAssetRegistry: input.registry,
    });
    const normalized = Buffer.from("id,value\r\n1,2\r\n");
    const outputSha = createHash("sha256").update(normalized).digest("hex");
    const target = path.join(
      input.root,
      "source_assets",
      "parsed-members",
      extraction.members[0]!.member_sha256,
      `${outputSha}.csv`,
    );
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, "wrong bytes");

    await expect(parseRegisteredArchiveMembers({
      taskId: "task_archive",
      taskRoot: input.root,
      sourceAssetRegistry: input.registry,
      members: extraction.members,
    })).rejects.toThrow(/do not match the parser result/);
  });

  it("rejects a derived asset until its succeeded OperationResult is committed", async () => {
    const input = await registeredArchive(zipStored([{ name: "data.csv", content: "id\n1\n" }]));
    const derivedPath = "source_assets/uncommitted.csv";
    await writeFile(path.join(input.root, ...derivedPath.split("/")), "id\n1\n");
    const uncommitted = await input.registry.registerDerived({
      sourceId: "uncommitted_member",
      relativePath: derivedPath,
      role: "source",
      mediaType: "text/csv",
      parentAssetIds: [input.receipt.asset_ref.asset_id],
      operationKind: "registered_parser",
      operationResultId: "result_uncommitted",
      implementationId: "archive.csv_to_utf8_csv.v1",
      implementationVersion: "1.0.0",
      parametersDigest: "c".repeat(64),
      evidence: { parser_id: "archive.csv_to_utf8_csv.v1" },
    });

    await expect(input.registry.resolveFormalInput(uncommitted.receipt.asset_ref.asset_id))
      .rejects.toThrow(/no committed OperationResult/);
  });

  it("rejects traversal before writing or registering a member", async () => {
    const input = await registeredArchive(zipStored([
      { name: "../escape.csv", content: "bad" },
    ]));
    await expect(extractRegisteredZipMembers({
      taskId: "task_archive",
      taskRoot: input.root,
      archiveAssetId: input.receipt.asset_ref.asset_id,
      sourceAssetRegistry: input.registry,
    })).rejects.toThrow(/unsafe/);
  });
});
