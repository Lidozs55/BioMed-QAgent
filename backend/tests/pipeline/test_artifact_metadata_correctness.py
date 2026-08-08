"""Per-artifact metadata correctness tests for TODO §1.7 + §1.2 + §1.3.

Locks in the post-fix invariants for the artifact package:

* Every CSV artifact (14 staging files + quality_report.csv) starts with a
  UTF-8 BOM so Excel opens Chinese/UTF-8 content without garbling.
* ``run_manifest.json`` records the actual Qwen model name (not ``None``).
* ``warnings.csv`` records cell-line canonicalization corrections and its
  row count matches the ``warnings`` JSON array in ``processing_log.csv``
  (the ``warnings_metrics_consistency`` validation check).
* ``field_descriptions.csv`` carries real semantic descriptions, data types,
  units, and example values — not placeholders like ``field.replace("_", " ")``.
* ``_write_csv`` rejects rows with fields not in the column list instead of
  silently dropping them (``extrasaction="ignore"`` is forbidden).
* ``source_relations.csv`` carries a dynamic ``relation_id`` derived from the
  actual PMID/GSE pairing and supports multiple relations when the GEO series
  references multiple PMIDs (TODO §1.3).
* ``processing_log.csv`` records the real ``rows_before``/``output_refs``/
  ``parameters`` from the parsed dataset instead of hardcoded values
  (TODO §1.3).

These tests complement ``test_pinned_pipeline.py`` (which only asserts the
happy-path artifact set) by pinning the metadata correctness invariants
identified in the second-round review (TODO §1.7 + §1.2 + §1.3).
"""
from __future__ import annotations

import asyncio
import contextlib
import csv
import json
from datetime import UTC, datetime
from pathlib import Path

import pytest
from app.domain.contracts import (
    Database,
    FileAsset,
    GeoSeriesRecord,
    LiteratureRecord,
    ParsedDataset,
    SourceRecord,
    asset_id_from_sha256,
)
from app.model_config import RunModelSettings
from app.pipeline.runner import PipelineRunner
from app.pipeline.stages.artifact_build import (
    _build_source_relations as _build_source_relations_artifact,
)
from app.pipeline.stages.base import write_csv

FIXTURE_DIR = (
    Path(__file__).parents[1] / "fixtures" / "ncbi" / "gse178352"
)

# All CSV artifacts that must carry a UTF-8 BOM for Excel compatibility.
_BOM_REQUIRED_CSV_NAMES = {
    "main_data.csv",
    "literature.csv",
    "dataset_catalog.csv",
    "sample_metadata.csv",
    "field_descriptions.csv",
    "field_mapping.csv",
    "cleaning_report.csv",
    "source_list.csv",
    "source_relations.csv",
    "source_assets.csv",
    "download_log.csv",
    "processing_log.csv",
    "warnings.csv",
    "quality_report.csv",
}

# Fields in main_data.csv that must have real semantic descriptions.
_REQUIRED_FIELD_DESCRIPTIONS = {
    "record_id",
    "dataset_id",
    "source_id",
    "asset_id",
    "gene_id",
    "gene_id_namespace",
    "sample_id",
    "expression_value",
    "source_line_number",
    "source_column_index",
    "source_raw_value",
    "source_logical_file",
}


def _read_csv_sig(path: Path) -> list[dict[str, str]]:
    """Read a CSV with ``utf-8-sig`` so the BOM is stripped from the first header."""
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def _run_pinned_pipeline(tmp_path: Path) -> Path:
    """Run the GSE178352 pinned fixture pipeline and return the artifacts dir."""
    runner = PipelineRunner(
        task_id="task_metadata_correctness",
        base_dir=tmp_path / "tasks",
        fixture_dir=FIXTURE_DIR,
    )
    manifest = asyncio.run(runner.run())
    assert manifest.task_state.value == "completed", (
        f"pinned pipeline must complete successfully; got {manifest.task_state}"
    )
    return tmp_path / "tasks" / "task_metadata_correctness" / "artifacts"


# ---------------------------------------------------------------------------
# §1.7 CSV UTF-8 BOM
# ---------------------------------------------------------------------------


def test_all_artifact_csvs_have_utf8_bom(tmp_path: Path) -> None:
    """Every CSV artifact must start with ``\\xef\\xbb\\xbf`` (UTF-8 BOM).

    Without BOM, Excel on Windows opens UTF-8 CSVs with garbled Chinese
    characters — a direct scoring penalty for the competition's "结构化输出
    样例" criterion.
    """
    artifacts = _run_pinned_pipeline(tmp_path)
    produced_csvs = {
        path.name for path in artifacts.iterdir() if path.suffix == ".csv"
    }
    missing = _BOM_REQUIRED_CSV_NAMES - produced_csvs
    assert not missing, f"expected CSV artifacts missing: {missing}"

    for name in _BOM_REQUIRED_CSV_NAMES:
        path = artifacts / name
        first_bytes = path.read_bytes()[:3]
        assert first_bytes == b"\xef\xbb\xbf", (
            f"{name} must start with UTF-8 BOM (\\xef\\xbb\\xbf); "
            f"got {first_bytes!r}"
        )


# ---------------------------------------------------------------------------
# §1.7 run_manifest.json model_name
# ---------------------------------------------------------------------------


def test_run_manifest_model_name_not_none(tmp_path: Path) -> None:
    """``run_manifest.json`` must record the actual Qwen model name.

    ``model_name=None`` breaks reproducibility — judges cannot tell which
    model produced the artifacts. The manifest must read
    the standalone model snapshot default (``qwen-plus``).
    """
    artifacts = _run_pinned_pipeline(tmp_path)
    manifest_json = json.loads((artifacts / "run_manifest.json").read_text("utf-8"))
    assert manifest_json["model_name"] is not None, (
        "run_manifest.json model_name must not be None"
    )
    assert manifest_json["model_name"] == RunModelSettings.default().model_name, (
        "run_manifest.json model_name must equal the standalone model snapshot "
        f"({RunModelSettings.default().model_name!r}); "
        f"got {manifest_json['model_name']!r}"
    )


def test_run_manifest_model_name_uses_runner_snapshot(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    # Given
    import app.pipeline.stages.validation as validation_module

    monkeypatch.setattr(
        validation_module,
        "settings",
        type("Settings", (), {"model_name": "updated-global-model"})(),
        raising=False,
    )
    runner = PipelineRunner(
        task_id="task_model_snapshot",
        base_dir=tmp_path / "tasks",
        fixture_dir=FIXTURE_DIR,
        model_name="run-start-model",
    )

    # When
    manifest = asyncio.run(runner.run())

    # Then
    assert manifest.model_name == "run-start-model"
    manifest_json = json.loads(
        (
            tmp_path
            / "tasks"
            / "task_model_snapshot"
            / "artifacts"
            / "run_manifest.json"
        ).read_text("utf-8")
    )
    assert manifest_json["model_name"] == "run-start-model"


# ---------------------------------------------------------------------------
# §1.7 warnings.csv cell-line corrections
# ---------------------------------------------------------------------------


def test_warnings_csv_records_cell_line_corrections(tmp_path: Path) -> None:
    """``warnings.csv`` must record MD-MBA-231 → MDA-MB-231 corrections.

    The GSE178352 fixture ships samples with ``cell_line_raw="MD-MBA-231"``
    that are canonicalized to ``"MDA-MB-231"`` in
    ``geo_tximport._CELL_LINE_CANONICAL``. Each correction must produce one
    ``warnings.csv`` row with ``code="cell_line_normalized"`` so judges can
    audit the normalization.

    The row count must also match the ``warnings`` JSON array in
    ``processing_log.csv`` (the ``warnings_metrics_consistency`` check).
    """
    artifacts = _run_pinned_pipeline(tmp_path)
    warning_rows = _read_csv_sig(artifacts / "warnings.csv")
    cell_line_warnings = [
        row for row in warning_rows if row["code"] == "cell_line_normalized"
    ]
    # GSE178352 fixture has 3 samples with MD-MBA-231 and 3 with MD-MBA-453
    # (see _CELL_LINE_CANONICAL map in geo_tximport.py).
    assert len(cell_line_warnings) >= 2, (
        f"expected at least 2 cell_line_normalized warnings "
        f"(MD-MBA-231 and MD-MBA-453); got {len(cell_line_warnings)}"
    )
    messages = [row["message"] for row in cell_line_warnings]
    assert any("MD-MBA-231" in msg and "MDA-MB-231" in msg for msg in messages), (
        f"no warning records the MD-MBA-231 → MDA-MB-231 correction; "
        f"messages: {messages}"
    )

    # warnings_metrics_consistency: warnings.csv row count must equal the
    # total warnings recorded in processing_log.csv ``warnings`` JSON arrays.
    proc_rows = _read_csv_sig(artifacts / "processing_log.csv")
    logged_warning_count = 0
    for prow in proc_rows:
        raw = prow.get("warnings", "[]")
        with contextlib.suppress(json.JSONDecodeError, TypeError):
            logged_warning_count += len(json.loads(raw))
    assert logged_warning_count == len(warning_rows), (
        f"warnings.csv row count ({len(warning_rows)}) must equal "
        f"processing_log warnings count ({logged_warning_count})"
    )


# ---------------------------------------------------------------------------
# §1.2 field_descriptions real semantics
# ---------------------------------------------------------------------------


def test_field_descriptions_have_real_semantics(tmp_path: Path) -> None:
    """``field_descriptions.csv`` must carry real semantic descriptions.

    Before §1.2, ``description = field.replace("_", " ")`` produced
    placeholders like ``"gene id namespace"``. Each required field must now
    have a description that is NOT just the field name with underscores
    replaced by spaces.
    """
    artifacts = _run_pinned_pipeline(tmp_path)
    desc_rows = _read_csv_sig(artifacts / "field_descriptions.csv")
    desc_by_field = {row["field_name"]: row for row in desc_rows}

    missing = _REQUIRED_FIELD_DESCRIPTIONS - set(desc_by_field)
    assert not missing, f"missing field_descriptions for: {missing}"

    for field in _REQUIRED_FIELD_DESCRIPTIONS:
        row = desc_by_field[field]
        placeholder = field.replace("_", " ")
        description = row["description"]
        assert description and description != placeholder, (
            f"field {field!r} description must be a real semantic string, "
            f"not the placeholder {placeholder!r}"
        )
        # data_type must not be uniformly "string" — numeric fields should
        # declare a numeric type.
        if field in {"expression_value", "source_line_number",
                     "source_column_index", "replicate"}:
            assert row["data_type"] != "string", (
                f"field {field!r} is numeric; data_type must not be 'string'"
            )


# ---------------------------------------------------------------------------
# §1.7 extrasaction="ignore" forbidden
# ---------------------------------------------------------------------------


def test_write_csv_rejects_extra_fields(tmp_path: Path) -> None:
    """``_write_csv`` must raise on rows with fields not in the column list.

    Before §1.7, ``extrasaction="ignore"`` silently dropped extra fields,
    which masked bugs where a row dict had a typo'd key. The writer must
    now raise ``ValueError`` so typos surface immediately.
    """
    path = tmp_path / "test.csv"
    columns = ["a", "b"]
    rows = [{"a": "1", "b": "2", "typo_field": "3"}]
    with pytest.raises(ValueError, match="typo_field|extra"):
        write_csv(path, columns, rows)


# ---------------------------------------------------------------------------
# §1.3 source_relations dynamic relation_id + multi-relation support
# ---------------------------------------------------------------------------


def test_source_relations_relation_id_derived_from_pmid_and_gse(
    tmp_path: Path,
) -> None:
    """``source_relations.csv`` ``relation_id`` must be derived from actual
    PMID/GSE pairing, not hardcoded (TODO §1.3).

    Before §1.3, ``relation_id`` was always ``"rel_pmid34180400_gse178352"``
    regardless of which PMID/GSE the pipeline actually processed. After §1.3,
    the ID is derived from ``literature.pmid`` and ``geo.accession`` so a
    different pairing produces a different ID.
    """
    artifacts = _run_pinned_pipeline(tmp_path)
    relation_rows = _read_csv_sig(artifacts / "source_relations.csv")
    assert len(relation_rows) >= 1, "source_relations.csv must have ≥1 row"

    literature = _read_csv_sig(artifacts / "literature.csv")
    catalog = _read_csv_sig(artifacts / "dataset_catalog.csv")
    pmid = literature[0]["pmid"]
    accession = catalog[0]["accession"]
    expected_relation_id = f"rel_pmid{pmid}_{accession.lower()}"

    # Phase 5 T6 (D3): bidirectional rows — find the forward edge by type
    # (rows are sorted by the dedup key, not by semantic direction).
    forward = next(
        row for row in relation_rows if row["relation_type"] == "article_describes_dataset"
    )
    assert forward["relation_id"] == expected_relation_id, (
        f"relation_id must be derived from PMID/GSE; "
        f"expected {expected_relation_id!r}, got {forward['relation_id']!r}"
    )
    assert forward["evidence_value"] == pmid, (
        f"evidence_value must be the actual PMID ({pmid!r}); "
        f"got {forward['evidence_value']!r}"
    )
    # The inverse edge exists with a distinct relation_id.
    inverse = next(
        row for row in relation_rows if row["relation_type"] == "dataset_described_by_article"
    )
    assert inverse["relation_id"] != forward["relation_id"]


def test_source_relations_supports_multiple_pubmed_ids() -> None:
    """``_build_source_relations`` must emit one row per referenced PMID.

    When ``geo.pubmed_ids`` carries additional PMIDs beyond the primary
    ``literature.pmid``, each extra PMID yields a ``geo_references_pubmed``
    row whose ``to_source_id`` is ``ext:pubmed:<pmid>`` so the citation
    graph is preserved without polluting ``source_list.csv`` with sources
    the pipeline never acquired (TODO §1.3).
    """
    pubmed_source_id = "src_pubmed_34180400"
    geo_source_id = "src_geo_gse178352"
    geo_url = "https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc=GSE178352"
    sources = [
        SourceRecord(
            source_id=pubmed_source_id,
            database=Database.PUBMED,
            accession="34180400",
            url="https://pubmed.ncbi.nlm.nih.gov/34180400/",
            title="Primary article",
            retrieved_at=datetime.now(UTC),
        ),
        SourceRecord(
            source_id=geo_source_id,
            database=Database.GEO,
            accession="GSE178352",
            url=geo_url,
            title="GSE178352 series",
            retrieved_at=datetime.now(UTC),
        ),
    ]
    literature = LiteratureRecord(
        pmid="34180400",
        pmcid=None,
        doi=None,
        title="Primary article",
        authors=[],
        journal="",
        published_at=None,
        abstract="",
        source_url="https://pubmed.ncbi.nlm.nih.gov/34180400/",
    )
    geo = GeoSeriesRecord(
        uid="200178352",
        accession="GSE178352",
        title="GSE178352 series",
        summary="",
        organism="Homo sapiens",
        experiment_type="Expression profiling by high throughput sequencing",
        sample_count=0,
        samples=[],
        platform_ids=["GPL24676"],
        pubmed_ids=["34180400", "12345678", "87654321"],
        bioproject=None,
        ftp_root="",
    )

    relations = _build_source_relations_artifact(
        sources=sources,
        literature=literature,
        geo=geo,
        geo_url=geo_url,
    )

    # Phase 5 T6 (D3): every evidenced GSE×PMID pair yields TWO rows (forward
    # + inverse). 1 primary + 2 extra PMIDs = 3 pairs = 6 rows.
    assert len(relations) == 6, (
        f"expected 6 relations (2 per pair x 3 evidenced pairs); "
        f"got {len(relations)}"
    )

    # Primary relation: PubMed → GEO with article_describes_dataset.
    primary = next(
        row for row in relations if row["relation_type"] == "article_describes_dataset"
    )
    assert primary["relation_id"] == "rel_pmid34180400_gse178352"
    assert primary["from_source_id"] == pubmed_source_id
    assert primary["to_source_id"] == geo_source_id
    assert primary["evidence_value"] == "34180400"

    # Primary inverse: GEO → PubMed with dataset_described_by_article.
    inverse = next(
        row for row in relations if row["relation_type"] == "dataset_described_by_article"
    )
    assert inverse["from_source_id"] == geo_source_id
    assert inverse["to_source_id"] == pubmed_source_id
    assert inverse["evidence_value"] == "34180400"

    # Extra PMIDs: GEO → ext:pubmed:<pmid> with geo_references_pubmed,
    # plus the inverse ext:pubmed:<pmid> -> GEO.
    extras = [row for row in relations if row["relation_type"] == "geo_references_pubmed"]
    assert len(extras) == 2
    assert {row["to_source_id"] for row in extras} == {
        "ext:pubmed:12345678",
        "ext:pubmed:87654321",
    }
    for row in extras:
        assert row["from_source_id"] == geo_source_id
        assert row["evidence_type"] == "geo_pubmed_id"
    external_inverses = [
        row for row in relations if row["relation_type"] == "pubmed_referenced_by_geo"
    ]
    assert len(external_inverses) == 2
    assert {row["from_source_id"] for row in external_inverses} == {
        "ext:pubmed:12345678",
        "ext:pubmed:87654321",
    }
    for row in external_inverses:
        assert row["to_source_id"] == geo_source_id
        assert row["evidence_type"] == "geo_pubmed_id"


def test_source_relations_returns_empty_when_sources_missing() -> None:
    """``_build_source_relations`` must return [] when no PubMed or GEO source."""
    geo_url = "https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc=GSE178352"
    literature = LiteratureRecord(
        pmid="34180400",
        pmcid=None,
        doi=None,
        title="Primary article",
        authors=[],
        journal="",
        published_at=None,
        abstract="",
        source_url="https://pubmed.ncbi.nlm.nih.gov/34180400/",
    )
    geo = GeoSeriesRecord(
        uid="200178352",
        accession="GSE178352",
        title="",
        summary="",
        organism="",
        experiment_type="",
        sample_count=0,
        samples=[],
        pubmed_ids=["34180400"],
    )
    # Only PubMed source — no GEO source.
    sources = [
        SourceRecord(
            source_id="src_pubmed_34180400",
            database=Database.PUBMED,
            accession="34180400",
            url="https://pubmed.ncbi.nlm.nih.gov/34180400/",
            title="Primary article",
            retrieved_at=datetime.now(UTC),
        ),
    ]
    relations = _build_source_relations_artifact(
        sources=sources,
        literature=literature,
        geo=geo,
        geo_url=geo_url,
    )
    assert relations == [], (
        "expected no relations when GEO source is missing"
    )


def test_source_relations_omit_unsubstantiated_article_dataset_link() -> None:
    retrieved_at = datetime.now(UTC)
    literature = LiteratureRecord(
        pmid="99999999",
        title="Unrelated article",
        authors=[],
        journal="",
        abstract="",
        source_url="https://pubmed.ncbi.nlm.nih.gov/99999999/",
    )
    geo = GeoSeriesRecord(
        uid="200178352",
        accession="GSE178352",
        title="GSE178352 series",
        summary="",
        organism="Homo sapiens",
        experiment_type="Expression profiling by high throughput sequencing",
        sample_count=0,
        samples=[],
        pubmed_ids=[],
    )
    geo_url = "https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc=GSE178352"
    sources = [
        SourceRecord(
            source_id="src_pubmed_unrelated",
            database=Database.PUBMED,
            accession=literature.pmid,
            url=literature.source_url,
            title=literature.title,
            retrieved_at=retrieved_at,
        ),
        SourceRecord(
            source_id="src_geo_gse178352",
            database=Database.GEO,
            accession=geo.accession,
            url=geo_url,
            title=geo.title,
            retrieved_at=retrieved_at,
        ),
    ]

    relations = _build_source_relations_artifact(
        sources=sources,
        literature=literature,
        geo=geo,
        geo_url=geo_url,
    )

    assert relations == []


# ---------------------------------------------------------------------------
# §1.3 processing_log rows_before / output_refs / parameters
# ---------------------------------------------------------------------------


def test_processing_log_rows_before_reflects_real_source_row_count(
    tmp_path: Path,
) -> None:
    """``processing_log.csv`` ``rows_before`` must reflect the real source
    file's data-row count, not a hardcoded ``4`` (TODO §1.3).

    The GSE178352 fixture ships a 4-gene × 12-sample matrix, so
    ``rows_before == 4`` and ``rows_after == 48``. The relationship
    ``rows_after == rows_before * sample_count`` must hold for any
    tximport matrix.
    """
    artifacts = _run_pinned_pipeline(tmp_path)
    proc_rows = _read_csv_sig(artifacts / "processing_log.csv")
    assert len(proc_rows) == 1
    proc = proc_rows[0]

    rows_before = int(proc["rows_before"])
    rows_after = int(proc["rows_after"])
    sample_rows = _read_csv_sig(artifacts / "sample_metadata.csv")
    sample_count = len(sample_rows)

    # rows_before must be the source file's gene-row count, NOT a hardcoded 4
    # that happens to match the fixture. The tximport invariant is:
    # rows_after = rows_before * sample_count.
    assert rows_before > 0, "rows_before must be > 0 for a real expression matrix"
    assert rows_after == rows_before * sample_count, (
        f"tximport invariant violated: rows_after ({rows_after}) must equal "
        f"rows_before ({rows_before}) * sample_count ({sample_count})"
    )


def test_processing_log_output_refs_differs_from_input_refs(
    tmp_path: Path,
) -> None:
    """``processing_log.csv`` ``output_refs`` must point at the parsed
    artifact, not the source asset (TODO §1.3).

    Before §1.3, both ``input_refs`` and ``output_refs`` were
    ``[source_asset.asset_id]``, falsely implying the parser produced no
    new artifact. After §1.3, ``input_refs`` points at the source asset
    and ``output_refs`` points at the parsed dataset's ``file_asset``.
    """
    artifacts = _run_pinned_pipeline(tmp_path)
    proc_rows = _read_csv_sig(artifacts / "processing_log.csv")
    assert len(proc_rows) == 1
    proc = proc_rows[0]

    input_refs = json.loads(proc["input_refs"])
    output_refs = json.loads(proc["output_refs"])

    assert len(input_refs) == 1 and len(output_refs) == 1, (
        "input_refs/output_refs must each carry exactly one asset id"
    )
    assert input_refs != output_refs, (
        "output_refs must differ from input_refs — the parser must produce "
        "a new artifact; before §1.3 both were [source_asset.asset_id]"
    )

    # input_refs must equal the source asset's asset_id (the raw download).
    asset_rows = _read_csv_sig(artifacts / "source_assets.csv")
    source_asset_ids = {row["asset_id"] for row in asset_rows}
    assert input_refs[0] in source_asset_ids, (
        f"input_refs ({input_refs[0]!r}) must reference a source_assets.csv row"
    )

    # output_refs must NOT be in source_assets.csv — it's the parsed
    # dataset's file_asset, which is copied into main_data.csv at the
    # staging step but never registered as a SourceAsset.
    assert output_refs[0] not in source_asset_ids, (
        "output_refs must NOT be a source asset id — it must be the parsed "
        "dataset's file_asset id"
    )


def test_processing_log_parameters_reflects_real_processing_config(
    tmp_path: Path,
) -> None:
    """``processing_log.csv`` ``parameters`` must carry the real parser
    configuration, not a hardcoded ``{"measurement": "counts"}`` (TODO §1.3).

    After §1.3, the parser surfaces ``measurement_type`` / ``value_semantics``
    / ``sample_count`` / ``source_logical_file`` / ``gene_id_namespace`` so
    judges can audit the actual processing configuration.
    """
    artifacts = _run_pinned_pipeline(tmp_path)
    proc_rows = _read_csv_sig(artifacts / "processing_log.csv")
    assert len(proc_rows) == 1
    proc = proc_rows[0]

    parameters = json.loads(proc["parameters"])

    # The hardcoded placeholder must be gone.
    assert parameters != {"measurement": "counts"}, (
        "parameters must not be the hardcoded {'measurement': 'counts'} placeholder"
    )

    # Real semantic fields must be present.
    required_keys = {
        "measurement_type",
        "value_semantics",
        "value_scale",
        "is_normalized",
        "sample_count",
        "source_logical_file",
        "gene_id_namespace",
    }
    missing = required_keys - set(parameters)
    assert not missing, f"parameters missing required keys: {missing}"

    assert parameters["measurement_type"] == "tximport_estimated_count"
    assert parameters["value_semantics"] == "estimated_count"
    assert parameters["value_scale"] == "linear"
    assert parameters["is_normalized"] is False
    assert parameters["sample_count"] == 12
    assert parameters["source_logical_file"] == "GSE178352_tximportCounts.txt"
    assert parameters["gene_id_namespace"] == "ensembl_gene"


def test_parsed_dataset_carries_source_row_count_and_parameters(
    tmp_path: Path,
) -> None:
    """``ParsedDataset`` must carry ``source_row_count`` and
    ``processing_parameters`` populated by the parser (TODO §1.3).

    Verifies the contract-level extension independently of the E2E pipeline
    so a regression in either field surfaces as a focused unit-test failure
    rather than a downstream processing_log mismatch.
    """
    sha256 = "a" * 64
    parsed = ParsedDataset(
        dataset_id="ds_gse_test",
        source_id="src_geo_gse_test",
        source_asset_id="asset_source_test",
        file_asset=FileAsset(
            asset_id=asset_id_from_sha256(sha256),
            kind="parsed",
            relative_path="parsed/ds_gse_test_tximport_long.csv",
            sha256=sha256,
            size_bytes=1024,
            media_type="text/csv",
            generated_by_step_id="step_test",
        ),
        columns=["record_id", "expression_value"],
        row_count=48,
        parser_name="geo_tximport_counts",
        parser_version="1.0.0",
        source_row_count=4,
        processing_parameters={
            "measurement_type": "tximport_estimated_count",
            "sample_count": 12,
        },
    )
    assert parsed.source_row_count == 4
    assert parsed.processing_parameters["measurement_type"] == (
        "tximport_estimated_count"
    )
    assert parsed.processing_parameters["sample_count"] == 12
