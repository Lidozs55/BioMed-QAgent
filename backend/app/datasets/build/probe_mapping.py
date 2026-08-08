"""Probe → gene mapping for the V2 build chain (Phase 5 T7 D2/D3/D5).

GEO platform annotation tables (SOFT ``!platform_table_begin`` /
``!platform_table_end`` blocks) map probe IDs to gene identifiers.  This
module parses a local annotation asset (gzip or plain text), computes the
probe-level mapping statistics the way D3 specifies (distinct probes, never
gene×sample rows) and emits:

- the probe → gene map consumed by the canonicalizer (mapped rows are
  re-namespaced to the target gene namespace; unmapped rows stay
  ``geo_probe``),
- one ``ProbeMappingSummary`` per binding/platform (feeds the T5 coverage
  policy: gene-required builds need coverage 1.0; probe-level builds warn),
- a per-binding mapping-detail audit CSV
  (``canonical/<binding_id>_probe_mapping.csv``) with the D3 columns.

The parser mirrors the V1 SOFT platform-table semantics (same gene-column
priority, same missing-value sentinels) so a platform's annotation means the
same thing in both pipelines.  It is pure and deterministic.
"""

from __future__ import annotations

import csv
import gzip
import hashlib
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from app.datasets.build.errors import ProbeMappingAssetMismatchError
from app.datasets.contracts import (
    ProbeMappingStatus,
    ProbeMappingSummary,
)
from app.domain.contracts import SourceAsset
from app.pipeline.processing.geo_annotation import parse_platform_table_text

#: Stable server-side mapping rule id (D3 ``mapping_rule_id``).
PROBE_MAPPING_RULE_ID = "geo.probe-map.v1"

#: D3 mapping-detail audit CSV columns.
MAPPING_DETAIL_COLUMNS = (
    "binding_id",
    "platform_id",
    "probe_id",
    "target_gene_id",
    "target_namespace",
    "status",
    "evidence_asset_id",
    "rule_id",
)


@dataclass(frozen=True)
class ProbeMappingResult:
    """Outcome of one binding/platform probe→gene mapping attempt."""

    probe_to_gene: dict[str, str]
    target_namespace: Literal["gene_symbol", "ensembl_gene"]
    summary: ProbeMappingSummary
    detail_path: Path


def _target_namespace_for(gene_column: str) -> Literal["gene_symbol", "ensembl_gene"]:
    return "ensembl_gene" if gene_column == "ENSEMBL_ID" else "gene_symbol"


def _read_table(annotation_path: Path) -> str:
    """Read the annotation asset (gzip or plain UTF-8), fail-closed."""
    raw = annotation_path.read_bytes()
    try:
        text = gzip.decompress(raw).decode("utf-8", errors="replace")
    except (gzip.BadGzipFile, OSError):
        text = raw.decode("utf-8", errors="replace")
    return text


def parse_platform_table(
    annotation_path: Path,
) -> tuple[dict[str, str], Literal["gene_symbol", "ensembl_gene"], ProbeMappingStatus, frozenset[str]]:
    """Parse a SOFT platform table into ``(probe→gene, target_namespace, status, ambiguous_probes)``.

    Status mirrors the V1 vocabulary: ``no_gene_annotation`` when the table
    block or a recognized gene column is missing, ``unmapped`` when the gene
    column exists but carries no usable values.

    The table parsing itself (markers, header, gene-column priority, missing
    sentinels) is delegated to the shared
    :func:`~app.pipeline.processing.geo_annotation.parse_platform_table_text`
    so the V1 and V2 pipelines cannot drift.  Probes mapping to MULTIPLE
    DISTINCT gene targets have no explicit disambiguation rule (D2/F3): they
    are ambiguous, excluded from the map (the canonicalizer keeps them in the
    ``geo_probe`` namespace) and returned for the caller to count.
    """
    text = _read_table(annotation_path)
    table = parse_platform_table_text(text)
    if not table.has_table or table.gene_column is None:
        return {}, "gene_symbol", ProbeMappingStatus.NO_GENE_ANNOTATION, frozenset()
    target_namespace = _target_namespace_for(table.gene_column)

    targets: dict[str, set[str]] = {}
    for probe, gene in table.rows:
        targets.setdefault(probe, set()).add(gene)
    ambiguous_probes = frozenset(
        probe for probe, genes in targets.items() if len(genes) > 1
    )
    mapping = {
        probe: next(iter(genes))
        for probe, genes in targets.items()
        if len(genes) == 1
    }
    if not mapping:
        return {}, target_namespace, ProbeMappingStatus.UNMAPPED, ambiguous_probes
    return mapping, target_namespace, ProbeMappingStatus.MAPPED, ambiguous_probes


def _distinct_probes(batch_path: Path) -> list[str]:
    """Distinct probe ids of the batch's declared ``geo_probe`` rows.

    Only rows whose ``gene_id_namespace_declared`` is ``geo_probe`` count as
    probes; ENSG-shaped rows are genes and never appear in the probe counts.
    """
    probes: set[str] = set()
    with batch_path.open("r", encoding="utf-8", newline="") as handle:
        for row in csv.DictReader(handle):
            if row.get("gene_id_namespace_declared", "").strip() == "geo_probe":
                probe = row.get("gene_id_raw", "").strip()
                if probe:
                    probes.add(probe)
    return sorted(probes)


def build_probe_mapping(
    *,
    annotation_path: Path,
    batch_path: Path,
    binding_id: str,
    platform_id: str | None,
    annotation_asset: SourceAsset | None = None,
    output_dir: Path,
    mapping_rule_id: str = PROBE_MAPPING_RULE_ID,
) -> ProbeMappingResult:
    """Compute the probe→gene mapping + ProbeMappingSummary for one binding.

    Writes the D3 mapping-detail audit CSV under ``canonical/`` and returns
    the map (consumed by the canonicalizer), the target namespace and the
    contract-valid summary.  When ``annotation_asset`` is supplied its
    declared sha256 must match the annotation file actually parsed (F2, D3
    bidirectional invariant) or ``ProbeMappingAssetMismatchError`` is
    raised.  Multi-target probes are ambiguous and stay unmapped (F3).
    """
    if annotation_asset is not None:
        actual = hashlib.sha256(annotation_path.read_bytes()).hexdigest()
        if annotation_asset.sha256 != actual:
            raise ProbeMappingAssetMismatchError(
                f"annotation asset {annotation_asset.asset_id} sha256 does not "
                f"match the parsed file ({annotation_path}): declared "
                f"{annotation_asset.sha256}, actual {actual}"
            )
    probe_to_gene, target_namespace, table_status, ambiguous_probes = (
        parse_platform_table(annotation_path)
    )
    probes = _distinct_probes(batch_path)
    total = len(probes)
    mapped = sum(1 for probe in probes if probe in probe_to_gene)
    ambiguous = [probe for probe in probes if probe in ambiguous_probes]
    ambiguous_count = len(ambiguous)
    unmapped = total - mapped
    coverage = (mapped / total) if total else 0.0
    if total and mapped == total:
        status = ProbeMappingStatus.MAPPED
    elif total and mapped > 0:
        status = ProbeMappingStatus.PARTIAL
    elif table_status in (
        ProbeMappingStatus.NO_GENE_ANNOTATION,
        ProbeMappingStatus.UNMAPPED,
    ):
        # The annotation was parsed but cannot (or does not) map anything.
        status = table_status
    else:
        status = ProbeMappingStatus.UNMAPPED

    detail_path = output_dir / "canonical" / f"{binding_id}_probe_mapping.csv"
    detail_path.parent.mkdir(parents=True, exist_ok=True)
    ambiguous_set = set(ambiguous)
    with detail_path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=MAPPING_DETAIL_COLUMNS)
        writer.writeheader()
        for probe in probes:
            gene = probe_to_gene.get(probe, "")
            if gene:
                row_status = "mapped"
            elif probe in ambiguous_set:
                row_status = "ambiguous"
            else:
                row_status = "unmapped"
            writer.writerow(
                {
                    "binding_id": binding_id,
                    "platform_id": platform_id or "",
                    "probe_id": probe,
                    "target_gene_id": gene,
                    "target_namespace": target_namespace if gene else "",
                    "status": row_status,
                    "evidence_asset_id": (
                        annotation_asset.asset_id
                        if annotation_asset is not None
                        else ""
                    ),
                    "rule_id": mapping_rule_id if gene else "",
                }
            )

    summary = ProbeMappingSummary(
        binding_id=binding_id,
        platform_id=platform_id,
        source_namespace="geo_probe",
        target_namespace=target_namespace if mapped else None,
        mapping_status=status,
        total_probe_count=total,
        mapped_probe_count=mapped,
        unmapped_probe_count=unmapped,
        ambiguous_probe_count=ambiguous_count,
        coverage_ratio=coverage,
        mapping_asset_id=(
            annotation_asset.asset_id if annotation_asset is not None else None
        ),
        mapping_rule_id=mapping_rule_id,
    )
    return ProbeMappingResult(
        probe_to_gene=probe_to_gene,
        target_namespace=target_namespace,
        summary=summary,
        detail_path=detail_path,
    )
