import { randomUUID, createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";

import type {
  RegisteredSourceAssetRole,
  SourceAssetRegistrationReceipt,
} from "@biomed/contracts";

import {
  parseRegisteredSourceAssetRef,
  parseSourceAssetRegistrationReceipt,
} from "../../dataset/contracts/source.js";
import { sha256FileStreamWithSize } from "../../dataset/adapters/hashing.js";
import type { CoreResolvedRegisteredAsset } from "../../dataset/adapters/registered/types.js";
import { readJsonFileOrNull, writeJsonAtomic } from "../../persistence/atomic-json.js";
import { requireSafeId } from "../safe-id.js";

const REGISTRY_FILE = "state/source-asset-registrations.json";
const CORE_ACQUISITION_FILE = "state/core-acquisition-provenance.json";
const DIGEST = /^[0-9a-f]{64}$/;
const PROVIDER_ID = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const ROLES = new Set<RegisteredSourceAssetRole>(["source", "mapping", "metadata", "carrier"]);

type TelemetryEvent = "asset_ref_used" | "legacy_path_compatibility_used";

export interface RegisterSourceAssetInput {
  sourceId: string;
  relativePath: string;
  role?: RegisteredSourceAssetRole;
  mediaType?: string;
}

export interface CoreAcquisitionProvenanceInput {
  readonly provider_id: string;
  readonly implementation_digest: string;
  readonly request_identity_digest: string;
  /** Provider-produced revision facts; null for acquisitions that do not
   * participate in an authoritative dataset identity contract. */
  readonly canonical_accession?: string | null;
  readonly provider_snapshot_identity?: string | null;
  readonly provider_revision_token?: string | null;
}

export interface CoreAcquisitionProvenance extends CoreAcquisitionProvenanceInput {
  readonly schema_version: "1.0";
  readonly task_id: string;
  readonly receipt_id: string;
  readonly asset_id: string;
  readonly role: RegisteredSourceAssetRole;
  readonly canonical_accession: string | null;
  readonly provider_snapshot_identity: string | null;
  readonly provider_revision_token: string | null;
}

export interface CoreResolvedAcquiredAsset extends CoreResolvedRegisteredAsset {
  readonly acquisition_provenance: CoreAcquisitionProvenance;
}

export interface SourceAssetRegistryOptions {
  now?: () => Date;
  onTelemetry?: (event: TelemetryEvent, relativePath: string) => void;
}

function requireSourceAssetPath(value: string): string {
  if (value.trim() !== value || value === "" || path.isAbsolute(value) || path.win32.isAbsolute(value)) {
    throw new TypeError("source asset path must be a relative source_assets path");
  }
  const normalized = value.replaceAll("\\", "/");
  const parts = normalized.split("/");
  if (parts[0] !== "source_assets" || parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new TypeError("source asset path must stay inside source_assets");
  }
  return parts.join("/");
}

function mediaTypeFor(relativePath: string): string {
  const ext = path.posix.extname(relativePath).toLowerCase();
  if (ext === ".csv") return "text/csv";
  if (ext === ".tsv") return "text/tab-separated-values";
  if (ext === ".json") return "application/json";
  if (ext === ".gz") return "application/gzip";
  return "application/octet-stream";
}

function cloneReceipt(receipt: SourceAssetRegistrationReceipt): SourceAssetRegistrationReceipt {
  return JSON.parse(JSON.stringify(receipt)) as SourceAssetRegistrationReceipt;
}

function registrationKey(assetId: string, role: RegisteredSourceAssetRole): string {
  return `${assetId}:${role}`;
}

function provenanceKey(
  assetId: string,
  role: RegisteredSourceAssetRole,
  requestIdentityDigest: string,
): string {
  return `${registrationKey(assetId, role)}:${requestIdentityDigest}`;
}

/** Core-owned, task-scoped source asset registration and resolution seam. */
export class SourceAssetRegistry {
  private readonly root: string;
  private readonly sourceRoot: string;
  private readonly now: () => Date;
  private readonly onTelemetry: ((event: TelemetryEvent, relativePath: string) => void) | null;
  private readonly registrations = new Map<string, SourceAssetRegistrationReceipt>();
  private readonly coreAcquisitions = new Map<string, CoreAcquisitionProvenance>();
  private loaded = false;

  constructor(
    private readonly taskId: string,
    taskRoot: string,
    options: SourceAssetRegistryOptions = {},
  ) {
    requireSafeId(taskId, "taskId");
    this.root = path.resolve(taskRoot);
    this.sourceRoot = path.join(this.root, "source_assets");
    this.now = options.now ?? (() => new Date());
    this.onTelemetry = options.onTelemetry ?? null;
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    const records = await readJsonFileOrNull<unknown>(path.join(this.root, REGISTRY_FILE));
    if (records !== null) {
      if (!Array.isArray(records)) throw new TypeError("source asset registry must be an array");
      for (const value of records) {
        const receipt = parseSourceAssetRegistrationReceipt(value, this.taskId);
        this.registrations.set(
          registrationKey(receipt.asset_ref.asset_id, receipt.asset_ref.role),
          receipt,
        );
      }
    }
    const provenanceRecords = await readJsonFileOrNull<unknown>(path.join(this.root, CORE_ACQUISITION_FILE));
    if (provenanceRecords !== null) {
      if (!Array.isArray(provenanceRecords)) throw new TypeError("Core acquisition provenance must be an array");
      for (const value of provenanceRecords) {
        const provenance = parseCoreAcquisitionProvenance(value, this.taskId);
        const key = provenanceKey(
          provenance.asset_id,
          provenance.role,
          provenance.request_identity_digest,
        );
        const existing = this.coreAcquisitions.get(key);
        if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(provenance)) {
          throw new Error("Core acquisition provenance contains a conflicting duplicate request identity");
        }
        this.coreAcquisitions.set(key, provenance);
      }
    }
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    await writeJsonAtomic(path.join(this.root, REGISTRY_FILE), [...this.registrations.values()]);
  }

  private async persistCoreAcquisitions(): Promise<void> {
    await writeJsonAtomic(path.join(this.root, CORE_ACQUISITION_FILE), [...this.coreAcquisitions.values()]);
  }

  async register(input: RegisterSourceAssetInput): Promise<SourceAssetRegistrationReceipt> {
    await this.load();
    requireSafeId(input.sourceId, "sourceId");
    const relativePath = requireSourceAssetPath(input.relativePath);
    const role = input.role ?? "source";
    if (!ROLES.has(role)) throw new TypeError("source asset role is invalid");
    const candidate = path.resolve(this.root, ...relativePath.split("/"));
    if (!candidate.startsWith(`${this.sourceRoot}${path.sep}`)) {
      throw new TypeError("source asset path escaped source_assets");
    }
    const canonicalRoot = await realpath(this.sourceRoot).catch(() => null);
    const canonicalFile = await realpath(candidate).catch(() => null);
    if (canonicalRoot === null || canonicalFile === null || !canonicalFile.startsWith(`${canonicalRoot}${path.sep}`)) {
      throw new TypeError("source asset path is not a file under source_assets");
    }
    const info = await stat(canonicalFile);
    if (!info.isFile()) throw new TypeError("source asset path is not a file");
    const { sha256, bytes } = await sha256FileStreamWithSize(canonicalFile);
    if (bytes !== info.size) throw new Error("source asset changed while registering");
    const assetId = `asset_${sha256}`;
    const key = registrationKey(assetId, role);
    const existing = this.registrations.get(key);
    if (existing !== undefined) return cloneReceipt(existing);
    const receipt = parseSourceAssetRegistrationReceipt({
      schema_version: "1.0",
      receipt_id: `receipt_${randomUUID()}`,
      task_id: this.taskId,
      asset_ref: { schema_version: "1.0", asset_id: assetId, task_id: this.taskId, role },
      source_id: input.sourceId,
      relative_path: relativePath,
      sha256,
      size_bytes: bytes,
      media_type: input.mediaType ?? mediaTypeFor(relativePath),
      registered_at: this.now().toISOString(),
      path_compatibility: {
        schema_version: "1.0",
        mode: "asset_id",
        legacy_path: null,
        telemetry_event: "asset_ref_used",
      },
    }, this.taskId);
    this.registrations.set(key, receipt);
    await this.persist();
    return cloneReceipt(receipt);
  }

  recordLegacyPathCompatibilityUse(relativePath: string): void {
    this.onTelemetry?.(
      "legacy_path_compatibility_used",
      requireSourceAssetPath(relativePath),
    );
  }

  async resolve(assetId: string): Promise<CoreResolvedRegisteredAsset> {
    return this.resolveWithRole(assetId, "source");
  }

  async resolveCarrier(assetId: string): Promise<CoreResolvedRegisteredAsset> {
    return this.resolveWithRole(assetId, "carrier");
  }

  async resolveRole(
    assetId: string,
    role: RegisteredSourceAssetRole,
  ): Promise<CoreResolvedRegisteredAsset> {
    return this.resolveWithRole(assetId, role);
  }

  async verifyRegistrationReceipt(
    value: SourceAssetRegistrationReceipt,
  ): Promise<SourceAssetRegistrationReceipt> {
    await this.load();
    const receipt = parseSourceAssetRegistrationReceipt(value, this.taskId);
    const registered = this.registrations.get(registrationKey(
      receipt.asset_ref.asset_id,
      receipt.asset_ref.role,
    ));
    if (registered === undefined) {
      throw new Error("provider revision evidence references an unregistered asset receipt");
    }
    if (JSON.stringify(registered) !== JSON.stringify(receipt)) {
      throw new Error("provider revision evidence does not match the task-owned asset receipt");
    }
    const file = await this.checkedFile(registered);
    for await (const chunk of this.verifiedStream(file, registered)) void chunk;
    return cloneReceipt(registered);
  }

  async registerCoreAcquisitionProvenance(
    receiptValue: SourceAssetRegistrationReceipt,
    input: CoreAcquisitionProvenanceInput,
  ): Promise<CoreAcquisitionProvenance> {
    await this.load();
    const receipt = parseSourceAssetRegistrationReceipt(receiptValue, this.taskId);
    const key = registrationKey(receipt.asset_ref.asset_id, receipt.asset_ref.role);
    const registered = this.registrations.get(key);
    if (registered === undefined || JSON.stringify(registered) !== JSON.stringify(receipt)) {
      throw new Error("Core acquisition provenance requires the exact task-owned registration receipt");
    }
    const provenance = parseCoreAcquisitionProvenance({
      schema_version: "1.0",
      task_id: this.taskId,
      receipt_id: receipt.receipt_id,
      asset_id: receipt.asset_ref.asset_id,
      role: receipt.asset_ref.role,
      ...input,
      canonical_accession: input.canonical_accession ?? null,
      provider_snapshot_identity: input.provider_snapshot_identity ?? null,
      provider_revision_token: input.provider_revision_token ?? null,
    }, this.taskId);
    const acquisitionKey = provenanceKey(
      receipt.asset_ref.asset_id,
      receipt.asset_ref.role,
      provenance.request_identity_digest,
    );
    const existing = this.coreAcquisitions.get(acquisitionKey);
    if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(provenance)) {
      throw new Error("registered asset has conflicting provenance for the same request identity");
    }
    this.coreAcquisitions.set(acquisitionKey, provenance);
    await this.persistCoreAcquisitions();
    return structuredClone(provenance);
  }

  async resolveCoreAcquired(
    assetId: string,
    requestIdentityDigest?: string,
    role?: RegisteredSourceAssetRole,
  ): Promise<CoreResolvedAcquiredAsset> {
    await this.load();
    const receipt = role === undefined
      ? this.registrations.get(registrationKey(assetId, "carrier")) ??
        this.registrations.get(registrationKey(assetId, "source"))
      : this.registrations.get(registrationKey(assetId, role));
    if (receipt === undefined) throw new Error("registered asset was not found");
    if (requestIdentityDigest !== undefined && !DIGEST.test(requestIdentityDigest)) {
      throw new TypeError("Core acquisition request identity digest is invalid");
    }
    const matches = [...this.coreAcquisitions.values()].filter((value) =>
      value.asset_id === assetId
      && value.role === receipt.asset_ref.role
      && (requestIdentityDigest === undefined || value.request_identity_digest === requestIdentityDigest),
    );
    if (matches.length > 1) {
      throw new Error("formal dynamic carrier has ambiguous Core acquisition provenance");
    }
    const provenance = matches[0];
    if (
      provenance === undefined
      || provenance.task_id !== receipt.task_id
      || provenance.receipt_id !== receipt.receipt_id
      || provenance.asset_id !== receipt.asset_ref.asset_id
      || provenance.role !== receipt.asset_ref.role
    ) {
      throw new Error("formal dynamic carrier lacks exact Core acquisition provenance");
    }
    const file = await this.checkedFile(receipt);
    return {
      registration_receipt: cloneReceipt(receipt),
      content: this.verifiedStream(file, receipt),
      acquisition_provenance: structuredClone(provenance),
    };
  }

  async resolveAny(assetId: string): Promise<CoreResolvedRegisteredAsset> {
    await this.load();
    const receipt = this.registrations.get(registrationKey(assetId, "carrier")) ??
      this.registrations.get(registrationKey(assetId, "source"));
    if (receipt === undefined) throw new Error("registered asset was not found");
    this.onTelemetry?.("asset_ref_used", receipt.relative_path);
    const file = await this.checkedFile(receipt);
    return { registration_receipt: cloneReceipt(receipt), content: this.verifiedStream(file, receipt) };
  }

  private async resolveWithRole(
    assetId: string,
    role: RegisteredSourceAssetRole,
  ): Promise<CoreResolvedRegisteredAsset> {
    await this.load();
    const ref = parseRegisteredSourceAssetRef({
      schema_version: "1.0",
      asset_id: assetId,
      task_id: this.taskId,
      role,
    }, this.taskId);
    const receipt = this.registrations.get(registrationKey(ref.asset_id, role));
    if (receipt === undefined) throw new Error(`registered ${role} asset was not found`);
    if (receipt.asset_ref.role !== role) throw new Error(`registered asset role is not ${role}`);
    this.onTelemetry?.("asset_ref_used", receipt.relative_path);
    const file = await this.checkedFile(receipt);
    return { registration_receipt: cloneReceipt(receipt), content: this.verifiedStream(file, receipt) };
  }

  private async checkedFile(receipt: SourceAssetRegistrationReceipt): Promise<string> {
    const relativePath = requireSourceAssetPath(receipt.relative_path);
    const candidate = path.resolve(this.root, ...relativePath.split("/"));
    const canonicalRoot = await realpath(this.sourceRoot).catch(() => null);
    const canonicalFile = await realpath(candidate).catch(() => null);
    if (canonicalRoot === null || canonicalFile === null || !canonicalFile.startsWith(`${canonicalRoot}${path.sep}`)) {
      throw new Error("registered source asset path is outside its task source_assets");
    }
    const info = await stat(canonicalFile);
    if (!info.isFile()) throw new Error("registered source asset is not a file");
    if (info.size !== receipt.size_bytes) throw new Error("registered asset size drift detected");
    return canonicalFile;
  }

  private async *verifiedStream(
    file: string,
    receipt: SourceAssetRegistrationReceipt,
  ): AsyncGenerator<Uint8Array> {
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of createReadStream(file)) {
      const buffer = chunk as Buffer;
      hash.update(buffer);
      bytes += buffer.length;
      yield buffer;
    }
    if (bytes !== receipt.size_bytes) throw new Error("registered asset size drift detected");
    if (hash.digest("hex") !== receipt.sha256) throw new Error("registered asset hash drift detected");
  }
}

function parseCoreAcquisitionProvenance(value: unknown, taskId: string): CoreAcquisitionProvenance {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Core acquisition provenance must be an object");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const legacyExpected = [
    "asset_id", "implementation_digest", "provider_id", "receipt_id",
    "request_identity_digest", "role", "schema_version", "task_id",
  ].sort();
  const expected = [
    ...legacyExpected,
    "canonical_accession", "provider_revision_token", "provider_snapshot_identity",
  ].sort();
  const legacy = keys.length === legacyExpected.length && keys.every((key, index) => key === legacyExpected[index]);
  const current = keys.length === expected.length && keys.every((key, index) => key === expected[index]);
  if (!legacy && !current) {
    throw new TypeError("Core acquisition provenance has unknown or missing fields");
  }
  if (
    record.schema_version !== "1.0"
    || record.task_id !== taskId
    || typeof record.receipt_id !== "string"
    || !/^receipt_[0-9a-f-]{36}$/.test(record.receipt_id)
    || typeof record.asset_id !== "string"
    || !/^asset_[0-9a-f]{64}$/.test(record.asset_id)
    || typeof record.role !== "string"
    || !ROLES.has(record.role as RegisteredSourceAssetRole)
    || typeof record.provider_id !== "string"
    || !PROVIDER_ID.test(record.provider_id)
    || typeof record.implementation_digest !== "string"
    || !DIGEST.test(record.implementation_digest)
    || typeof record.request_identity_digest !== "string"
    || !DIGEST.test(record.request_identity_digest)
  ) throw new TypeError("Core acquisition provenance is invalid");
  const optionalText = (name: string): string | null => {
    const item = record[name];
    if (item === null || item === undefined) return null;
    if (typeof item !== "string" || item.trim() === "") {
      throw new TypeError(`Core acquisition provenance ${name} is invalid`);
    }
    return item;
  };
  return structuredClone({
    ...record,
    canonical_accession: optionalText("canonical_accession"),
    provider_snapshot_identity: optionalText("provider_snapshot_identity"),
    provider_revision_token: optionalText("provider_revision_token"),
  }) as unknown as CoreAcquisitionProvenance;
}

export type { TelemetryEvent };
