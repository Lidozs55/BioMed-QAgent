"""Phase 5 T3: D8 platform→sample association + converged _load_geo_gene_map.

Sample-level GPL evidence comes from series-matrix ``!Sample_platform_id``
rows or SOFT sample metadata. A GPL annotation maps ONLY to samples declaring
it; multi-platform matrices split per platform or fail closed; the series-level
fallback is narrow (a single GPL declared with no contradicting evidence).
"""
from __future__ import annotations

import csv
import gzip
import hashlib
import shutil
from datetime import UTC, datetime
from pathlib import Path

import pytest
from app.datasets.contracts import AnnotationStatus
from app.domain.contracts import (
    DataLevel,
    SourceAsset,
    asset_id_from_sha256,
)
from app.domain.contracts.discovery import GeoSampleRecord, GeoSeriesRecord
from app.pipeline.processing.geo_association import (
    PlatformAssociationMode,
    associate_platforms,
    parse_series_matrix_platform_evidence,
    parse_soft_platform_evidence,
)
from app.pipeline.processing.geo_tximport import (
    parse_geo_series_matrix_samples,
    parse_geo_soft_samples,
    process_geo_series_matrix_expression,
)
from app.pipeline.stages.base import StageContext
from app.pipeline.stages.processing import _load_geo_gene_map
from app.tools.workdir import create_task_workdir

FIXTURE_DIR = Path(__file__).parents[1] / "fixtures" / "ncbi" / "gse178352"

TWO_GPL_MATRIX = """\
!Series_title\t"Synthetic two-platform series"
!Sample_geo_accession\t"GSM9000001"\t"GSM9000002"\t"GSM9000003"\t"GSM9000004"
!Sample_title\t"A rep. 1"\t"A rep. 2"\t"B rep. 1"\t"B rep. 2"
!Sample_organism_ch1\t"Homo sapiens"\t"Homo sapiens"\t"Homo sapiens"\t"Homo sapiens"
!Sample_platform_id\t"GPL90001"\t"GPL90001"\t"GPL90002"\t"GPL90002"
!Sample_characteristics_ch1\t"cell line: MCF7"\t"cell line: MCF7"\t"cell line: MCF7"\t"cell line: MCF7"
!series_matrix_table_begin
"ID_REF"\t"GSM9000001"\t"GSM9000002"\t"GSM9000003"\t"GSM9000004"
"PROBE1"\t"1.0"\t"2.0"\t"3.0"\t"4.0"
"PROBE2"\t"5.0"\t"6.0"\t"7.0"\t"8.0"
!series_matrix_table_end
"""

NO_PLATFORM_EVIDENCE_MATRIX = """\
!Series_title\t"Synthetic series without per-sample platform evidence"
!Sample_geo_accession\t"GSM9000001"\t"GSM9000002"\t"GSM9000003"\t"GSM9000004"
!Sample_title\t"A rep. 1"\t"A rep. 2"\t"B rep. 1"\t"B rep. 2"
!Sample_organism_ch1\t"Homo sapiens"\t"Homo sapiens"\t"Homo sapiens"\t"Homo sapiens"
!Sample_characteristics_ch1\t"cell line: MCF7"\t"cell line: MCF7"\t"cell line: MCF7"\t"cell line: MCF7"
!series_matrix_table_begin
"ID_REF"\t"GSM9000001"\t"GSM9000002"\t"GSM9000003"\t"GSM9000004"
"PROBE1"\t"1.0"\t"2.0"\t"3.0"\t"4.0"
!series_matrix_table_end
"""

SAMPLE_IDS = [f"GSM900000{i}" for i in range(1, 5)]


def _gzip(text: str) -> bytes:
    return gzip.compress(text.encode("utf-8"), mtime=0)


def _platform_table(gpl: str, probe_to_gene: dict[str, str]) -> str:
    rows = "\n".join(
        f"{probe}\tp-{probe}\t{gene}\t{gene} full name\tACGT"
        for probe, gene in probe_to_gene.items()
    )
    return f"""^PLATFORM = {gpl}
!Platform_title = Synthetic platform {gpl}
!Platform_table_begin
ID\tNAME\tGENE_SYMBOL\tGENE_NAME\tSEQUENCE
{rows}
!Platform_table_end
"""


def _copy_fixture(tmp_path: Path) -> Path:
    fixture = tmp_path / "fixture"
    shutil.copytree(FIXTURE_DIR, fixture)
    return fixture


def _setup(
    tmp_path: Path,
    *,
    matrix_text: str,
    platforms: dict[str, dict[str, str]],
    task_id: str = "task_assoc",
) -> tuple[StageContext, SourceAsset]:
    """Copy the shared fixture, add platform annotation assets, and write the
    synthetic series matrix into the workdir as a SourceAsset."""
    fixture = _copy_fixture(tmp_path)
    platform_dir = fixture / "platforms"
    platform_dir.mkdir(exist_ok=True)
    for gpl, probe_to_gene in platforms.items():
        (platform_dir / f"{gpl.lower()}_annot.txt.gz").write_bytes(
            _gzip(_platform_table(gpl, probe_to_gene))
        )
    workdir = create_task_workdir(task_id, base_dir=str(tmp_path / "tasks"))
    matrix_bytes = _gzip(matrix_text)
    source_path = workdir.source_assets / "GSE999999_series_matrix.txt.gz"
    source_path.write_bytes(matrix_bytes)
    checksum = hashlib.sha256(matrix_bytes).hexdigest()
    asset = SourceAsset(
        asset_id=asset_id_from_sha256(checksum),
        kind="source",
        relative_path="source_assets/GSE999999_series_matrix.txt.gz",
        sha256=checksum,
        size_bytes=len(matrix_bytes),
        media_type="application/gzip",
        source_id="src_geo_gse999999",
        successful_attempt_id="attempt_1",
        data_level=DataLevel.REPOSITORY_PROCESSED,
    )
    ctx = StageContext(
        task_id=task_id,
        workdir=workdir,
        fixture_dir=fixture,
        topic="synthetic association",
        started_at=datetime.now(UTC),
        mode="fixture",
    )
    return ctx, asset


def _geo(platform_ids: list[str]) -> GeoSeriesRecord:
    return GeoSeriesRecord(
        uid="999999",
        accession="GSE999999",
        title="synthetic two-platform series",
        sample_count=len(SAMPLE_IDS),
        platform_ids=platform_ids,
        samples=[GeoSampleRecord(accession=sid, title=sid) for sid in SAMPLE_IDS],
    )


def _read_csv(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


# --- evidence parsing -------------------------------------------------------


def test_series_matrix_platform_evidence_parses_per_sample() -> None:
    evidence = parse_series_matrix_platform_evidence(_gzip(TWO_GPL_MATRIX))
    assert evidence == {
        "GSM9000001": "GPL90001",
        "GSM9000002": "GPL90001",
        "GSM9000003": "GPL90002",
        "GSM9000004": "GPL90002",
    }


def test_soft_platform_evidence_parses_fixture() -> None:
    soft = (FIXTURE_DIR / "gse178352_family.soft.gz").read_bytes()
    evidence = parse_soft_platform_evidence(soft)
    assert len(evidence) == 12
    assert set(evidence.values()) == {"GPL24676"}


def test_series_matrix_without_platform_evidence_yields_empty() -> None:
    assert parse_series_matrix_platform_evidence(
        _gzip(NO_PLATFORM_EVIDENCE_MATRIX)
    ) == {}


# --- association algorithm (D8) ---------------------------------------------


def test_association_single_platform_all_samples_same_gpl() -> None:
    assoc = associate_platforms(
        ["GPL90001", "GPL90002"],
        {sid: "GPL90001" for sid in SAMPLE_IDS},
        SAMPLE_IDS,
    )
    assert assoc.mode is PlatformAssociationMode.SINGLE_PLATFORM
    assert assoc.gpl_to_samples == {
        "GPL90001": tuple(SAMPLE_IDS)
    }


def test_association_per_platform_split() -> None:
    evidence = parse_series_matrix_platform_evidence(_gzip(TWO_GPL_MATRIX))
    assoc = associate_platforms(["GPL90001", "GPL90002"], evidence, SAMPLE_IDS)
    assert assoc.mode is PlatformAssociationMode.PER_PLATFORM_SPLIT
    assert assoc.gpl_to_samples == {
        "GPL90001": ("GSM9000001", "GSM9000002"),
        "GPL90002": ("GSM9000003", "GSM9000004"),
    }
    # The audit evidence rows are deterministic and cover every attributed
    # sample with its declared GPL.
    assert assoc.sample_platform_evidence == (
        ("GSM9000001", "GPL90001"),
        ("GSM9000002", "GPL90001"),
        ("GSM9000003", "GPL90002"),
        ("GSM9000004", "GPL90002"),
    )


def test_association_multi_gpl_without_evidence_fails_closed() -> None:
    assoc = associate_platforms(["GPL90001", "GPL90002"], {}, SAMPLE_IDS)
    assert assoc.mode is PlatformAssociationMode.FAIL_CLOSED_NO_EVIDENCE
    assert assoc.gpl_to_samples == {}
    assert assoc.sample_platform_evidence == ()


def test_association_series_level_fallback_single_declared_gpl() -> None:
    """A single declared series-level GPL with no contradicting per-sample
    evidence is the narrow series-level fallback: the GPL covers the whole
    series."""
    assoc = associate_platforms(["GPL90001"], {}, SAMPLE_IDS)
    assert assoc.mode is PlatformAssociationMode.SINGLE_PLATFORM
    assert assoc.gpl_to_samples == {"GPL90001": tuple(SAMPLE_IDS)}


def test_association_no_platform() -> None:
    assoc = associate_platforms([], {}, [])
    assert assoc.mode is PlatformAssociationMode.NO_PLATFORM


def test_association_per_sample_evidence_wins_over_declared() -> None:
    """Per-sample evidence is authoritative: samples declaring GPL90002 are
    attributed to GPL90002 even though only GPL90001 was declared at series
    level."""
    assoc = associate_platforms(
        ["GPL90001"],
        {"GSM9000001": "GPL90001", "GSM9000003": "GPL90002"},
        SAMPLE_IDS,
    )
    assert assoc.mode is PlatformAssociationMode.PER_PLATFORM_SPLIT
    assert assoc.gpl_to_samples == {
        "GPL90001": ("GSM9000001",),
        "GPL90002": ("GSM9000003",),
    }


# --- converged _load_geo_gene_map (per-GPL PlatformRecords + sample maps) ----


def test_load_geo_gene_map_never_applies_gpl_a_to_gpl_b(tmp_path: Path) -> None:
    """A two-GPL matrix with complete per-sample evidence must produce
    per-sample gene maps: GPL90001's annotation (PROBE1→GENE_AB) is never
    applied to GPL90002 samples and vice versa. End-to-end through the
    series-matrix expression parser."""
    ctx, asset = _setup(
        tmp_path,
        matrix_text=TWO_GPL_MATRIX,
        platforms={
            "GPL90001": {"PROBE1": "GENE_AB", "PROBE2": "GENE_CD"},
            "GPL90002": {"PROBE1": "GENE_XY", "PROBE2": "GENE_ZW"},
        },
    )
    samples = parse_geo_series_matrix_samples(
        (ctx.workdir.root / asset.relative_path).read_bytes()
    )
    geo = _geo(["GPL90001", "GPL90002"])

    result = _load_geo_gene_map(ctx, geo, samples, evidence_asset=asset)

    assert result.gene_map is None  # multi-platform: no single map applies
    assert result.sample_gene_maps["GSM9000001"]["PROBE1"] == "GENE_AB"
    assert result.sample_gene_maps["GSM9000002"]["PROBE2"] == "GENE_CD"
    assert result.sample_gene_maps["GSM9000003"]["PROBE1"] == "GENE_XY"
    assert result.sample_gene_maps["GSM9000004"]["PROBE2"] == "GENE_ZW"
    assert result.probe_gene_mapping == "mapped"
    assert len(result.platform_records) == 2
    by_platform = {record.platform_id: record for record in result.platform_records}
    assert by_platform["GPL90001"].annotation_status is AnnotationStatus.MAPPED
    assert by_platform["GPL90001"].target_namespace == "gene_symbol"
    assert by_platform["GPL90001"].gene_id_field == "GENE_SYMBOL"
    assert by_platform["GPL90002"].annotation_status is AnnotationStatus.MAPPED
    assert by_platform["GPL90002"].target_namespace == "gene_symbol"
    assert by_platform["GPL90002"].annotation_sha256 is not None
    assert len(result.sample_platform_evidence) == 4

    # Parser rows: GPL A annotation must never reach GPL B samples.
    parsed = process_geo_series_matrix_expression(
        source_asset=asset,
        dataset_id="ds_geo_split",
        workdir=ctx.workdir,
        samples=samples,
        gene_map=result.gene_map,
        sample_gene_maps=result.sample_gene_maps,
        probe_gene_mapping=result.probe_gene_mapping,
    )
    assert parsed is not None
    rows = _read_csv(ctx.workdir.root / parsed.file_asset.relative_path)
    by_sample: dict[str, dict[str, tuple[str, str]]] = {}
    for row in rows:
        by_sample.setdefault(row["sample_id"], {})[row["gene_id_raw"]] = (
            row["gene_id"],
            row["gene_id_namespace"],
        )
    assert by_sample["GSM9000001"]["PROBE1"] == ("GENE_AB", "gene_symbol")
    assert by_sample["GSM9000002"]["PROBE1"] == ("GENE_AB", "gene_symbol")
    assert by_sample["GSM9000003"]["PROBE1"] == ("GENE_XY", "gene_symbol")
    assert by_sample["GSM9000004"]["PROBE1"] == ("GENE_XY", "gene_symbol")
    assert by_sample["GSM9000003"]["PROBE2"] == ("GENE_ZW", "gene_symbol")
    # No GENE_AB anywhere on GPL90002 samples, no GENE_XY on GPL90001 samples.
    assert "GENE_XY" not in {
        v[0] for v in by_sample["GSM9000001"].values()
    }
    assert "GENE_AB" not in {
        v[0] for v in by_sample["GSM9000004"].values()
    }


def test_load_geo_gene_map_multi_gpl_no_evidence_fails_closed(
    tmp_path: Path,
) -> None:
    """Two GPLs declared but zero per-sample evidence: fail closed. No map may
    be applied (no unconditional first-GPL), and every declared GPL is
    recorded as not_attempted."""
    ctx, asset = _setup(
        tmp_path,
        matrix_text=NO_PLATFORM_EVIDENCE_MATRIX,
        platforms={
            "GPL90001": {"PROBE1": "GENE_AB"},
            "GPL90002": {"PROBE1": "GENE_XY"},
        },
    )
    samples = parse_geo_series_matrix_samples(
        (ctx.workdir.root / asset.relative_path).read_bytes()
    )
    geo = _geo(["GPL90001", "GPL90002"])

    result = _load_geo_gene_map(ctx, geo, samples, evidence_asset=asset)

    assert result.gene_map is None
    assert result.sample_gene_maps is None
    assert result.probe_gene_mapping == "multi_platform_fail_closed"
    assert {r.platform_id for r in result.platform_records} == {
        "GPL90001", "GPL90002",
    }
    assert all(
        r.annotation_status is AnnotationStatus.NOT_ATTEMPTED
        for r in result.platform_records
    )
    assert result.sample_platform_evidence == ()


def test_load_geo_gene_map_single_platform_whole_series_fallback(
    tmp_path: Path,
) -> None:
    """Single declared GPL with no per-sample evidence: the series-level
    fallback applies the GPL's annotation to the whole series."""
    ctx, asset = _setup(
        tmp_path,
        matrix_text=NO_PLATFORM_EVIDENCE_MATRIX,
        platforms={"GPL90001": {"PROBE1": "GENE_AB"}},
    )
    samples = parse_geo_series_matrix_samples(
        (ctx.workdir.root / asset.relative_path).read_bytes()
    )
    geo = _geo(["GPL90001"])

    result = _load_geo_gene_map(ctx, geo, samples, evidence_asset=asset)

    assert result.gene_map == {"PROBE1": "GENE_AB"}
    assert result.probe_gene_mapping == "mapped"
    assert len(result.platform_records) == 1
    assert result.platform_records[0].platform_id == "GPL90001"
    assert result.platform_records[0].annotation_status is AnnotationStatus.MAPPED
    assert result.platform_records[0].target_namespace == "gene_symbol"


def test_load_geo_gene_map_soft_evidence_unanimous_platform(
    tmp_path: Path,
) -> None:
    """Series-level declares two GPLs but the SOFT evidence says every sample
    is GPL24676: the unanimous per-sample evidence drives single-platform
    association and per-sample maps."""
    fixture = _copy_fixture(tmp_path)
    platform_dir = fixture / "platforms"
    platform_dir.mkdir(exist_ok=True)
    (platform_dir / "gpl24676_annot.txt.gz").write_bytes(
        _gzip(_platform_table("GPL24676", {"PROBE1": "GENE_AB"}))
    )
    workdir = create_task_workdir("task_soft", base_dir=str(tmp_path / "tasks"))
    soft_bytes = (fixture / "gse178352_family.soft.gz").read_bytes()
    soft_path = workdir.source_assets / "gse178352_family.soft.gz"
    soft_path.write_bytes(soft_bytes)
    checksum = hashlib.sha256(soft_bytes).hexdigest()
    soft_asset = SourceAsset(
        asset_id=asset_id_from_sha256(checksum),
        kind="source",
        relative_path="source_assets/gse178352_family.soft.gz",
        sha256=checksum,
        size_bytes=len(soft_bytes),
        media_type="application/gzip",
        source_id="src_geo_gse178352",
        successful_attempt_id="attempt_soft",
        data_level=DataLevel.REPOSITORY_PROCESSED,
    )
    ctx = StageContext(
        task_id="task_soft",
        workdir=workdir,
        fixture_dir=fixture,
        topic="soft evidence",
        started_at=datetime.now(UTC),
        mode="fixture",
    )
    samples = parse_geo_soft_samples(soft_bytes)
    geo = _geo(["GPL24676", "GPL99999"])

    result = _load_geo_gene_map(ctx, geo, samples, evidence_asset=soft_asset)

    assert result.gene_map is None
    assert result.probe_gene_mapping == "mapped"
    assert len(result.sample_gene_maps) == len(samples)
    assert all(
        sample_map["PROBE1"] == "GENE_AB"
        for sample_map in result.sample_gene_maps.values()
    )
    # GPL24676 attempted; GPL99999 declared but unattributed → not_attempted.
    by_platform = {r.platform_id: r for r in result.platform_records}
    assert by_platform["GPL24676"].annotation_status is AnnotationStatus.MAPPED
    assert by_platform["GPL99999"].annotation_status is AnnotationStatus.NOT_ATTEMPTED
    assert len(result.sample_platform_evidence) == 12


def test_load_geo_gene_map_all_platforms_unavailable(tmp_path: Path) -> None:
    """Every declared/evidenced GPL has no annotation asset: every platform
    record is annotation_unavailable and no map is applied."""
    ctx, asset = _setup(
        tmp_path,
        matrix_text=TWO_GPL_MATRIX,
        platforms={},  # no annotation fixtures at all
    )
    samples = parse_geo_series_matrix_samples(
        (ctx.workdir.root / asset.relative_path).read_bytes()
    )
    geo = _geo(["GPL90001", "GPL90002"])

    result = _load_geo_gene_map(ctx, geo, samples, evidence_asset=asset)

    assert result.gene_map is None
    assert result.sample_gene_maps is None
    assert result.probe_gene_mapping == "annotation_unavailable"
    assert len(result.platform_records) == 2
    assert all(
        r.annotation_status is AnnotationStatus.ANNOTATION_UNAVAILABLE
        for r in result.platform_records
    )


def test_load_geo_gene_map_no_gpl_not_attempted(tmp_path: Path) -> None:
    ctx, _ = _setup(tmp_path, matrix_text=TWO_GPL_MATRIX, platforms={})
    result = _load_geo_gene_map(ctx, None, [], evidence_asset=None)
    assert result.gene_map is None
    assert result.sample_gene_maps is None
    assert result.probe_gene_mapping == "not_attempted"
    assert result.platform_records == []
    assert result.sample_platform_evidence == ()


def test_platform_records_validate_per_gpl_statuses(tmp_path: Path) -> None:
    """PlatformRecords produced by the loader satisfy the D3 cross-field
    contract (e.g. mapped ⇒ target_namespace + gene_id_field present)."""
    ctx, asset = _setup(
        tmp_path,
        matrix_text=TWO_GPL_MATRIX,
        platforms={"GPL90001": {"PROBE1": "GENE_AB"}},
    )
    samples = parse_geo_series_matrix_samples(
        (ctx.workdir.root / asset.relative_path).read_bytes()
    )
    geo = _geo(["GPL90001", "GPL90002"])
    result = _load_geo_gene_map(ctx, geo, samples, evidence_asset=asset)

    # GPL90002 has no annotation asset → annotation_unavailable.
    by_platform = {r.platform_id: r for r in result.platform_records}
    unavailable = by_platform["GPL90002"]
    assert unavailable.annotation_status is AnnotationStatus.ANNOTATION_UNAVAILABLE
    assert unavailable.annotation_sha256 is None
    # Round-trip the mapped record to prove it validates as a contract model.
    dumped = by_platform["GPL90001"].model_dump()
    from app.datasets.contracts import PlatformRecord

    restored = PlatformRecord.model_validate(dumped)
    assert restored == by_platform["GPL90001"]


# --- run_processing wiring (live mode, mocked annotation acquisition) -------


def _live_ctx(tmp_path: Path, task_id: str) -> tuple[StageContext, SourceAsset]:
    """A live-mode StageContext + series-matrix asset on the copy-dir fixture."""
    fixture = _copy_fixture(tmp_path)
    workdir = create_task_workdir(task_id, base_dir=str(tmp_path / "tasks"))
    matrix_bytes = _gzip(TWO_GPL_MATRIX)
    source_path = workdir.source_assets / "GSE999999_series_matrix.txt.gz"
    source_path.write_bytes(matrix_bytes)
    checksum = hashlib.sha256(matrix_bytes).hexdigest()
    asset = SourceAsset(
        asset_id=asset_id_from_sha256(checksum),
        kind="source",
        relative_path="source_assets/GSE999999_series_matrix.txt.gz",
        sha256=checksum,
        size_bytes=len(matrix_bytes),
        media_type="application/gzip",
        source_id="src_geo_gse999999",
        successful_attempt_id="attempt_1",
        data_level=DataLevel.REPOSITORY_PROCESSED,
    )
    ctx = StageContext(
        task_id=task_id,
        workdir=workdir,
        fixture_dir=fixture,
        topic="live two-gpl",
        started_at=datetime.now(UTC),
        mode="live",
        databases=["geo"],
    )
    return ctx, asset


def test_run_processing_live_two_gpl_applies_per_sample_maps(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """run_processing on a live two-GPL series matrix must produce per-sample
    maps (GPL A never applied to GPL B samples) and carry the platform audit
    provenance on the output."""
    from app.pipeline.processing.geo_provider import PlatformAnnotationResult
    from app.pipeline.stages.processing import run_processing

    maps = {
        "GPL90001": {"PROBE1": "GENE_AB", "PROBE2": "GENE_CD"},
        "GPL90002": {"PROBE1": "GENE_XY", "PROBE2": "GENE_ZW"},
    }

    def fake_acquire(gpl: str, **kwargs: object) -> PlatformAnnotationResult:
        table = _platform_table(gpl, maps[gpl])
        data = _gzip(table)
        return PlatformAnnotationResult(
            gene_map=maps[gpl],
            status="mapped",
            probe_column="ID",
            gene_column="GENE_SYMBOL",
            annotation_sha256=hashlib.sha256(data).hexdigest(),
            source_url=None,
        )

    monkeypatch.setattr(
        "app.pipeline.stages.processing.acquire_platform_annotation", fake_acquire
    )
    ctx, asset = _live_ctx(tmp_path, "task_live_split")
    geo = _geo(["GPL90001", "GPL90002"])

    result = run_processing(ctx, asset, "ds_geo_split", geo=geo)

    assert len(result.output.parsed_datasets) == 1
    parsed = result.output.parsed_datasets[0]
    assert parsed.processing_parameters["probe_gene_mapping"] == "mapped"
    rows = _read_csv(ctx.workdir.root / parsed.file_asset.relative_path)
    by_sample: dict[str, dict[str, str]] = {}
    for row in rows:
        by_sample.setdefault(row["sample_id"], {})[row["gene_id_raw"]] = row["gene_id"]
    assert by_sample["GSM9000001"]["PROBE1"] == "GENE_AB"
    assert by_sample["GSM9000002"]["PROBE2"] == "GENE_CD"
    assert by_sample["GSM9000003"]["PROBE1"] == "GENE_XY"
    assert by_sample["GSM9000004"]["PROBE2"] == "GENE_ZW"
    # Audit provenance flows on the processing output.
    assert len(result.output.platform_records) == 2
    assert {
        row.sample_id for row in result.output.sample_platform_evidence
    } == set(SAMPLE_IDS)


def test_artifact_build_writes_platform_audit_csvs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The artifact build stages platform_audit.csv + sample_platform_evidence.csv
    when a live GEO run produced the D8 provenance (and no such files for
    flows without it)."""
    from datetime import datetime as _datetime

    from app.domain.contracts import (
        Database as _Database,
    )
    from app.domain.contracts import (
        SourceRecord as _SourceRecord,
    )
    from app.domain.contracts import (
        TaskSpecification as _TaskSpecification,
    )
    from app.pipeline.processing.geo_provider import PlatformAnnotationResult as _PAR
    from app.pipeline.stages.artifact_build.builder import run_artifact_build
    from app.pipeline.stages.processing import run_processing

    maps = {
        "GPL90001": {"PROBE1": "GENE_AB"},
        "GPL90002": {"PROBE1": "GENE_XY"},
    }

    def fake_acquire(gpl: str, **kwargs: object) -> _PAR:
        table = _platform_table(gpl, maps[gpl])
        data = _gzip(table)
        return _PAR(
            gene_map=maps[gpl],
            status="mapped",
            probe_column="ID",
            gene_column="GENE_SYMBOL",
            annotation_sha256=hashlib.sha256(data).hexdigest(),
            source_url=None,
        )

    monkeypatch.setattr(
        "app.pipeline.stages.processing.acquire_platform_annotation", fake_acquire
    )
    ctx, asset = _live_ctx(tmp_path, "task_build_audit")
    geo = _geo(["GPL90001", "GPL90002"])
    processed = run_processing(ctx, asset, "ds_geo_split", geo=geo)
    assert processed.output.platform_records

    now = _datetime.now(UTC)
    sources = [
        _SourceRecord(
            source_id="src_geo_gse999999",
            database=_Database.GEO,
            accession="GSE999999",
            url="https://ftp.ncbi.nlm.nih.gov/geo/series/GSE999nnn/GSE999999/",
            title="synthetic",
            retrieved_at=now,
        )
    ]
    spec = _TaskSpecification(topic="audit test")
    built = run_artifact_build(
        ctx,
        sources=sources,
        source_assets=[asset],
        download_attempts=[],
        parsed_dataset=processed.output.parsed_datasets[0],
        samples=processed.output.samples,
        literature=None,
        geo=geo,
        specification=spec,
        retrieved_at=now,
        stage_attempt_id="attempt_build",
        dataset_id="ds_geo_split",
        dataset_source_id="src_geo_gse999999",
        dataset_accession="GSE999999",
        platform_records=processed.output.platform_records,
        sample_platform_evidence=processed.output.sample_platform_evidence,
    )
    staging = built.output.staging_dir
    audit = staging / "platform_audit.csv"
    evidence = staging / "sample_platform_evidence.csv"
    assert audit.is_file()
    assert evidence.is_file()
    audit_rows = _read_csv(audit)
    assert {row["platform_id"] for row in audit_rows} == {"GPL90001", "GPL90002"}
    assert all(row["annotation_status"] == "mapped" for row in audit_rows)
    assert all(row["gene_id_field"] == "GENE_SYMBOL" for row in audit_rows)
    evidence_rows = _read_csv(evidence)
    assert {row["sample_id"] for row in evidence_rows} == set(SAMPLE_IDS)
    assert {row["platform_id"] for row in evidence_rows} == {
        "GPL90001", "GPL90002",
    }
