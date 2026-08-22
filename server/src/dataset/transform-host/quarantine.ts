import { randomBytes } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { lstat, open, rename, rm } from "node:fs/promises";
import path from "node:path";

import {
  assertCoreAuthoritativeContext,
  assertCoreAuthorityClaim,
  type CoreAuthoritativeTransformContext,
  type CoreAuthorityClaim,
} from "./authority.js";
import { TransformHostError } from "./errors.js";
import {
  assertDirectoryIdentity,
  assertPortablePathSegment,
  ensureSecureDirectory,
  identityOf,
  inspectSecureFileUnderRoot,
  sameIdentity,
  type FileSystemIdentity,
} from "./filesystem.js";
import { sha256Bytes, sha256FileHandle } from "./hashing.js";

const MAX_SNAPSHOT_BYTES = 128 * 1024 * 1024;

export interface RegisteredInput {
  receiptKind: "asset" | "result";
  receiptId: string;
  relativePath: string;
}

export interface InputHandleReceipt {
  handle: string;
  receiptKind: "asset" | "result";
  receiptId: string;
  sha256: string;
  sizeBytes: number;
  generation: number;
}

export interface QuarantineOutputHandle {
  handle: string;
  generation: number;
}

export interface InvocationQuarantineOptions {
  quarantineRoot: string;
  registeredInputRoot: string;
  authorityContext: CoreAuthoritativeTransformContext;
}

interface HeldSnapshot {
  readonly file: FileHandle;
  readonly identity: FileSystemIdentity;
  readonly receipt: InputHandleReceipt;
}

/**
 * Disabled-Host quarantine. Every input is copied to a private snapshot while
 * its source FD is open, re-hashed from the destination FD, and thereafter
 * addressed only by an opaque task/generation-bound handle. No replaceable
 * source or snapshot path is exposed or reopened.
 */
export class InvocationQuarantine {
  readonly #context: CoreAuthoritativeTransformContext;
  readonly #quarantineRoot: string;
  readonly #registeredInputRoot: string;
  readonly #invocationRoot: string;
  readonly #snapshotRoot: string;
  readonly #outputRoot: string;
  readonly #snapshots = new Map<string, HeldSnapshot>();
  readonly #outputNames = new Set<string>();
  #quarantineRootIdentity: FileSystemIdentity | undefined;
  #registeredInputRootIdentity: FileSystemIdentity | undefined;
  #snapshotRootIdentity: FileSystemIdentity | undefined;
  #outputRootIdentity: FileSystemIdentity | undefined;

  constructor(options: InvocationQuarantineOptions) {
    assertCoreAuthoritativeContext(options.authorityContext);
    this.#context = options.authorityContext;
    this.#quarantineRoot = path.resolve(options.quarantineRoot);
    this.#registeredInputRoot = path.resolve(options.registeredInputRoot);
    const taskScope = `task_${sha256Bytes(this.#context.taskId).slice(0, 32)}`;
    const invocationScope = `inv_${sha256Bytes(this.#context.invocationId).slice(0, 32)}`;
    this.#invocationRoot = path.join(
      this.#quarantineRoot,
      taskScope,
      `generation_${this.#context.generation}`,
      invocationScope,
    );
    this.#snapshotRoot = path.join(this.#invocationRoot, "snapshots");
    this.#outputRoot = path.join(this.#invocationRoot, "output");
  }

  async initialize(): Promise<void> {
    this.#quarantineRootIdentity = await ensureSecureDirectory(this.#quarantineRoot);
    this.#registeredInputRootIdentity = await ensureSecureDirectory(this.#registeredInputRoot);
    await ensureSecureDirectory(this.#invocationRoot);
    this.#snapshotRootIdentity = await ensureSecureDirectory(this.#snapshotRoot);
    this.#outputRootIdentity = await ensureSecureDirectory(this.#outputRoot);
    await this.#assertRootsUnchanged();
  }

  async registerInput(
    claim: CoreAuthorityClaim,
    input: RegisteredInput,
  ): Promise<InputHandleReceipt> {
    assertCoreAuthorityClaim(this.#context, claim);
    await this.#assertRootsUnchanged();
    const expected = this.#findAuthorizedReceipt(input.receiptKind, input.receiptId);
    const inspected = await inspectSecureFileUnderRoot(this.#registeredInputRoot, input.relativePath);
    if (inspected.metadata.size > MAX_SNAPSHOT_BYTES) {
      throw violation(`Registered input exceeds the ${MAX_SNAPSHOT_BYTES}-byte fixture limit`);
    }
    if (input.receiptKind === "asset" && inspected.metadata.size !== expected.sizeBytes) {
      throw violation("Registered input size does not match the Core-authoritative asset receipt");
    }

    const source = await open(inspected.absolutePath, "r");
    let destination: FileHandle | undefined;
    let destinationPath: string | undefined;
    let renamed = false;
    try {
      const opened = await source.stat();
      if (
        !opened.isFile()
        || opened.nlink > 1
        || !sameIdentity(identityOf(opened), identityOf(inspected.metadata))
      ) {
        throw violation("Registered input identity changed while opening or is hardlinked");
      }
      const sourceDigest = await sha256FileHandle(source);
      if (sourceDigest !== expected.sha256) {
        throw violation("Registered input bytes do not match the Core-authoritative receipt");
      }

      const nonce = randomBytes(16).toString("hex");
      const incomingName = `incoming_${nonce}.bin`;
      destinationPath = path.join(this.#snapshotRoot, incomingName);
      destination = await open(destinationPath, "wx+", 0o600);
      await copyOpenFile(source, destination, opened.size);
      await destination.sync();
      const destinationDigest = await sha256FileHandle(destination);
      if (destinationDigest !== expected.sha256) {
        throw violation("Host-owned snapshot digest changed during copy");
      }

      const openedAfterCopy = await source.stat();
      const pathAfterCopy = await lstat(inspected.absolutePath);
      if (
        openedAfterCopy.nlink > 1
        || pathAfterCopy.nlink > 1
        || !sameIdentity(identityOf(opened), identityOf(openedAfterCopy))
        || !sameIdentity(identityOf(opened), identityOf(pathAfterCopy))
        || openedAfterCopy.size !== opened.size
      ) {
        throw violation("Registered input or its path changed during snapshot creation");
      }
      await this.#assertRootsUnchanged();

      const finalName = `snapshot_${expected.sha256}_${nonce}.bin`;
      const finalPath = path.join(this.#snapshotRoot, finalName);
      await destination.chmod(0o400);
      await rename(destinationPath, finalPath);
      destinationPath = finalPath;
      renamed = true;
      const held = await destination.stat();
      const visible = await lstat(finalPath);
      if (
        held.nlink !== 1
        || visible.nlink !== 1
        || !sameIdentity(identityOf(held), identityOf(visible))
        || (await sha256FileHandle(destination)) !== expected.sha256
      ) {
        throw violation("Host-owned snapshot identity is not immutable and byte-verified");
      }
      await this.#assertRootsUnchanged();

      const handle = `in_${randomBytes(18).toString("base64url")}`;
      const receipt = Object.freeze({
        handle,
        receiptKind: input.receiptKind,
        receiptId: input.receiptId,
        sha256: expected.sha256,
        sizeBytes: held.size,
        generation: this.#context.generation,
      });
      this.#snapshots.set(handle, {
        file: destination,
        identity: identityOf(held),
        receipt,
      });
      destination = undefined;
      return receipt;
    } finally {
      await source.close();
      if (destination) await destination.close();
      if (destinationPath && (!renamed || destination)) {
        await rm(destinationPath, { force: true });
      }
    }
  }

  declareOutput(claim: CoreAuthorityClaim, name: string): QuarantineOutputHandle {
    assertCoreAuthorityClaim(this.#context, claim);
    this.#requireInitialized();
    assertPortablePathSegment(name, "output name");
    const folded = name.toLocaleLowerCase("en-US");
    if (this.#outputNames.has(folded)) {
      throw violation("Output names must not duplicate or collide by case");
    }
    this.#outputNames.add(folded);
    return Object.freeze({
      handle: `out_${randomBytes(18).toString("base64url")}`,
      generation: this.#context.generation,
    });
  }

  async verifyInputSnapshot(
    claim: CoreAuthorityClaim,
    receipt: InputHandleReceipt,
  ): Promise<void> {
    assertCoreAuthorityClaim(this.#context, claim);
    await this.#assertRootsUnchanged();
    const snapshot = this.#snapshots.get(receipt.handle);
    if (
      !snapshot
      || snapshot.receipt !== receipt
      || receipt.generation !== this.#context.generation
    ) {
      throw violation("Unknown, replaced, or wrong-generation opaque input handle");
    }
    const current = await snapshot.file.stat();
    if (
      current.nlink !== 1
      || !sameIdentity(identityOf(current), snapshot.identity)
      || current.size !== receipt.sizeBytes
      || (await sha256FileHandle(snapshot.file)) !== receipt.sha256
    ) {
      throw violation(`Input snapshot ${receipt.handle} changed after verification`);
    }
  }

  async dispose(): Promise<void> {
    const snapshots = [...this.#snapshots.values()];
    this.#snapshots.clear();
    await Promise.all(snapshots.map(({ file }) => file.close()));
  }

  #findAuthorizedReceipt(
    kind: "asset" | "result",
    id: string,
  ): { sha256: string; sizeBytes: number | undefined } {
    if (kind === "asset") {
      const receipt = this.#context.inputAssetReceipts.find((entry) => entry.asset_id === id);
      if (!receipt) throw violation("Input is absent from the Core-authoritative asset receipt closure");
      return { sha256: receipt.sha256, sizeBytes: receipt.size_bytes };
    }
    const receipt = this.#context.inputResultReceipts.find(
      (entry) => entry.result_manifest_id === id,
    );
    if (!receipt) throw violation("Input is absent from the Core-authoritative result receipt closure");
    return { sha256: receipt.sha256, sizeBytes: undefined };
  }

  async #assertRootsUnchanged(): Promise<void> {
    const quarantine = this.#quarantineRootIdentity;
    const registered = this.#registeredInputRootIdentity;
    const snapshots = this.#snapshotRootIdentity;
    const output = this.#outputRootIdentity;
    if (!quarantine || !registered || !snapshots || !output) {
      throw violation("Invocation quarantine is not initialized");
    }
    await assertDirectoryIdentity(this.#quarantineRoot, quarantine);
    await assertDirectoryIdentity(this.#registeredInputRoot, registered);
    await assertDirectoryIdentity(this.#snapshotRoot, snapshots);
    await assertDirectoryIdentity(this.#outputRoot, output);
  }

  #requireInitialized(): void {
    if (!this.#outputRootIdentity) throw violation("Invocation quarantine is not initialized");
  }
}

async function copyOpenFile(source: FileHandle, destination: FileHandle, expectedSize: number): Promise<void> {
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  while (position < expectedSize) {
    const requested = Math.min(buffer.byteLength, expectedSize - position);
    const { bytesRead } = await source.read(buffer, 0, requested, position);
    if (bytesRead === 0) throw violation("Registered input was truncated during snapshot creation");
    let written = 0;
    while (written < bytesRead) {
      const result = await destination.write(buffer, written, bytesRead - written, position + written);
      written += result.bytesWritten;
    }
    position += bytesRead;
  }
  const extra = Buffer.allocUnsafe(1);
  if ((await source.read(extra, 0, 1, position)).bytesRead !== 0) {
    throw violation("Registered input grew during snapshot creation");
  }
}

function violation(message: string): TransformHostError {
  return new TransformHostError("quarantine_violation", message);
}
