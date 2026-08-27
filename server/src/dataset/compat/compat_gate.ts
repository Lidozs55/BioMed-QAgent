/**
 * Expression Compatibility Gate (Python ``compat_gate.py``; ARCHITECTURE 2,
 * Design 8.4).  Decides whether canonicalized sources may be merged into one
 * primary dataset.  The gate is deterministic and reports stable reason
 * codes; it never mutates state.  Fail-closed rules:
 *
 * - family / row granularity / target schema must match the build spec;
 * - every source must carry formal mapping evidence (never string-similarity
 *   proposals);
 * - a merge (2+ sources) additionally requires a single measurement identity
 *   (value semantics x scale x unit) and a single gene-id namespace — raw
 *   counts never silently merge with TPM or generic expression values, and
 *   symbol-keyed rows never silently merge with ensembl-keyed rows.
 */

import type {
  DataBatch,
  DatasetExecutionSpec,
} from "../contracts/index.js";
import { MAPPING_METHOD, VALUE_SCALE } from "../contracts/index.js";
import { MeasurementIdentity } from "../canonicalizer/identity.js";
import type { CanonicalizationResult } from "../canonicalizer/canonicalizer.js";

const MEASUREMENT_REASON = "measurement_identity_mismatch";
const NAMESPACE_REASON = "namespace_mismatch";

/** Gate outcome with stable reason codes (empty reasons when compatible). */
export interface CompatibilityReport {
  compatible: boolean;
  reasons: string[];
}

/** Rebuild an identity triple; null when the value is undecodable. */
function deserializeIdentity(value: unknown): MeasurementIdentity | null {
  if (!Array.isArray(value)) return null;
  try {
    return MeasurementIdentity.deserialize(value.map((item) => String(item)));
  } catch {
    return null;
  }
}

/** Exact triple key for set-style dedup (Python ``tuple(identity)``). */
function identityKey(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  return JSON.stringify(value);
}

/** True when any measurement identity of ``result`` declares an unknown scale. */
function sourceHasUnknownScale(result: CanonicalizationResult): boolean {
  const statistics = result.batch.statistics;
  const serialized = statistics.measurement_identities;
  if (Array.isArray(serialized)) {
    for (const identity of serialized) {
      const decoded = deserializeIdentity(identity);
      if (decoded !== null && decoded.value_scale === VALUE_SCALE.UNKNOWN) {
        return true;
      }
    }
  }
  return statistics.value_scale === VALUE_SCALE.UNKNOWN;
}

function hasFormalMappingEvidence(batch: DataBatch): boolean {
  if (batch.declared_mappings.length === 0) return false;
  return batch.declared_mappings.every(
    (mapping) =>
      mapping.mapping_method !== MAPPING_METHOD.STRING_SIMILARITY &&
      mapping.evidence.trim().length > 0,
  );
}

/**
 * Decide whether canonicalized sources may be merged into one primary dataset
 * under ``spec``.  Deterministic; never mutates state.
 */
export function checkExpressionCompatibility(options: {
  spec: DatasetExecutionSpec;
  results: CanonicalizationResult[];
}): CompatibilityReport {
  const { spec, results } = options;
  const reasons: string[] = [];
  if (results.length === 0) {
    return { compatible: false, reasons: ["no_sources"] };
  }
  for (const result of results) {
    const batch = result.batch;
    if (batch.dataset_family !== spec.dataset_family) {
      reasons.push("family_mismatch");
    }
    if (batch.row_granularity !== spec.row_granularity) {
      reasons.push("granularity_mismatch");
    }
    if (batch.schema_ref !== spec.schema_ref) {
      reasons.push("schema_mismatch");
    }
    if (!hasFormalMappingEvidence(batch)) {
      reasons.push("missing_mapping_evidence");
    }
  }
  const nonEmpty = results.filter((result) => result.rowCount > 0);
  if (results.length > 1 && nonEmpty.length > 0) {
    const identities = new Set<string>();
    for (const result of nonEmpty) {
      const serialized = result.batch.statistics.measurement_identities;
      if (!Array.isArray(serialized)) continue;
      for (const identity of serialized) {
        const key = identityKey(identity);
        if (key !== null) identities.add(key);
      }
    }
    if (identities.size > 1) {
      reasons.push(MEASUREMENT_REASON);
    }
    // Phase 5 D4: a cross-source merge may never mix an *unknown* scale with
    // anything — including another unknown.  The gate alone cannot prove
    // equivalence; only a server-owned evidence-backed normalization rule
    // could, and Phase 5 registers none.  Single-source builds keep their
    // honest ``unknown`` scale untouched.
    if (nonEmpty.some((result) => sourceHasUnknownScale(result))) {
      reasons.push(MEASUREMENT_REASON);
    }
    const namespaces = new Set<string>();
    for (const result of nonEmpty) {
      const list = result.batch.statistics.gene_id_namespaces;
      if (!Array.isArray(list)) continue;
      for (const namespace of list) {
        if (typeof namespace === "string") namespaces.add(namespace);
      }
    }
    if (namespaces.size > 1) {
      reasons.push(NAMESPACE_REASON);
    }
  }
  const uniqueReasons = [...new Set(reasons)];
  return { compatible: uniqueReasons.length === 0, reasons: uniqueReasons };
}