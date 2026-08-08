"""Phase 5 T6 D7 red tests: accession helpers must raise, not truncate.

``_resolve_gse`` and the ``_extract_gse_accession`` helpers historically
returned the FIRST match only (silent truncation). Phase 5 D7 requires:

* ``finditer``/``findall`` over the whole input, dedup preserving
  first-occurrence order;
* 0 accessions -> unchanged None/error behaviour;
* 1 accession -> returned;
* >1 accessions -> explicit ``ValueError`` listing ALL accessions;
* the resolver checks the FULL candidate set across query and dataset
  selections (query GSE1 + dataset GSE2 must also raise).

These tests are red against the current first-match implementation.
"""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

import pytest
from app.domain.contracts import (
    Database,
    DatasetSelection,
    QuerySpecification,
    TaskSpecification,
)
from app.pipeline.stages import acquisition, discovery
from app.pipeline.stages.base import StageContext
from app.tools.workdir import create_task_workdir

_NCBI_FIXTURE = Path(__file__).parents[1] / "fixtures" / "ncbi" / "gse178352"


def _query(database: Database, query: str) -> QuerySpecification:
    return QuerySpecification(
        query_id=f"query_{database.value}_1",
        database=database,
        query=query,
        generated_by="agent",
        purpose="contract test",
        order=1,
    )


def _geo_dataset(accession: str) -> DatasetSelection:
    return DatasetSelection(
        dataset_id=f"ds_geo_{accession.lower()}",
        database=Database.GEO,
        accession=accession,
        source_id="",
        reason="contract test",
    )


# ---------------------------------------------------------------------------
# shared extract_gse_accessions / extract_gse_accession helpers (D7)
# ---------------------------------------------------------------------------


def test_extract_gse_accessions_returns_all_in_first_occurrence_order() -> None:
    """A string carrying several accessions must yield ALL of them, ordered
    by first occurrence — never just the first match."""
    from app.pipeline.processing.geo_accession import extract_gse_accessions

    assert extract_gse_accessions("GSE1 and GSE2 both appear") == [
        "GSE1",
        "GSE2",
    ]


def test_extract_gse_accession_single_value_is_unchanged() -> None:
    """A single accession still returns that accession (no regression)."""
    from app.pipeline.processing.geo_accession import extract_gse_accession

    assert extract_gse_accession("GSE178352[Accession]") == "GSE178352"


def test_extract_gse_accession_multiple_raises_listing_all() -> None:
    """>1 distinct accessions in one string must raise a ValueError that
    lists EVERY accession, with a hint to split into multiple V2 builds."""
    from app.pipeline.processing.geo_accession import extract_gse_accession

    with pytest.raises(ValueError) as excinfo:
        extract_gse_accession("GSE111111,GSE222222")
    message = str(excinfo.value)
    assert "GSE111111" in message
    assert "GSE222222" in message


def test_extract_gse_accessions_dedupes_preserving_first_occurrence() -> None:
    """Duplicate occurrences of the same accession collapse to one entry,
    keeping the FIRST occurrence position."""
    from app.pipeline.processing.geo_accession import (
        extract_gse_accession,
        extract_gse_accessions,
    )

    assert extract_gse_accessions("GSE5 GSE3 GSE5 GSE3") == ["GSE5", "GSE3"]
    # A repeated single accession is still a single accession (no raise).
    assert extract_gse_accession("GSE5 GSE5") == "GSE5"


def test_extract_gse_accessions_empty_returns_none() -> None:
    """No accession -> None, preserving the historical no-match behaviour."""
    from app.pipeline.processing.geo_accession import extract_gse_accession

    assert extract_gse_accession("no accession here") is None


def test_extract_gse_accession_lowercase_is_uppercased() -> None:
    from app.pipeline.processing.geo_accession import extract_gse_accession

    assert extract_gse_accession("gse178352[Accession]") == "GSE178352"


# ---------------------------------------------------------------------------
# discovery resolver: full candidate set across queries and datasets (D7)
# ---------------------------------------------------------------------------


def test_resolve_gse_raises_when_query_and_dataset_differ() -> None:
    """query GSE1 + dataset GSE2 must raise — the resolver must consider the
    WHOLE candidate set, not stop at the first query match."""
    specification = TaskSpecification(
        topic="contract",
        queries=[_query(Database.GEO, "GSE111111[Accession]")],
        datasets=[_geo_dataset("GSE222222")],
    )
    with pytest.raises(ValueError) as excinfo:
        discovery._resolve_gse(specification)
    message = str(excinfo.value)
    assert "GSE111111" in message
    assert "GSE222222" in message


def test_resolve_gse_raises_when_query_string_has_two_accessions() -> None:
    """A single query whose string embeds two accessions must raise before
    any first-match truncation."""
    specification = TaskSpecification(
        topic="contract",
        queries=[_query(Database.GEO, "GSE111111,GSE222222")],
    )
    with pytest.raises(ValueError) as excinfo:
        discovery._resolve_gse(specification)
    message = str(excinfo.value)
    assert "GSE111111" in message
    assert "GSE222222" in message


def test_resolve_gse_single_candidate_unchanged() -> None:
    specification = TaskSpecification(
        topic="contract",
        queries=[_query(Database.GEO, "GSE178352[Accession]")],
        datasets=[_geo_dataset("GSE178352")],
    )
    assert discovery._resolve_gse(specification) == "GSE178352"


def test_resolve_gse_no_candidate_returns_none() -> None:
    specification = TaskSpecification(
        topic="contract",
        queries=[_query(Database.PUBMED, "34180400[PMID]")],
    )
    assert discovery._resolve_gse(specification) is None


def test_run_discovery_raises_on_query_dataset_accession_split(
    tmp_path: Path,
) -> None:
    """run_discovery surfaces the D7 raise: the ≤1 GEO query/dataset check
    permits one query + one dataset, but differing accessions must still
    raise before discovery runs."""
    specification = TaskSpecification(
        topic="contract",
        queries=[_query(Database.GEO, "GSE111111[Accession]")],
        datasets=[_geo_dataset("GSE222222")],
    )
    ctx = StageContext(
        task_id="d7_split_test",
        workdir=create_task_workdir(
            "d7_split_test", base_dir=str(tmp_path / "tasks")
        ),
        fixture_dir=_NCBI_FIXTURE,
        topic=specification.topic,
        started_at=datetime.now(UTC),
        mode="fixture",
        databases=["d7_split_test"],
        specification=specification,
    )
    with pytest.raises(ValueError) as excinfo:
        discovery.run_discovery(ctx)
    message = str(excinfo.value)
    assert "GSE111111" in message
    assert "GSE222222" in message


# ---------------------------------------------------------------------------
# acquisition helper: same raise-not-truncate semantics (D7)
# ---------------------------------------------------------------------------


def test_acquisition_extract_gse_accession_multiple_raises() -> None:
    """The acquisition helper must not silently take the first accession."""
    with pytest.raises(ValueError) as excinfo:
        acquisition._extract_gse_accession("GSE111111,GSE222222")
    message = str(excinfo.value)
    assert "GSE111111" in message
    assert "GSE222222" in message


def test_acquisition_extract_gse_accession_single_unchanged() -> None:
    assert acquisition._extract_gse_accession("GSE178352") == "GSE178352"
    assert acquisition._extract_gse_accession("GSE178352[Accession]") == "GSE178352"


def test_acquisition_extract_gse_accession_none_when_missing() -> None:
    assert acquisition._extract_gse_accession("nothing here") is None
