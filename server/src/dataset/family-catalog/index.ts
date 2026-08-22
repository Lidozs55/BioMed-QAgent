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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function isCanonicalNonEmptyString(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.trim() === value
    && value.normalize("NFC") === value
    && ![...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
    });
}

function parseEntry(value: unknown, index: number): FamilyCatalogCreateResult | FamilyCatalogEntry {
  if (!isRecord(value) || !hasOnlyKeys(value, ENTRY_KEYS)) {
    return invalidEntry(index, "entry must be an object with only catalog entry fields");
  }
  if (!ENTRY_KINDS.has(value.kind as FamilyCatalogEntryKind)) {
    return invalidEntry(index, "kind is not supported");
  }
  if (!SCOPES.has(value.scope as TransformScope)) {
    return invalidEntry(index, "scope is not supported");
  }
  if (!isCanonicalNonEmptyString(value.id) || !isCanonicalNonEmptyString(value.version)) {
    return invalidEntry(index, "id and version must be non-empty canonical strings");
  }
  if (typeof value.digest !== "string" || !SHA256_PATTERN.test(value.digest)) {
    return invalidEntry(index, "digest must be a lowercase SHA-256 hex string");
  }
  if (!STATUSES.has(value.status as TransformTrustStatus)) {
    return invalidEntry(index, "status is not supported");
  }
  return Object.freeze({
    kind: value.kind as FamilyCatalogEntryKind,
    scope: value.scope as TransformScope,
    id: value.id,
    version: value.version,
    digest: value.digest,
    status: value.status as TransformTrustStatus,
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
  if (!isRecord(value) || !hasOnlyKeys(value, EXACT_REF_KEYS) || Object.keys(value).length !== 4) {
    return {
      code: "invalid_reference",
      message: "execution and inspection require exact scope, id, version, and digest only",
    };
  }
  if (!SCOPES.has(value.scope as TransformScope)) {
    return { code: "invalid_reference", message: "scope is not supported" };
  }
  if (!isCanonicalNonEmptyString(value.id) || !isCanonicalNonEmptyString(value.version)) {
    return { code: "invalid_reference", message: "id and version must be non-empty canonical strings" };
  }
  if (typeof value.digest !== "string" || !SHA256_PATTERN.test(value.digest)) {
    return { code: "invalid_reference", message: "digest must be a lowercase SHA-256 hex string" };
  }
  return {
    scope: value.scope as TransformScope,
    id: value.id,
    version: value.version,
    digest: value.digest,
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
    || !(purposeValue in EXECUTABLE_STATUSES_BY_PURPOSE)
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
  if (!isRecord(value) || !hasOnlyKeys(value, DISCOVERY_REF_KEYS)) {
    return { code: "invalid_reference", message: "discovery reference contains invalid fields" };
  }
  if (!isCanonicalNonEmptyString(value.id)) {
    return { code: "invalid_reference", message: "id must be a non-empty canonical string" };
  }
  if (value.version !== undefined && !isCanonicalNonEmptyString(value.version)) {
    return { code: "invalid_reference", message: "version must be a non-empty canonical string when present" };
  }
  if (value.scope !== undefined && !SCOPES.has(value.scope as TransformScope)) {
    return { code: "invalid_reference", message: "scope is not supported" };
  }
  if (value.digest !== undefined && (typeof value.digest !== "string" || !SHA256_PATTERN.test(value.digest))) {
    return { code: "invalid_reference", message: "digest must be a lowercase SHA-256 hex string" };
  }
  return {
    id: value.id,
    ...(value.version === undefined ? {} : { version: value.version }),
    ...(value.scope === undefined ? {} : { scope: value.scope as TransformScope }),
    ...(value.digest === undefined ? {} : { digest: value.digest }),
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
