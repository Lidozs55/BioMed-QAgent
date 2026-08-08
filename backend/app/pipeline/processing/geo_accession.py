"""Shared GEO accession extraction (Phase 5 D7: raise-not-truncate).

Both the discovery resolver and the acquisition helper previously returned
the FIRST ``GSE\\d+`` match only — silently truncating inputs that carried
more than one accession. D7 unifies them on this module:

* ``extract_gse_accessions`` scans the WHOLE input with ``finditer``,
  uppercases, and dedupes preserving first-occurrence order;
* ``extract_gse_accession`` returns the single accession (or ``None`` when
  none exists) and raises an explicit ``ValueError`` listing ALL accessions
  when more than one distinct accession is found — with a hint that the
  caller should split into multiple V2 builds (one ``DatasetBuildSpec`` per
  GSE).

``_validate_pipeline_source_specification``'s "at most one GEO
query/dataset" rule remains in place; it does NOT replace the in-string
multi-accession detection performed here.
"""

from __future__ import annotations

import re

_GSE_ACCESSION_RE = re.compile(r"(GSE\d+)(?:\[Accession\])?", re.IGNORECASE)

#: Shared hint appended to every multi-GSE ValueError so the caller knows the
#: sanctioned path is one DatasetBuildSpec per GSE (Phase 5 D6 orchestrator).
MULTI_GSE_SPLIT_HINT = (
    "pipeline supports exactly one GEO dataset per run; split the "
    "accessions into multiple V2 builds (one DatasetBuildSpec per GSE)"
)


def extract_gse_accessions(value: str) -> list[str]:
    """Return all distinct GSE accessions in first-occurrence order.

    Accessions are uppercased (``gse178352`` -> ``GSE178352``); repeated
    occurrences of the same accession collapse to the first occurrence
    position. An input without any accession yields ``[]``.
    """
    accessions: list[str] = []
    seen: set[str] = set()
    for match in _GSE_ACCESSION_RE.finditer(value):
        accession = match.group(1).upper()
        if accession not in seen:
            seen.add(accession)
            accessions.append(accession)
    return accessions


def extract_gse_accession(value: str) -> str | None:
    """Return the single GSE accession, or None when none exists.

    Raises ``ValueError`` (listing every accession) when the input contains
    MORE than one distinct accession — the historical first-match
    truncation is a silent data loss bug and must fail closed instead.
    """
    accessions = extract_gse_accessions(value)
    if len(accessions) <= 1:
        return accessions[0] if accessions else None
    raise ValueError(
        "multiple GEO accessions found in one selection: "
        + ", ".join(accessions)
        + f"; {MULTI_GSE_SPLIT_HINT}"
    )
