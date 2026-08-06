"""Expression Compatibility Gate (ARCHITECTURE §2; Design §8.4).

Decides whether canonicalized sources may be merged into one primary dataset.
The gate is deterministic and reports stable reason codes; it never mutates
state.  Fail-closed rules:

- family / row granularity / target schema must match the build spec;
- every source must carry formal mapping evidence (never string-similarity
  proposals);
- a merge (2+ sources) additionally requires a single measurement identity
  (value semantics x scale x unit) and a single gene-id namespace — raw
  counts never silently merge with TPM or generic expression values, and
  symbol-keyed rows never silently merge with ensembl-keyed rows.
"""

from __future__ import annotations

from dataclasses import dataclass

from app.datasets.build.canonicalizer import CanonicalizationResult
from app.datasets.contracts import DataBatch, DatasetBuildSpec, MappingMethod

_MERGEABLE_MEASUREMENT_REASON = "measurement_identity_mismatch"
_NAMESPACE_REASON = "namespace_mismatch"


@dataclass(frozen=True)
class CompatibilityReport:
    """Gate outcome with stable reason codes (empty tuple when compatible)."""

    compatible: bool
    reasons: tuple[str, ...] = ()


def check_expression_compatibility(
    *,
    spec: DatasetBuildSpec,
    results: list[CanonicalizationResult],
) -> CompatibilityReport:
    reasons: list[str] = []
    if not results:
        return CompatibilityReport(False, ("no_sources",))
    for result in results:
        batch = result.batch
        if batch.dataset_family != spec.dataset_family:
            reasons.append("family_mismatch")
        if batch.row_granularity != spec.row_granularity:
            reasons.append("granularity_mismatch")
        if batch.schema_ref != spec.schema_ref:
            reasons.append("schema_mismatch")
        if not _has_formal_mapping_evidence(batch):
            reasons.append("missing_mapping_evidence")
    non_empty = [result for result in results if result.row_count > 0]
    if len(results) > 1 and len(non_empty) > 0:
        identities = {
            tuple(identity)
            for result in non_empty
            for identity in result.batch.statistics.get("measurement_identities", [])
        }
        if len(identities) > 1:
            reasons.append(_MERGEABLE_MEASUREMENT_REASON)
        namespaces = {
            namespace
            for result in non_empty
            for namespace in result.batch.statistics.get("gene_id_namespaces", [])
        }
        if len(namespaces) > 1:
            reasons.append(_NAMESPACE_REASON)
    unique_reasons = tuple(dict.fromkeys(reasons))
    return CompatibilityReport(compatible=not unique_reasons, reasons=unique_reasons)


def _has_formal_mapping_evidence(batch: DataBatch) -> bool:
    if not batch.declared_mappings:
        return False
    return all(
        mapping.mapping_method is not MappingMethod.STRING_SIMILARITY
        and bool(mapping.evidence.strip())
        for mapping in batch.declared_mappings
    )
