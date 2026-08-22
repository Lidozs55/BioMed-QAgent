import { randomBytes } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { lstat, open, rename, rm } from "node:fs/promises";
import path from "node:path";

import {
  copyHostCompiledFixtureBytes,
  type FixtureOnlyCompilationResult,
} from "./admission.js";
import {
  assertCoreAuthoritativeContext,
  assertCoreAuthorityClaim,
  type CoreAuthoritativeTransformContext,
  type CoreAuthorityClaim,
} from "./authority.js";
import { TransformHostError } from "./errors.js";
import {
  assertDirectoryIdentity,
  ensureSecureDirectory,
  identityOf,
  sameIdentity,
  type FileSystemIdentity,
} from "./filesystem.js";
import { sha256FileHandle } from "./hashing.js";

export interface StoredTransformBundle {
  handle: string;
  sha256: string;
  sizeBytes: number;
  implementationDigest: string;
  generation: number;
  executable: false;
  status: "fixture_only_unexecutable";
}

interface HeldBundle {
  readonly file: FileHandle;
  readonly identity: FileSystemIdentity;
  readonly receipt: StoredTransformBundle;
}

export interface TransformBundleStoreOptions {
  root: string;
  authorityContext: CoreAuthoritativeTransformContext;
}

/**
 * Host-owned fixture store. A bundle is accepted only from the in-process
 * compilation capability, atomically moved beneath its digest directory,
 * re-hashed through the retained FD, and exposed only as an opaque handle.
 */
export class TransformBundleStore {
  readonly #root: string;
  readonly #context: CoreAuthoritativeTransformContext;
  readonly #bundles = new Map<string, HeldBundle>();
  #rootIdentity: FileSystemIdentity | undefined;

  constructor(options: TransformBundleStoreOptions) {
    assertCoreAuthoritativeContext(options.authorityContext);
    this.#root = path.resolve(options.root);
    this.#context = options.authorityContext;
  }

  async initialize(): Promise<void> {
    this.#rootIdentity = await ensureSecureDirectory(this.#root);
  }

  async put(
    claim: CoreAuthorityClaim,
    compiled: FixtureOnlyCompilationResult,
  ): Promise<StoredTransformBundle> {
    assertCoreAuthorityClaim(this.#context, claim);
    await this.#assertRootUnchanged();
    this.#assertCompiledClosure(compiled);
    const bundleBytes = copyHostCompiledFixtureBytes(compiled);
    const digestDirectory = path.join(this.#root, `sha256_${compiled.bundleDigest}`);
    const digestDirectoryIdentity = await ensureSecureDirectory(digestDirectory);
    await this.#assertRootUnchanged();

    const nonce = randomBytes(16).toString("hex");
    let file: FileHandle | undefined;
    let filePath = path.join(digestDirectory, `incoming_${nonce}.fixture`);
    let renamed = false;
    try {
      file = await open(filePath, "wx+", 0o600);
      await writeAll(file, bundleBytes);
      await file.sync();
      if ((await sha256FileHandle(file)) !== compiled.bundleDigest) {
        throw conflict("Host-owned bundle digest changed during storage");
      }
      const finalPath = path.join(digestDirectory, `bundle_${nonce}.fixture`);
      await file.chmod(0o400);
      await assertDirectoryIdentity(digestDirectory, digestDirectoryIdentity);
      await this.#assertRootUnchanged();
      await rename(filePath, finalPath);
      filePath = finalPath;
      renamed = true;

      const held = await file.stat();
      const visible = await lstat(finalPath);
      if (
        held.nlink !== 1
        || visible.nlink !== 1
        || !sameIdentity(identityOf(held), identityOf(visible))
        || held.size !== bundleBytes.byteLength
        || (await sha256FileHandle(file)) !== compiled.bundleDigest
      ) {
        throw conflict("Host-owned bundle snapshot is not immutable and byte-verified");
      }
      await assertDirectoryIdentity(digestDirectory, digestDirectoryIdentity);
      await this.#assertRootUnchanged();

      const handle = `bundle_${randomBytes(18).toString("base64url")}`;
      const receipt: StoredTransformBundle = Object.freeze({
        handle,
        sha256: compiled.bundleDigest,
        sizeBytes: held.size,
        implementationDigest: compiled.implementationDigest,
        generation: this.#context.generation,
        executable: false,
        status: "fixture_only_unexecutable",
      });
      this.#bundles.set(handle, {
        file,
        identity: identityOf(held),
        receipt,
      });
      file = undefined;
      return receipt;
    } finally {
      if (file) await file.close();
      if (!renamed) await rm(filePath, { force: true });
    }
  }

  async verify(
    claim: CoreAuthorityClaim,
    receipt: StoredTransformBundle,
  ): Promise<void> {
    assertCoreAuthorityClaim(this.#context, claim);
    await this.#assertRootUnchanged();
    const held = this.#bundles.get(receipt.handle);
    if (!held || held.receipt !== receipt || receipt.generation !== this.#context.generation) {
      throw conflict("Unknown, replaced, or wrong-generation opaque bundle handle");
    }
    const current = await held.file.stat();
    if (
      current.nlink !== 1
      || !sameIdentity(identityOf(current), held.identity)
      || current.size !== receipt.sizeBytes
      || (await sha256FileHandle(held.file)) !== receipt.sha256
    ) {
      throw conflict("Host-owned bundle snapshot changed after verification");
    }
  }

  async dispose(): Promise<void> {
    const bundles = [...this.#bundles.values()];
    this.#bundles.clear();
    await Promise.all(bundles.map(({ file }) => file.close()));
  }

  #assertCompiledClosure(compiled: FixtureOnlyCompilationResult): void {
    if (
      compiled.status !== "fixture_only_unexecutable"
      || compiled.executable !== false
      || compiled.trustBearingAdmission !== false
      || compiled.bundleDigest !== this.#context.bundleDigest
      || compiled.compilerDigest !== this.#context.compilerDigest
      || compiled.policyDigest !== this.#context.policyDigest
      || compiled.implementationDigest !== this.#context.implementationDigest
    ) {
      throw conflict("Fixture compilation does not match the Core-authoritative digest closure");
    }
  }

  async #assertRootUnchanged(): Promise<void> {
    if (!this.#rootIdentity) throw conflict("Transform bundle store is not initialized");
    await assertDirectoryIdentity(this.#root, this.#rootIdentity);
  }
}

async function writeAll(file: FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await file.write(bytes, offset, bytes.byteLength - offset, offset);
    offset += bytesWritten;
  }
}

function conflict(message: string): TransformHostError {
  return new TransformHostError("bundle_conflict", message);
}
