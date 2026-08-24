import { createHash } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";

import type {
  CoreAcquisitionRequest,
  CoreDownloadAttempt,
  JsonValue,
  ProviderRevisionEvidenceV1,
  RegisteredSourceAssetRef,
  WorkflowRecipeRef,
} from "@biomed/contracts";

import {
  parseCoreAcquisitionRequest,
  parseCoreDownloadAttempt,
  parseWorkflowRecipeRef,
} from "../contracts/acquisition.js";
import { parseProviderRevisionEvidenceV1 } from "../contracts/provider-revision-evidence.js";
import type { DataLevel } from "../contracts/enums.js";
import type { SourceRecord } from "../contracts/source.js";
import {
  acquireSource,
  type AcquireSourceOptions,
} from "../../external/acquisition/downloader.js";
import { ContentCache } from "../../external/acquisition/content-cache.js";
import type { PublicHttpClient } from "../../external/network/http-client.js";
import { readJsonFileOrNull, writeJsonAtomic } from "../../persistence/atomic-json.js";
import { SourceAssetRegistry } from "../../runtime/source-assets/registry.js";

const ATTEMPTS_FILE = "state/core-acquisition-attempts.json";
const FORBIDDEN_PARAMETER_KEY = /(?:^|_)(?:code|command|path|filename|script)(?:$|_)/i;
const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export interface AcquisitionExtractionAsset {
  sourceId: string;
  relativePath: string;
  role: "source" | "mapping" | "metadata" | "carrier";
  mediaType?: string;
}

export interface AcquisitionDownloadPlan {
  source: SourceRecord;
  filename: string;
  dataLevel: DataLevel;
  maxBytes: number;
  expectedSize?: number;
  expectedSha256?: string;
  expectedMd5?: string;
  expectedMediaTypes?: ReadonlySet<string>;
  accept?: string;
  requestHeaders?: Readonly<Record<string, string>>;
  allowedHosts?: ReadonlySet<string>;
  /** Trusted provider-selected registry role; never populated by request parameters. */
  assetRole?: "source" | "carrier";
  /** Trusted provider-produced extraction outputs; never populated by request parameters. */
  extractionAssets?: readonly AcquisitionExtractionAsset[];
  /**
   * Trusted provider-produced revision facts.  These facts are attached to
   * the exact registration receipt by CoreAcquisitionRuntime; request
   * parameters and tool inputs never populate this field.
   */
  providerRevisionFacts?: AcquisitionProviderRevisionFacts;
}

export interface AcquisitionProviderRevisionFacts {
  readonly canonical_accession: string;
  readonly provider_snapshot_identity: string;
  readonly provider_revision_token: string | null;
}

export interface AcquisitionProviderHandler {
  readonly providerId: string;
  readonly implementationDigest: string;
  plan(request: CoreAcquisitionRequest): AcquisitionDownloadPlan | Promise<AcquisitionDownloadPlan>;
}

export interface AcquisitionRecipeRegistration {
  ref: WorkflowRecipeRef;
  providerId: string;
}

export class CoreAcquisitionRegistry {
  readonly #providers = new Map<string, AcquisitionProviderHandler>();
  readonly #recipes = new Map<string, AcquisitionRecipeRegistration>();

  registerProvider(handler: AcquisitionProviderHandler): void {
    if (!PROVIDER_ID.test(handler.providerId) || handler.providerId.includes("..")) throw new TypeError("provider_id is invalid");
    if (!/^[0-9a-f]{64}$/.test(handler.implementationDigest)) throw new TypeError("provider implementation_digest is invalid");
    if (this.#providers.has(handler.providerId)) throw new Error(`acquisition provider '${handler.providerId}' is already registered`);
    this.#providers.set(handler.providerId, Object.freeze(handler));
  }

  registerRecipe(registration: AcquisitionRecipeRegistration): void {
    const ref = parseWorkflowRecipeRef(registration.ref);
    if (ref.status !== "PROMOTED") throw new TypeError("only PROMOTED acquisition recipes may be registered");
    if (!this.#providers.has(registration.providerId)) throw new Error(`acquisition provider '${registration.providerId}' is not registered`);
    const key = `${ref.recipe_id}@${ref.recipe_version}`;
    if (this.#recipes.has(key)) throw new Error(`acquisition recipe '${key}' is already registered`);
    this.#recipes.set(key, Object.freeze({ ref: Object.freeze(ref), providerId: registration.providerId }));
  }

  resolve(rawRequest: CoreAcquisitionRequest, taskId: string): {
    request: CoreAcquisitionRequest;
    handler: AcquisitionProviderHandler;
    recipe: WorkflowRecipeRef | null;
  } {
    const preliminary = parseCoreAcquisitionRequest(rawRequest, taskId);
    rejectAgentControlledParameters(preliminary.parameters);
    if (preliminary.mode === "builtin") {
      const handler = this.#providers.get(preliminary.provider_id!);
      if (handler === undefined) throw new Error(`acquisition provider '${preliminary.provider_id}' is not registered`);
      return { request: preliminary, handler, recipe: null };
    }
    const recipe = this.#recipes.get(`${preliminary.recipe_id}@${preliminary.recipe_version}`);
    if (recipe === undefined) throw new Error("acquisition recipe is not registered as PROMOTED");
    const request = parseCoreAcquisitionRequest(rawRequest, taskId, recipe.ref);
    const handler = this.#providers.get(recipe.providerId)!;
    if (handler.implementationDigest !== recipe.ref.implementation_digest) {
      throw new Error("acquisition recipe implementation digest drifted from its provider");
    }
    return { request, handler, recipe: recipe.ref };
  }
}

export interface CoreAcquisitionResult {
  requestIdentityDigest: string;
  attempts: CoreDownloadAttempt[];
  sourceAsset: RegisteredSourceAssetRef;
  extractionAssets: RegisteredSourceAssetRef[];
  /** Core-created evidence, each item bound to a registered asset receipt. */
  providerRevisionEvidence?: readonly ProviderRevisionEvidenceV1[];
}

export class CoreAcquisitionError extends Error {
  readonly retryable: boolean;
  readonly details: { provider_id: string; error_code: string | null; attempts: number };

  constructor(
    message: string,
    details: { provider_id: string; error_code: string | null; attempts: number },
    retryable: boolean,
  ) {
    super(message);
    this.name = "CoreAcquisitionError";
    this.retryable = retryable;
    this.details = details;
  }
}

function trustedProviderRevisionFacts(
  value: AcquisitionProviderRevisionFacts | undefined,
): AcquisitionProviderRevisionFacts | null {
  if (value === undefined) return null;
  if (
    typeof value.canonical_accession !== "string" || value.canonical_accession.trim() === ""
    || typeof value.provider_snapshot_identity !== "string" || value.provider_snapshot_identity.trim() === ""
    || (value.provider_revision_token !== null && typeof value.provider_revision_token !== "string")
  ) {
    throw new TypeError("registered acquisition provider revision facts are invalid");
  }
  return Object.freeze({
    canonical_accession: value.canonical_accession.normalize("NFC").trim(),
    provider_snapshot_identity: value.provider_snapshot_identity.normalize("NFC").trim(),
    provider_revision_token: value.provider_revision_token === null
      ? null
      : value.provider_revision_token.normalize("NFC").trim(),
  });
}

function evidenceForReceipt(
  facts: AcquisitionProviderRevisionFacts,
  receipt: import("@biomed/contracts").SourceAssetRegistrationReceipt,
): ProviderRevisionEvidenceV1 {
  return parseProviderRevisionEvidenceV1({
    schema_version: "1.0",
    canonical_accession: facts.canonical_accession,
    provider_snapshot_identity: facts.provider_snapshot_identity,
    provider_revision_token: facts.provider_revision_token,
    source_asset_registration_receipt: receipt,
  });
}

export interface CoreAcquisitionRuntimeOptions {
  taskId: string;
  taskRoot: string;
  cache: ContentCache;
  client: PublicHttpClient;
  sourceAssetRegistry: SourceAssetRegistry;
  registry: CoreAcquisitionRegistry;
  maxAttempts?: number;
  /** Global cache registrar (raw downloads → data/cache). */
  registrar?: import("../../persistence/cache-registrar.js").CacheRegistrar | null;
}

export class CoreAcquisitionRuntime {
  readonly #taskId: string;
  readonly #taskRoot: string;
  readonly #cache: ContentCache;
  readonly #client: PublicHttpClient;
  readonly #assets: SourceAssetRegistry;
  readonly #registry: CoreAcquisitionRegistry;
  readonly #maxAttempts: number;
  readonly #registrar: import("../../persistence/cache-registrar.js").CacheRegistrar | null;

  constructor(options: CoreAcquisitionRuntimeOptions) {
    this.#taskId = options.taskId;
    this.#taskRoot = path.resolve(options.taskRoot);
    this.#cache = options.cache;
    this.#client = options.client;
    this.#assets = options.sourceAssetRegistry;
    this.#registry = options.registry;
    this.#maxAttempts = options.maxAttempts ?? 3;
    this.#registrar = options.registrar ?? null;
  }

  async acquire(rawRequest: CoreAcquisitionRequest, signal?: AbortSignal): Promise<CoreAcquisitionResult> {
    const { request, handler, recipe } = this.#registry.resolve(rawRequest, this.#taskId);
    const implementationDigest = recipe?.implementation_digest ?? handler.implementationDigest;
    const requestIdentityDigest = acquisitionRequestIdentity(request, implementationDigest);
    const plan = await handler.plan(request);
    const providerRevisionFacts = trustedProviderRevisionFacts(plan.providerRevisionFacts);
    const partRelativePath = `source_assets/.acquisition/${requestIdentityDigest}.part`;
    const partPath = path.join(this.#taskRoot, ...partRelativePath.split("/"));
    await mkdir(path.dirname(partPath), { recursive: true });
    const attempts: CoreDownloadAttempt[] = [];
    const providerRevisionEvidence: ProviderRevisionEvidenceV1[] = [];
    let resumedFromAttemptId: string | null = null;

    for (let attemptNumber = 1; attemptNumber <= this.#maxAttempts; attemptNumber += 1) {
      const partial = await stat(partPath).catch(() => null);
      const result = await acquireSource({
        ...plan,
        workdirRoot: this.#taskRoot,
        cache: this.#cache,
        client: this.#client,
        partPath,
        resumeFromBytes: partial?.isFile() === true ? partial.size : 0,
        signal,
        onPublished: (published) =>
          this.#registrar?.register("core", published, this.#taskId),
      } satisfies AcquireSourceOptions);
      const retryable = result.attempt.status === "failed" &&
        ["network_error", "timeout", "download_incomplete", "internal_error"].includes(result.attempt.error_code ?? "");
      let asset: RegisteredSourceAssetRef | null = null;
      if (result.asset !== null) {
        const receipt = await this.#assets.register({
          sourceId: result.asset.source_id,
          relativePath: result.asset.relative_path,
          role: plan.assetRole ?? "source",
          mediaType: result.asset.media_type,
        });
        if (receipt.sha256 !== result.asset.sha256 || receipt.size_bytes !== result.asset.size_bytes) {
          throw new Error("acquired source asset hash drift detected during registration");
        }
        await this.#assets.registerCoreAcquisitionProvenance(receipt, {
          provider_id: handler.providerId,
          implementation_digest: implementationDigest,
          request_identity_digest: requestIdentityDigest,
          ...(providerRevisionFacts === null ? {} : {
            canonical_accession: providerRevisionFacts.canonical_accession,
            provider_snapshot_identity: providerRevisionFacts.provider_snapshot_identity,
            provider_revision_token: providerRevisionFacts.provider_revision_token,
          }),
        });
        if (providerRevisionFacts !== null) {
          providerRevisionEvidence.push(evidenceForReceipt(providerRevisionFacts, receipt));
        }
        asset = receipt.asset_ref;
      }
      const attempt = parseCoreDownloadAttempt({
        schema_version: "1.0",
        attempt_id: result.attempt.attempt_id,
        request_id: request.request_id,
        task_id: request.task_id,
        provider_id: handler.providerId,
        attempt_number: attemptNumber,
        status: result.attempt.status,
        url: result.attempt.url,
        bytes_received: result.attempt.bytes_received,
        error_code: result.attempt.error_code,
        retryable,
        started_at: result.attempt.started_at,
        finished_at: result.attempt.finished_at,
        cache_lineage: {
          schema_version: "1.0",
          cache_key: `acq_${requestIdentityDigest}`,
          request_identity_digest: requestIdentityDigest,
          cache_blob_sha256: result.asset?.sha256 ?? null,
          resumed_from_attempt_id: partial?.isFile() === true ? resumedFromAttemptId : null,
          part_relative_path: partial?.isFile() === true ? partRelativePath : null,
        },
        asset,
      }, this.#taskId);
      attempts.push(attempt);
      await this.#appendAttempt(attempt);
      if (asset !== null) {
        const extractionAssets: RegisteredSourceAssetRef[] = [];
        for (const extraction of plan.extractionAssets ?? []) {
          const receipt = await this.#assets.register(extraction);
          await this.#assets.registerCoreAcquisitionProvenance(receipt, {
            provider_id: handler.providerId,
            implementation_digest: implementationDigest,
            request_identity_digest: requestIdentityDigest,
            ...(providerRevisionFacts === null ? {} : {
              canonical_accession: providerRevisionFacts.canonical_accession,
              provider_snapshot_identity: providerRevisionFacts.provider_snapshot_identity,
              provider_revision_token: providerRevisionFacts.provider_revision_token,
            }),
          });
          extractionAssets.push(receipt.asset_ref);
          if (providerRevisionFacts !== null) {
            providerRevisionEvidence.push(evidenceForReceipt(providerRevisionFacts, receipt));
          }
        }
        return {
          requestIdentityDigest,
          attempts,
          sourceAsset: asset,
          extractionAssets,
          providerRevisionEvidence: Object.freeze(providerRevisionEvidence),
        };
      }
      if (!retryable || attemptNumber === this.#maxAttempts) {
        const errorCode = result.attempt.error_code ?? "unknown_error";
        throw new CoreAcquisitionError(
          `acquisition failed: ${errorCode}`,
          {
            provider_id: handler.providerId,
            error_code: result.attempt.error_code,
            attempts: attemptNumber,
          },
          false,
        );
      }
      resumedFromAttemptId = attempt.attempt_id;
    }
    throw new CoreAcquisitionError(
      "acquisition exhausted attempts",
      { provider_id: handler.providerId, error_code: "attempts_exhausted", attempts: this.#maxAttempts },
      false,
    );
  }

  async #appendAttempt(attempt: CoreDownloadAttempt): Promise<void> {
    const file = path.join(this.#taskRoot, ATTEMPTS_FILE);
    const existing = await readJsonFileOrNull<unknown>(file);
    const attempts = existing === null ? [] : existing;
    if (!Array.isArray(attempts)) throw new TypeError("core acquisition attempts must be an array");
    await writeJsonAtomic(file, [...attempts, attempt]);
  }
}

export function acquisitionRequestIdentity(
  request: CoreAcquisitionRequest,
  implementationDigest: string,
): string {
  if (!/^[0-9a-f]{64}$/.test(implementationDigest)) throw new TypeError("acquisition implementation_digest is invalid");
  const canonical = canonicalJson({
    task_id: request.task_id,
    build_id: request.build_id,
    binding_id: request.binding_id,
    mode: request.mode,
    provider_id: request.provider_id,
    recipe_id: request.recipe_id,
    recipe_version: request.recipe_version,
    implementation_digest: implementationDigest,
    parameters: request.parameters,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function rejectAgentControlledParameters(parameters: Record<string, JsonValue>): void {
  const visit = (value: JsonValue, key: string): void => {
    if (FORBIDDEN_PARAMETER_KEY.test(key)) throw new TypeError("acquisition parameters must not contain Agent code or paths");
    if (typeof value === "string" && (path.isAbsolute(value) || path.win32.isAbsolute(value) || value.includes("../") || value.includes("..\\"))) {
      throw new TypeError("acquisition parameters must not contain arbitrary paths");
    }
    if (Array.isArray(value)) value.forEach((entry) => visit(entry, key));
    else if (value !== null && typeof value === "object") {
      for (const [childKey, child] of Object.entries(value)) visit(child, childKey);
    }
  };
  for (const [key, value] of Object.entries(parameters)) visit(value, key);
}

function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
