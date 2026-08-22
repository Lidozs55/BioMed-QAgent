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
const ROLES = new Set<RegisteredSourceAssetRole>(["source", "mapping", "metadata", "carrier"]);

type TelemetryEvent = "asset_ref_used" | "legacy_path_compatibility_used";

export interface RegisterSourceAssetInput {
  sourceId: string;
  relativePath: string;
  role?: RegisteredSourceAssetRole;
  mediaType?: string;
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

/** Core-owned, task-scoped source asset registration and resolution seam. */
export class SourceAssetRegistry {
  private readonly root: string;
  private readonly sourceRoot: string;
  private readonly now: () => Date;
  private readonly onTelemetry: ((event: TelemetryEvent, relativePath: string) => void) | null;
  private readonly registrations = new Map<string, SourceAssetRegistrationReceipt>();
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
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    await writeJsonAtomic(path.join(this.root, REGISTRY_FILE), [...this.registrations.values()]);
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

export type { TelemetryEvent };