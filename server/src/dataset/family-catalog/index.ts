import type {
  ScopeQualifiedRef,
  TransformScope,
  TransformTrustStatus,
} from "@biomed/contracts";

export type FamilyCatalogEntryKind = "family_spec" | "dataset_transform";
export type FamilyCatalogExecutionPurpose = "sandbox" | "fixture" | "shadow" | "production";

/**
 * Catalog identity, scope, and execution trust are deliberately independent.
 * Entries contain metadata only: executable bytes and FamilySpec/Transform
 * payloads must be loaded from a content-addressed admission store and rehashed
 * against `digest`. Keeping payloads out of this snapshot closes post-admission
 * mutation and digest/value substitution at the catalog boundary.
 */
export interface FamilyCatalogEntry extends ScopeQualifiedRef {
  kind: FamilyCatalogEntryKind;
  status: TransformTrustStatus;
}

export interface FamilyCatalog {
  readonly entries: readonly FamilyCatalogEntry[];
}

export type FamilyCatalogError =
  | { code: "invalid_entry"; index: number; message: string }
  | {
      code: "identity_conflict";
      scope: TransformScope;
      id: string;
      version: string;
      digests: readonly string[];
    }
  | { code: "invalid_reference"; message: string }
  | { code: "invalid_execution_purpose"; purpose: unknown }
  | { code: "not_found"; ref: Readonly<Partial<ScopeQualifiedRef>> }
  | { code: "ambiguous_reference"; candidates: readonly ScopeQualifiedRef[] }
  | { code: "example_not_executable"; ref: ScopeQualifiedRef }
  | { code: "entry_not_executable"; ref: ScopeQualifiedRef; kind: FamilyCatalogEntryKind }
  | { code: "execution_revoked"; ref: ScopeQualifiedRef }
  | {
      code: "status_not_executable";
      ref: ScopeQualifiedRef;
      status: TransformTrustStatus;
      purpose: FamilyCatalogExecutionPurpose;
    };

export type FamilyCatalogResult =
  | { ok: true; entry: FamilyCatalogEntry }
  | { ok: false; error: FamilyCatalogError };

export type FamilyCatalogCreateResult =
  | { ok: true; catalog: FamilyCatalog }
  | { ok: false; error: FamilyCatalogError };

export interface FamilyCatalogDiscoveryRef {
  scope?: TransformScope;
  id: string;
  version?: string;
  digest?: string;
}

const SCOPES = new Set<TransformScope>(["example", "task", "user", "curated", "system"]);
const STATUSES = new Set<TransformTrustStatus>([
  "submitted",
  "sandbox_executable",
  "fixture_verified",
  "shadow_verified",
  "trusted_e2e_verified",
  "activated",
  "revoked",
  "retired",
]);
const EXECUTABLE_STATUSES_BY_PURPOSE: Readonly<
  Record<FamilyCatalogExecutionPurpose, ReadonlySet<TransformTrustStatus>>
> = {
  sandbox: new Set([
    "sandbox_executable",
    "fixture_verified",
    "shadow_verified",
    "trusted_e2e_verified",
    "activated",
  ]),
  fixture: new Set([
    "fixture_verified",
    "shadow_verified",
    "trusted_e2e_verified",
    "activated",
  ]),
  shadow: new Set(["shadow_verified", "trusted_e2e_verified", "activated"]),
  production: new Set(["activated"]),
};
const ENTRY_KINDS = new Set<FamilyCatalogEntryKind>(["family_spec", "dataset_transform"]);
const ENTRY_KEYS = new Set(["kind", "scope", "id", "version", "digest", "status"]);
const EXACT_REF_KEYS = new Set(["scope", "id", "version", "digest"]);
const DISCOVERY_REF_KEYS = new Set(["scope", "id", "version", "digest"]);
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SAFE_CATALOG_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

/**
 * Snapshot a plain wire object without invoking accessors. Catalog metadata is
 * JSON-shaped: symbols, hidden fields, custom prototypes, missing fields, and
 * accessor properties are all rejected before any field value is consumed.
 */
function snapshotDataRecord(
  value: unknown,
  allowed: ReadonlySet<string>,
  required: ReadonlySet<string>,
): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;

  const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const seen = new Set<string>();
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) return null;
    snapshot[key] = descriptor.value;
    seen.add(key);
  }
  if ([...required].some((key) => !seen.has(key))) return null;
  return snapshot;
}

function isSafeCatalogToken(value: unknown): value is string {
  return typeof value === "string"
    && value.normalize("NFC") === value
    && SAFE_CATALOG_TOKEN.test(value);
}

function parseEntry(value: unknown, index: number): FamilyCatalogCreateResult | FamilyCatalogEntry {
  const record = snapshotDataRecord(value, ENTRY_KEYS, ENTRY_KEYS);
  if (record === null) {
    return invalidEntry(index, "entry must contain only plain catalog data fields");
  }
  if (!ENTRY_KINDS.has(record.kind as FamilyCatalogEntryKind)) {
    return invalidEntry(index, "kind is not supported");
  }
  if (!SCOPES.has(record.scope as TransformScope)) {
    return invalidEntry(index, "scope is not supported");
  }
  if (!isSafeCatalogToken(record.id) || !isSafeCatalogToken(record.version)) {
    return invalidEntry(index, "id and version must be bounded safe catalog tokens");
  }
  if (typeof record.digest !== "string" || !SHA256_PATTERN.test(record.digest)) {
    return invalidEntry(index, "digest must be a lowercase SHA-256 hex string");
  }
  if (!STATUSES.has(record.status as TransformTrustStatus)) {
    return invalidEntry(index, "status is not supported");
  }
  return Object.freeze({
    kind: record.kind as FamilyCatalogEntryKind,
    scope: record.scope as TransformScope,
    id: record.id,
    version: record.version,
    digest: record.digest,
    status: record.status as TransformTrustStatus,
  });
}

function invalidEntry(index: number, message: string): FamilyCatalogCreateResult {
  return { ok: false, error: { code: "invalid_entry", index, message } };
}

function identityKey(entry: Pick<FamilyCatalogEntry, "scope" | "id" | "version">): string {
  return JSON.stringify([entry.scope, entry.id, entry.version]);
}

function exactKey(entry: ScopeQualifiedRef): string {
  return JSON.stringify([entry.scope, entry.id, entry.version, entry.digest]);
}

/** Build a validated immutable in-memory catalog. No I/O or registration occurs. */
export function createFamilyCatalog(entries: readonly unknown[]): FamilyCatalogCreateResult {
  const parsed: FamilyCatalogEntry[] = [];
  const identityDigests = new Map<string, Set<string>>();
  const exactEntries = new Set<string>();

  for (let index = 0; index < entries.length; index += 1) {
    const result = parseEntry(entries[index], index);
    if ("ok" in result) return result;

    const identity = identityKey(result);
    const digests = identityDigests.get(identity) ?? new Set<string>();
    digests.add(result.digest);
    if (digests.size > 1) {
      return {
        ok: false,
        error: {
          code: "identity_conflict",
          scope: result.scope,
          id: result.id,
          version: result.version,
          digests: Object.freeze([...digests].sort()),
        },
      };
    }
    identityDigests.set(identity, digests);

    const exact = exactKey(result);
    if (exactEntries.has(exact)) {
      return invalidEntry(index, "duplicate exact catalog identity");
    }
    exactEntries.add(exact);
    parsed.push(result);
  }

  return {
    ok: true,
    catalog: Object.freeze({ entries: Object.freeze(parsed) }),
  };
}

function parseExactRef(value: unknown): ScopeQualifiedRef | { code: "invalid_reference"; message: string } {
  const record = snapshotDataRecord(value, EXACT_REF_KEYS, EXACT_REF_KEYS);
  if (record === null) {
    return {
      code: "invalid_reference",
      message: "execution and inspection require exact plain scope, id, version, and digest fields",
    };
  }
  if (!SCOPES.has(record.scope as TransformScope)) {
    return { code: "invalid_reference", message: "scope is not supported" };
  }
  if (!isSafeCatalogToken(record.id) || !isSafeCatalogToken(record.version)) {
    return { code: "invalid_reference", message: "id and version must be bounded safe catalog tokens" };
  }
  if (typeof record.digest !== "string" || !SHA256_PATTERN.test(record.digest)) {
    return { code: "invalid_reference", message: "digest must be a lowercase SHA-256 hex string" };
  }
  return {
    scope: record.scope as TransformScope,
    id: record.id,
    version: record.version,
    digest: record.digest,
  };
}

function exactLookup(catalog: FamilyCatalog, ref: ScopeQualifiedRef): FamilyCatalogResult {
  const match = catalog.entries.find((entry) => exactKey(entry) === exactKey(ref));
  return match === undefined
    ? { ok: false, error: { code: "not_found", ref } }
    : { ok: true, entry: match };
}

/** Exact lookup for historical inspection. Trust status never hides old records. */
export function inspectFamilyCatalogEntry(
  catalog: FamilyCatalog,
  refValue: unknown,
): FamilyCatalogResult {
  const ref = parseExactRef(refValue);
  if ("code" in ref) return { ok: false, error: ref };
  return exactLookup(catalog, ref);
}

/**
 * Resolve a reference for a new execution. This always requires the complete
 * production identity and applies execution status independently from scope.
 */
export function resolveFamilyCatalogExecution(
  catalog: FamilyCatalog,
  refValue: unknown,
  purposeValue: unknown,
): FamilyCatalogResult {
  if (
    typeof purposeValue !== "string"
    || !Object.hasOwn(EXECUTABLE_STATUSES_BY_PURPOSE, purposeValue)
  ) {
    return {
      ok: false,
      error: { code: "invalid_execution_purpose", purpose: purposeValue },
    };
  }
  const purpose = purposeValue as FamilyCatalogExecutionPurpose;
  const ref = parseExactRef(refValue);
  if ("code" in ref) return { ok: false, error: ref };

  const resolved = exactLookup(catalog, ref);
  if (!resolved.ok) return resolved;
  if (resolved.entry.kind !== "dataset_transform") {
    return {
      ok: false,
      error: { code: "entry_not_executable", ref, kind: resolved.entry.kind },
    };
  }
  if (resolved.entry.scope === "example") {
    return { ok: false, error: { code: "example_not_executable", ref } };
  }
  if (resolved.entry.status === "revoked") {
    return { ok: false, error: { code: "execution_revoked", ref } };
  }
  if (!EXECUTABLE_STATUSES_BY_PURPOSE[purpose].has(resolved.entry.status)) {
    return {
      ok: false,
      error: {
        code: "status_not_executable",
        ref,
        status: resolved.entry.status,
        purpose,
      },
    };
  }
  return resolved;
}

function parseDiscoveryRef(
  value: unknown,
): FamilyCatalogDiscoveryRef | { code: "invalid_reference"; message: string } {
  const record = snapshotDataRecord(value, DISCOVERY_REF_KEYS, new Set(["id"]));
  if (record === null) {
    return { code: "invalid_reference", message: "discovery reference contains invalid data fields" };
  }
  if (!isSafeCatalogToken(record.id)) {
    return { code: "invalid_reference", message: "id must be a bounded safe catalog token" };
  }
  if (record.version !== undefined && !isSafeCatalogToken(record.version)) {
    return { code: "invalid_reference", message: "version must be a bounded safe catalog token when present" };
  }
  if (record.scope !== undefined && !SCOPES.has(record.scope as TransformScope)) {
    return { code: "invalid_reference", message: "scope is not supported" };
  }
  if (record.digest !== undefined && (typeof record.digest !== "string" || !SHA256_PATTERN.test(record.digest))) {
    return { code: "invalid_reference", message: "digest must be a lowercase SHA-256 hex string" };
  }
  return {
    id: record.id,
    ...(record.version === undefined ? {} : { version: record.version as string }),
    ...(record.scope === undefined ? {} : { scope: record.scope as TransformScope }),
    ...(record.digest === undefined ? {} : { digest: record.digest as string }),
  };
}

/** Unqualified discovery lookup; multiple candidates are always explicit ambiguity. */
export function resolveFamilyCatalogDiscovery(
  catalog: FamilyCatalog,
  refValue: unknown,
): FamilyCatalogResult {
  const ref = parseDiscoveryRef(refValue);
  if ("code" in ref) return { ok: false, error: ref };

  const matches = catalog.entries.filter((entry) =>
    entry.id === ref.id
      && (ref.version === undefined || entry.version === ref.version)
      && (ref.scope === undefined || entry.scope === ref.scope)
      && (ref.digest === undefined || entry.digest === ref.digest),
  );
  if (matches.length === 0) return { ok: false, error: { code: "not_found", ref } };
  if (matches.length > 1) {
    return {
      ok: false,
      error: {
        code: "ambiguous_reference",
        candidates: Object.freeze(matches
          .map(({ scope, id, version, digest }) => ({ scope, id, version, digest }))
          .sort((left, right) => {
            const leftKey = exactKey(left);
            const rightKey = exactKey(right);
            return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
          })),
      },
    };
  }
  return { ok: true, entry: matches[0] };
}
