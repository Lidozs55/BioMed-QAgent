from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from app.domain.contracts import (
    Database,
    DataLevel,
    DownloadAttempt,
    DownloadStatus,
    ErrorCode,
    FileAsset,
    SourceAsset,
    SourceLocator,
    SourceRecord,
    SourceRelation,
)
from pydantic import ValidationError

NOW = datetime(2026, 7, 12, tzinfo=UTC)
SHA256 = "ab" * 32


def test_source_and_relation_preserve_explicit_evidence() -> None:
    source = SourceRecord(
        source_id="src_article",
        database=Database.PUBMED,
        accession="34180400",
        url="https://pubmed.ncbi.nlm.nih.gov/34180400/",
        title="A paper",
        retrieved_at=NOW,
    )
    relation = SourceRelation(
        relation_id="rel_article_geo",
        from_source_id=source.source_id,
        to_source_id="src_geo",
        relation_type="article_describes_dataset",
        evidence_type="accession_in_article",
        evidence_value="GSE178352",
        evidence_url=source.url,
    )

    assert relation.evidence_value == "GSE178352"


def test_download_attempt_enforces_status_error_and_time_invariants() -> None:
    successful = DownloadAttempt(
        attempt_id="attempt_1",
        source_id="src_geo",
        url="https://example.test/counts.gz",
        status=DownloadStatus.SUCCEEDED,
        bytes_received=42,
        started_at=NOW,
        finished_at=NOW + timedelta(seconds=1),
    )
    assert successful.error_code is None

    with pytest.raises(ValidationError, match="successful download"):
        DownloadAttempt(**{
            **successful.model_dump(exclude={"schema_version"}),
            "error_code": ErrorCode.NETWORK_ERROR,
            "error_message": "unexpected",
        })
    with pytest.raises(ValidationError, match="failed download"):
        DownloadAttempt(
            attempt_id="attempt_2",
            source_id="src_geo",
            url="https://example.test/counts.gz",
            status=DownloadStatus.FAILED,
            bytes_received=0,
            started_at=NOW,
            finished_at=NOW,
        )
    with pytest.raises(ValidationError, match="finished_at"):
        DownloadAttempt(
            **successful.model_dump(exclude={"schema_version", "finished_at"}),
            finished_at=NOW - timedelta(seconds=1),
        )


@pytest.mark.parametrize(
    "relative_path",
    ["/source_assets/file.gz", "../file.gz", "source_assets/../../file.gz", "C:/file.gz"],
)
def test_file_asset_rejects_absolute_and_escaping_paths(relative_path: str) -> None:
    with pytest.raises(ValidationError, match="relative_path"):
        FileAsset(
            asset_id=f"asset_{SHA256}",
            kind="parsed",
            relative_path=relative_path,
            sha256=SHA256,
            size_bytes=1,
            media_type="text/tab-separated-values",
        )


def test_file_asset_rejects_invalid_sha256() -> None:
    with pytest.raises(ValidationError, match="sha256"):
        FileAsset(
            asset_id="asset_bad",
            kind="parsed",
            relative_path="parsed/data.tsv",
            sha256="bad",
            size_bytes=1,
            media_type="text/tab-separated-values",
        )


def test_source_asset_requires_source_kind_and_source_assets_directory() -> None:
    asset = SourceAsset(
        asset_id=f"asset_{SHA256}",
        kind="source",
        relative_path="source_assets/GSE178352_counts.txt.gz",
        sha256=SHA256,
        size_bytes=1024,
        media_type="application/gzip",
        source_id="src_geo",
        successful_attempt_id="attempt_1",
        data_level=DataLevel.REPOSITORY_PROCESSED,
    )

    assert asset.data_level is DataLevel.REPOSITORY_PROCESSED
    with pytest.raises(ValidationError):
        SourceAsset(**{**asset.model_dump(), "kind": "parsed"})
    with pytest.raises(ValidationError, match="source_assets"):
        SourceAsset(**{**asset.model_dump(), "relative_path": "parsed/counts.tsv"})


@pytest.mark.parametrize(
    "overrides",
    [
        {"source_line_number": 0},
        {"source_column_index": -1},
        {"logical_file": "../counts.txt"},
        {"raw_value": 3.14},
    ],
)
def test_source_locator_enforces_precise_physical_coordinates(overrides: dict) -> None:
    values = {
        "asset_id": f"asset_{SHA256}",
        "logical_file": "GSE178352_tximportCounts.txt",
        "source_line_number": 2,
        "source_column_index": 1,
        "source_column_name": "GSM5419701",
        "raw_value": "17.25",
    }
    values.update(overrides)

    with pytest.raises(ValidationError):
        SourceLocator(**values)
