"""Phase 5 D8: platform→sample association for GEO series.

Sample-level GPL evidence comes from series-matrix ``!Sample_platform_id``
rows or SOFT sample metadata (the GPL declared per GSM). A GPL annotation
maps ONLY to samples declaring it; multi-platform matrices split per
platform, and when attribution is impossible the association fails closed
(no unconditional "first GPL").
"""

from __future__ import annotations

import gzip
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from enum import StrEnum

from pydantic import Field

from app.domain.contracts.base import ContractModel

_GPL_PATTERN = re.compile(r"^GPL\d+$")
_GSM_PATTERN = re.compile(r"^GSM\d+$")

# Aggregate mapping status recorded in processing_parameters when a series
# declares multiple platforms but no per-sample evidence exists to attribute
# samples — fail closed (D8), never "first GPL".
MULTI_PLATFORM_FAIL_CLOSED_STATUS = "multi_platform_fail_closed"


class SamplePlatformEvidenceRow(ContractModel):
    """One sample→platform evidence row for the audit (D8)."""

    sample_id: str = Field(pattern=r"^GSM\d+$")
    platform_id: str = Field(pattern=r"^GPL\d+$")


class PlatformAssociationMode(StrEnum):
    """How a series' samples are attributed to GPLs (D8)."""

    SINGLE_PLATFORM = "single_platform"
    PER_PLATFORM_SPLIT = "per_platform_split"
    FAIL_CLOSED_NO_EVIDENCE = "fail_closed_no_evidence"
    NO_PLATFORM = "no_platform"


@dataclass(frozen=True)
class PlatformAssociation:
    """Result of the D8 platform→sample association algorithm.

    ``gpl_to_samples`` maps each attributed GPL to its (sorted) sample ids;
    ``sample_platform_evidence`` is the deterministic audit row set (sorted
    by sample_id); ``declared_platform_ids`` are the series-level GPLs.
    """

    mode: PlatformAssociationMode
    gpl_to_samples: dict[str, tuple[str, ...]]
    sample_platform_evidence: tuple[tuple[str, str], ...]
    declared_platform_ids: tuple[str, ...]


def _series_matrix_row_values(line: str) -> list[str]:
    """Split a tab-separated series_matrix metadata row into bare tokens."""
    parts = line.split("\t")
    return [part.strip().strip('"') for part in parts[1:]]


def parse_series_matrix_platform_evidence(compressed: bytes) -> dict[str, str]:
    """Extract ``GSM -> GPL`` evidence from a series_matrix gzip.

    The ``!Sample_geo_accession`` and ``!Sample_platform_id`` rows are
    per-sample columns; pairs are emitted only when both the accession
    (``GSM\\d+``) and the platform (``GPL\\d+``) are well-formed. Returns an
    empty dict when the file is not a series matrix or carries no platform
    evidence.
    """
    try:
        text = gzip.decompress(compressed).decode("utf-8", errors="replace")
    except (OSError, EOFError):
        return {}
    accessions: list[str] = []
    platforms: list[str] = []
    for line in text.splitlines():
        if line.startswith("!Sample_geo_accession"):
            accessions = _series_matrix_row_values(line)
        elif line.startswith("!Sample_platform_id"):
            platforms = _series_matrix_row_values(line)
    evidence: dict[str, str] = {}
    for accession, platform in zip(accessions, platforms, strict=False):
        if _GSM_PATTERN.fullmatch(accession) and _GPL_PATTERN.fullmatch(platform):
            evidence[accession] = platform
    return evidence


def parse_soft_platform_evidence(compressed: bytes) -> dict[str, str]:
    """Extract ``GSM -> GPL`` evidence from SOFT sample metadata.

    Each ``^SAMPLE = GSM...`` block may declare ``!Sample_platform_id =
    GPL...``. Returns an empty dict when the file is not a SOFT file or
    carries no per-sample platform declarations.
    """
    try:
        text = gzip.decompress(compressed).decode("utf-8", errors="replace")
    except (OSError, EOFError):
        return {}
    evidence: dict[str, str] = {}
    current_sample: str | None = None
    for line in text.splitlines():
        if line.startswith("^SAMPLE = "):
            current_sample = line.split("=", 1)[1].strip()
        elif current_sample is None:
            continue
        elif line.startswith("!Sample_platform_id = "):
            platform = line.split("=", 1)[1].strip().upper()
            if _GSM_PATTERN.fullmatch(current_sample) and _GPL_PATTERN.fullmatch(
                platform
            ):
                evidence[current_sample] = platform
    return evidence


def associate_platforms(
    declared_platform_ids: Sequence[str],
    sample_evidence: Mapping[str, str],
    sample_ids: Sequence[str],
) -> PlatformAssociation:
    """Associate recovered samples to GPLs per D8.

    Rules:
    * Per-sample evidence is authoritative: a sample declaring GPL X is
      attributed to X even if the series level declares otherwise.
    * One evidenced GPL for the whole series → ``SINGLE_PLATFORM``.
    * Multiple evidenced GPLs → ``PER_PLATFORM_SPLIT`` (per-sample maps).
    * No per-sample evidence:
        - exactly one declared GPL → the narrow series-level fallback
          (``SINGLE_PLATFORM`` covering the whole series);
        - several declared GPLs → ``FAIL_CLOSED_NO_EVIDENCE`` (cannot
          attribute; never "first GPL");
        - nothing declared → ``NO_PLATFORM``.
    * Samples without evidence are never attributed to a GPL (a missing
      declaration is not permission to guess).
    """
    declared = tuple(
        sorted({value.strip().upper() for value in declared_platform_ids})
    )
    sample_set = set(sample_ids)
    evidence = {
        sample_id: platform
        for sample_id, platform in sample_evidence.items()
        if sample_id in sample_set
        and _GSM_PATTERN.fullmatch(sample_id)
        and _GPL_PATTERN.fullmatch(platform)
    }

    if not declared and not evidence:
        return PlatformAssociation(
            mode=PlatformAssociationMode.NO_PLATFORM,
            gpl_to_samples={},
            sample_platform_evidence=(),
            declared_platform_ids=(),
        )

    if not evidence:
        if len(declared) == 1:
            gpl = declared[0]
            attributed = tuple(sorted(sample_set))
            return PlatformAssociation(
                mode=PlatformAssociationMode.SINGLE_PLATFORM,
                gpl_to_samples={gpl: attributed},
                sample_platform_evidence=tuple(
                    (sample_id, gpl) for sample_id in attributed
                ),
                declared_platform_ids=declared,
            )
        return PlatformAssociation(
            mode=PlatformAssociationMode.FAIL_CLOSED_NO_EVIDENCE,
            gpl_to_samples={},
            sample_platform_evidence=(),
            declared_platform_ids=declared,
        )

    grouped: dict[str, list[str]] = {}
    for sample_id, platform in evidence.items():
        grouped.setdefault(platform, []).append(sample_id)
    gpl_to_samples = {
        gpl: tuple(sorted(samples)) for gpl, samples in grouped.items()
    }
    evidence_rows = tuple(
        (sample_id, platform)
        for sample_id, platform in sorted(evidence.items())
    )
    mode = (
        PlatformAssociationMode.SINGLE_PLATFORM
        if len(gpl_to_samples) == 1
        else PlatformAssociationMode.PER_PLATFORM_SPLIT
    )
    return PlatformAssociation(
        mode=mode,
        gpl_to_samples=gpl_to_samples,
        sample_platform_evidence=evidence_rows,
        declared_platform_ids=declared,
    )
