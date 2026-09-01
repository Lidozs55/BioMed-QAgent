import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  extractZipMember,
  readZipCentralDirectory,
  selectExtractableZipMembers,
  ZipFormatError,
  type ZipMemberEntry,
} from "./zip-members.js";
import { xlsxWorksheetsToCsv } from "./xlsx-to-csv.js";

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
  /**
   * HTTP method for this acquisition; defaults to GET. POST sends `body` as
   * JSON through the same policy-pinned transport and is never resumable;
   * request parameters and tool inputs never populate this field.
   */
  method?: "GET" | "POST";
  /** Raw JSON request body for POST acquisitions; forbidden for GET. */
  body?: string;
  allowedHosts?: ReadonlySet<string>;
  /** Trusted provider-selected registry role; never populated by request parameters. */
  assetRole?: "source" | "carrier";
  /**
   * Per-plan wall-clock download budget in ms, overriding the generic HTTP
   * timeout for providers whose carriers are known to be large and slow
   * (e.g. Orphanet en_product1, ~52 MB). Trusted provider output only;
   * request parameters and tool inputs never populate this field.
   */
  timeoutMs?: number;
  /** Trusted provider-produced extraction outputs; never populated by request parameters. */
  extractionAssets?: readonly AcquisitionExtractionAsset[];
  /**
   * Trusted provider policy for in-place ZIP member extraction: after a
   * successful download whose media type is a ZIP archive, members matching
   * the extension allowlist are inflated, CRC-verified, staged, and
   * registered as separate Core assets carrying the same acquisition
   * provenance. Never populated by request parameters.
   */
  zipMemberExtraction?: {
    extensions: readonly string[];
    maxMembers: number;
    maxMemberBytes: number;
    role: "source" | "mapping" | "metadata" | "carrier";
    /**
     * Optional trusted policy to additionally parse staged `.xlsx` members
     * into per-worksheet UTF-8 CSV assets so dynamic transforms can consume
     * supplementary tables without workspace parsing. Raw members stay
     * registered for the archive → attachment → parsed-table provenance
     * chain; parsing is best-effort and never fails the acquisition.
     */
    xlsxToCsv?: {
      maxWorksheets: number;
      maxCsvBytes: number;
    };
  };
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

export interface CoreAcquisitionPlan {
  readonly requestIdentityDigest: string;
  readonly providerId: string;
  readonly implementationDigest: string;
  readonly recipe: WorkflowRecipeRef | null;
}

/** Per-binding failure diagnostics surfaced to the tool layer verbatim. */
export interface CoreAcquisitionErrorDetails {
  provider_id: string;
  error_code: string | null;
  attempts: number;
  binding_id?: string;
  url?: string;
  endpoint_host?: string;
  elapsed_ms?: number;
  timeout_stage?: "wall_clock" | null;
}

export class CoreAcquisitionError extends Error {
  readonly retryable: boolean;
  readonly details: CoreAcquisitionErrorDetails;

  constructor(
    message: string,
    details: CoreAcquisitionErrorDetails,
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
  #attemptAppendQueue: Promise<void> = Promise.resolve();

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

  /**
   * Resolve and validate a provider request without downloading, registering,
   * or creating an acquisition attempt. Provider `plan` is the existing cheap
   * admission seam; the returned identity is deterministic for the request.
   */
  async plan(rawRequest: CoreAcquisitionRequest): Promise<CoreAcquisitionPlan> {
    const { request, handler, recipe } = this.#registry.resolve(rawRequest, this.#taskId);
    const implementationDigest = recipe?.implementation_digest ?? handler.implementationDigest;
    const requestIdentityDigest = acquisitionRequestIdentity(request, implementationDigest);
    await handler.plan(request);
    return Object.freeze({
      requestIdentityDigest,
      providerId: handler.providerId,
      implementationDigest,
      recipe,
    });
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
    const acquireStartedAtMs = Date.now();
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
        [
          "network_error",
          // Fine-grained retryable transport subclasses (DNS may be transient,
          // refused/timeout/reset sockets usually are, 5xx/408/429 servers heal).
          "dns_failure",
          "connect_refused",
          "connect_timeout",
          "connection_reset",
          "http_server_error",
          "timeout",
          "download_incomplete",
          "internal_error",
        ].includes(result.attempt.error_code ?? "");
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
        const zipConfig = plan.zipMemberExtraction;
        if (zipConfig !== undefined && result.asset !== null) {
          const stagedZipMembers = await extractZipCarrierMembers(
            this.#taskRoot,
            { asset: result.asset, requestIdentityDigest },
            zipConfig,
          );
          for (const member of stagedZipMembers) {
            const memberProvenanceFacts = {
              provider_id: handler.providerId,
              implementation_digest: implementationDigest,
              request_identity_digest: requestIdentityDigest,
              ...(providerRevisionFacts === null ? {} : {
                canonical_accession: providerRevisionFacts.canonical_accession,
                provider_snapshot_identity: providerRevisionFacts.provider_snapshot_identity,
                provider_revision_token: providerRevisionFacts.provider_revision_token,
              }),
            };
            const receipt = await this.#assets.register({
              sourceId: `${result.asset.source_id}_x${member.index}`,
              relativePath: member.relativePath,
              role: zipConfig.role,
              mediaType: member.mediaType,
            });
            await this.#assets.registerCoreAcquisitionProvenance(receipt, memberProvenanceFacts);
            extractionAssets.push(receipt.asset_ref);
            if (providerRevisionFacts !== null) {
              providerRevisionEvidence.push(evidenceForReceipt(providerRevisionFacts, receipt));
            }
            for (const parsed of member.parsedCsvs) {
              const parsedReceipt = await this.#assets.register({
                sourceId: `${result.asset.source_id}_x${member.index}_p${parsed.sheetIndex}`,
                relativePath: parsed.relativePath,
                role: zipConfig.role,
                mediaType: "text/csv",
              });
              await this.#assets.registerCoreAcquisitionProvenance(parsedReceipt, memberProvenanceFacts);
              extractionAssets.push(parsedReceipt.asset_ref);
              if (providerRevisionFacts !== null) {
                providerRevisionEvidence.push(evidenceForReceipt(providerRevisionFacts, parsedReceipt));
              }
            }
          }
        }
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
            ...acquisitionFailureContext(request, plan, acquireStartedAtMs, result.attempt.error_code),
          },
          false,
        );
      }
      resumedFromAttemptId = attempt.attempt_id;
    }
    throw new CoreAcquisitionError(
      "acquisition exhausted attempts",
      {
        provider_id: handler.providerId,
        error_code: "attempts_exhausted",
        attempts: this.#maxAttempts,
        ...acquisitionFailureContext(request, plan, acquireStartedAtMs, null),
      },
      false,
    );
  }

  async #appendAttempt(attempt: CoreDownloadAttempt): Promise<void> {
    const append = async (): Promise<void> => {
      const file = path.join(this.#taskRoot, ATTEMPTS_FILE);
      const existing = await readJsonFileOrNull<unknown>(file);
      const attempts = existing === null ? [] : existing;
      if (!Array.isArray(attempts)) throw new TypeError("core acquisition attempts must be an array");
      await writeJsonAtomic(file, [...attempts, attempt]);
    };
    const pending = this.#attemptAppendQueue.then(append, append);
    this.#attemptAppendQueue = pending.catch(() => undefined);
    await pending;
  }
}

/**
 * Extra per-binding diagnostics attached to CoreAcquisitionError so the tool
 * layer can report exactly which binding/provider/host failed and how long
 * the wall-clock budget lasted before giving up.
 */
function acquisitionFailureContext(
  request: CoreAcquisitionRequest,
  plan: AcquisitionDownloadPlan,
  startedAtMs: number,
  errorCode: string | null,
): Pick<CoreAcquisitionErrorDetails, "binding_id" | "url" | "endpoint_host" | "elapsed_ms" | "timeout_stage"> {
  let endpointHost: string | undefined;
  try {
    endpointHost = new URL(plan.source.url).host;
  } catch {
    endpointHost = undefined;
  }
  return {
    binding_id: request.binding_id,
    url: plan.source.url,
    endpoint_host: endpointHost,
    elapsed_ms: Date.now() - startedAtMs,
    timeout_stage: errorCode === "timeout" ? "wall_clock" : null,
  };
}

export function acquisitionRequestIdentity(
  request: CoreAcquisitionRequest,
  implementationDigest: string,
): string {
  if (!/^[0-9a-f]{64}$/.test(implementationDigest)) throw new TypeError("acquisition implementation_digest is invalid");
  const canonical = canonicalJson({
    task_id: request.task_id,
    requirement_id: request.requirement_id,
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

const ZIP_MEMBER_MEDIA_TYPES: Readonly<Record<string, string>> = {
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".tab": "text/tab-separated-values",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".txt": "text/plain",
  ".json": "application/json",
};

interface StagedParsedCsv {
  sheetIndex: number;
  sheetName: string;
  relativePath: string;
}

interface StagedZipMember {
  index: number;
  relativePath: string;
  mediaType: string;
  parsedCsvs: StagedParsedCsv[];
}

/**
 * Inflate plan-approved members of a downloaded ZIP carrier into
 * ``source_assets/extracted/<request digest>/`` so they can be registered as
 * provenance-bound Core assets. Non-ZIP carriers and structurally invalid
 * archives stage nothing; extraction is best-effort by policy — a malformed
 * member only shrinks the selection, never fabricates bytes. When the plan
 * enables `xlsxToCsv`, staged `.xlsx` members are additionally converted into
 * one UTF-8 CSV per bounded worksheet next to the raw member.
 */
async function extractZipCarrierMembers(
  taskRoot: string,
  result: { asset: { relative_path: string; media_type: string }; requestIdentityDigest: string },
  config: NonNullable<AcquisitionDownloadPlan["zipMemberExtraction"]>,
): Promise<StagedZipMember[]> {
  const mediaType = (result.asset.media_type ?? "").toLowerCase();
  const looksLikeZip = mediaType.includes("zip") || result.asset.relative_path.toLowerCase().endsWith(".zip");
  if (!looksLikeZip) return [];
  const archivePath = path.join(taskRoot, ...result.asset.relative_path.split("/"));
  const buffer = await readFile(archivePath);
  let entries: ZipMemberEntry[];
  try {
    entries = readZipCentralDirectory(buffer);
  } catch (error) {
    if (error instanceof ZipFormatError) return [];
    throw error;
  }
  const members = selectExtractableZipMembers(entries, config);
  const staged: StagedZipMember[] = [];
  for (const [index, member] of members.entries()) {
    const content = extractZipMember(buffer, member);
    const relativePath = `source_assets/extracted/${result.requestIdentityDigest}/${index}_${member.storedName}`;
    const absolutePath = path.join(taskRoot, ...relativePath.split("/"));
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content);
    const extension = member.storedName.slice(member.storedName.lastIndexOf(".")).toLowerCase();
    const parsedCsvs: StagedParsedCsv[] = [];
    if (extension === ".xlsx" && config.xlsxToCsv !== undefined) {
      for (const sheet of xlsxWorksheetsToCsv(content, config.xlsxToCsv).entries()) {
        const [sheetIndex, { sheetName, csv }] = sheet;
        const safeSheetName = sheetName.replaceAll(/[^A-Za-z0-9_.-]/gu, "_").slice(0, 64) || "sheet";
        const parsedPath = `source_assets/extracted/${result.requestIdentityDigest}/${index}_${member.storedName.slice(0, 140)}_p${sheetIndex}.csv`;
        const parsedAbsolutePath = path.join(taskRoot, ...parsedPath.split("/"));
        await writeFile(parsedAbsolutePath, csv);
        parsedCsvs.push({ sheetIndex, sheetName: safeSheetName, relativePath: parsedPath });
      }
    }
    staged.push({ index, relativePath, mediaType: ZIP_MEMBER_MEDIA_TYPES[extension] ?? "application/octet-stream", parsedCsvs });
  }
  return staged;
}
