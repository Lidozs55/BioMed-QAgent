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
from app.pipeline.stages import discovery
from app.pipeline.stages.base import StageContext
from app.tools.workdir import create_task_workdir

_NCBI_FIXTURE = Path(__file__).parents[1] / "fixtures" / "ncbi" / "gse178352"
_GDC_FIXTURE = Path(__file__).parents[1] / "fixtures" / "gdc"


def _context(
    tmp_path: Path,
    specification: TaskSpecification,
    *,
    fixture_dir: Path,
) -> StageContext:
    return StageContext(
        task_id="source_coverage_test",
        workdir=create_task_workdir(
            "source_coverage_test", base_dir=str(tmp_path / "tasks")
        ),
        fixture_dir=fixture_dir,
        topic=specification.topic,
        started_at=datetime.now(UTC),
        mode="fixture",
        databases=["source_coverage"],
        specification=specification,
    )


def _query(database: Database, query: str) -> QuerySpecification:
    return QuerySpecification(
        query_id=f"query_{database.value}_1",
        database=database,
        query=query,
        generated_by="agent",
        purpose="contract test",
        order=1,
    )


def test_pubmed_geo_specification_covers_both_sources(tmp_path: Path) -> None:
    specification = TaskSpecification(
        topic="contract",
        queries=[
            _query(Database.PUBMED, "34180400[PMID]"),
            _query(Database.GEO, "GSE178352[Accession]"),
        ],
    )
    result = discovery.run_discovery(
        _context(tmp_path, specification, fixture_dir=_NCBI_FIXTURE)
    )
    assert {source.database for source in result.output.sources} == {
        Database.PUBMED,
        Database.GEO,
    }
    assert result.output.pubmed_source_id is not None
    assert result.output.geo_source_id is not None


def test_geo_only_specification_does_not_invent_literature(tmp_path: Path) -> None:
    specification = TaskSpecification(
        topic="contract",
        queries=[_query(Database.GEO, "GSE178352[Accession]")],
    )
    result = discovery.run_discovery(
        _context(tmp_path, specification, fixture_dir=_NCBI_FIXTURE)
    )
    assert [source.database for source in result.output.sources] == [Database.GEO]
    assert result.output.literature is None
    assert result.output.pubmed_source_id is None


def test_pubmed_only_specification_is_rejected_before_implicit_geo_fallback(
    tmp_path: Path,
) -> None:
    specification = TaskSpecification(
        topic="contract",
        queries=[_query(Database.PUBMED, "34180400[PMID]")],
    )
    with pytest.raises(ValueError, match="unsupported pipeline source combination"):
        discovery.run_discovery(
            _context(tmp_path, specification, fixture_dir=_NCBI_FIXTURE)
        )


def test_multiple_geo_datasets_are_rejected_before_discovery(tmp_path: Path) -> None:
    specification = TaskSpecification(
        topic="contract",
        datasets=[
            DatasetSelection(
                dataset_id=f"ds_geo_{accession.lower()}",
                database=Database.GEO,
                accession=accession,
                reason="contract test",
            )
            for accession in ("GSE178352", "GSE999999")
        ],
    )
    with pytest.raises(ValueError, match="exactly one GEO dataset"):
        discovery.run_discovery(
            _context(tmp_path, specification, fixture_dir=_NCBI_FIXTURE)
        )


def test_literature_plus_gdc_specification_is_rejected_before_discovery(
    tmp_path: Path,
) -> None:
    specification = TaskSpecification(
        topic="contract",
        queries=[_query(Database.PUBMED, "34180400[PMID]")],
        datasets=[
            DatasetSelection(
                dataset_id="ds_gdc_tcga-paad",
                database=Database.GDC,
                accession="TCGA-PAAD",
                reason="contract test",
                data_type="gene-expression",
            )
        ],
    )
    with pytest.raises(ValueError, match="unsupported pipeline source combination"):
        discovery.run_discovery(
            _context(tmp_path, specification, fixture_dir=_GDC_FIXTURE)
        )


def test_gdc_specification_covers_only_gdc_source(tmp_path: Path) -> None:
    specification = TaskSpecification(
        topic="contract",
        datasets=[
            DatasetSelection(
                dataset_id="ds_gdc_tcga-paad",
                database=Database.GDC,
                accession="TCGA-PAAD",
                reason="contract test",
                data_type="gene-expression",
            )
        ],
    )
    result = discovery.run_discovery(
        _context(tmp_path, specification, fixture_dir=_GDC_FIXTURE)
    )
    assert [source.database for source in result.output.sources] == [Database.GDC]
    assert result.output.literature is None
    assert result.output.geo is None


def test_xena_specification_covers_only_xena_source(tmp_path: Path) -> None:
    specification = TaskSpecification(
        topic="contract",
        datasets=[
            DatasetSelection(
                dataset_id="ds_ucsc_xena_matrix",
                database=Database.UCSC_XENA,
                accession="xena_matrix.tsv",
                reason="contract test",
            )
        ],
    )
    result = discovery.run_discovery(
        _context(tmp_path, specification, fixture_dir=_NCBI_FIXTURE)
    )
    assert [source.database for source in result.output.sources] == [
        Database.UCSC_XENA
    ]
    assert result.output.literature is None
    assert result.output.geo is None


def test_discovery_digest_changes_with_normalized_queries(tmp_path: Path) -> None:
    """§1.5.1: the discovery digest must cover the normalized multi-source
    query list so checkpoint reuse never treats a changed query as identical."""
    base = TaskSpecification(
        topic="contract",
        queries=[
            _query(Database.PUBMED, "34180400[PMID]"),
            _query(Database.GEO, "GSE178352[Accession]"),
        ],
    )
    changed_topic = TaskSpecification(
        topic="different topic",
        queries=[
            _query(Database.PUBMED, "34180400[PMID]"),
            _query(Database.GEO, "GSE178352[Accession]"),
        ],
    )
    changed_geo = TaskSpecification(
        topic="contract",
        queries=[
            _query(Database.PUBMED, "34180400[PMID]"),
            _query(Database.GEO, "GSE999999[Accession]"),
        ],
    )

    def digest(specification: TaskSpecification) -> str:
        result = discovery.run_discovery(
            _context(tmp_path, specification, fixture_dir=_NCBI_FIXTURE)
        )
        return result.output_digest

    base_digest = digest(base)
    assert digest(changed_geo) != base_digest
    assert digest(changed_topic) != base_digest
