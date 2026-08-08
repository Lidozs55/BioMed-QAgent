"""ProbeMappingSummary emission unit tests (Phase 5 T7 D3).

The probe→gene mapping module parses SOFT platform tables into a probe→gene
map, computes the D3 probe-level statistics (distinct probes, never
gene×sample rows) and emits a contract-valid ``ProbeMappingSummary`` plus the
mapping-detail audit CSV consumed by the T5 coverage policy.
"""

from __future__ import annotations

import gzip
from pathlib import Path

import pytest
from app.datasets.build.probe_mapping import (
    build_probe_mapping,
    parse_platform_table,
)
from app.datasets.contracts import (
    AnnotationStatus,
    ProbeMappingStatus,
)


def _write_annotation(path: Path, lines: list[str]) -> None:
    with gzip.open(path, "wt", encoding="utf-8") as handle:
        handle.write("\n".join(lines) + "\n")


def _write_batch(path: Path, probes: list[str]) -> None:
    """A source-long batch whose geo_probe rows carry the given probes."""
    rows = []
    for probe in probes:
        rows.append(
            "b1,gse,src,asset,"
            f"{probe},geo_probe,GSM1,expression,expression_value,"
            "log2,normalized_expression_value,1,1.5,log2_expression,"
            "f.txt,3,2,S1,1.5"
        )
    path.write_text(
        "record_id,dataset_id,source_id,asset_id,gene_id_raw,"
        "gene_id_namespace_declared,sample_id,measurement_type,value_semantics,"
        "value_scale,expression_unit,is_normalized,is_integer_expected,"
        "expression_value,source_logical_file,source_line_number,"
        "source_column_index,source_column_name,source_raw_value\n"
        + "\n".join(rows)
        + "\n",
        encoding="utf-8",
    )


def test_parse_platform_table_gene_symbol_mapping(tmp_path: Path) -> None:
    annotation = tmp_path / "GPL570_annot.txt.gz"
    _write_annotation(
        annotation,
        [
            "!platform_table_begin",
            '"ID"\t"GENE_SYMBOL"',
            '"PROBE1"\t"TP53"',
            '"PROBE2"\t"---"',
            "!platform_table_end",
        ],
    )
    mapping, target_namespace, status, ambiguous, probe_column, gene_column = (
        parse_platform_table(annotation)
    )
    assert mapping == {"PROBE1": "TP53"}
    assert target_namespace == "gene_symbol"
    assert status is ProbeMappingStatus.MAPPED
    assert ambiguous == frozenset()
    assert probe_column == "ID"
    assert gene_column == "GENE_SYMBOL"


def test_parse_platform_table_ensembl_target_namespace(tmp_path: Path) -> None:
    annotation = tmp_path / "GPL570_annot.txt.gz"
    _write_annotation(
        annotation,
        [
            "!platform_table_begin",
            '"ID"\t"ENSEMBL_ID"',
            '"PROBE1"\t"ENSG00000141510"',
            "!platform_table_end",
        ],
    )
    mapping, target_namespace, _status, _ambiguous, _probe, gene_column = (
        parse_platform_table(annotation)
    )
    assert mapping == {"PROBE1": "ENSG00000141510"}
    assert target_namespace == "ensembl_gene"
    assert gene_column == "ENSEMBL_ID"


def test_parse_platform_table_no_gene_column(tmp_path: Path) -> None:
    annotation = tmp_path / "GPL1_annot.txt.gz"
    _write_annotation(
        annotation,
        ["!platform_table_begin", '"ID"\t"DESCRIPTION"', '"PROBE1"\t"x"', "!platform_table_end"],
    )
    mapping, _target, status, _ambiguous, probe_column, gene_column = (
        parse_platform_table(annotation)
    )
    assert mapping == {}
    assert status is ProbeMappingStatus.NO_GENE_ANNOTATION
    assert probe_column == "ID"
    assert gene_column is None


def test_build_probe_mapping_partial_summary_and_audit(tmp_path: Path) -> None:
    """A partial mapping produces coverage 0.5, a contract-valid summary and
    a mapping-detail audit CSV (mapped + unmapped rows)."""
    annotation = tmp_path / "GPL570_annot.txt.gz"
    _write_annotation(
        annotation,
        [
            "!platform_table_begin",
            '"ID"\t"GENE_SYMBOL"',
            '"PROBE1"\t"TP53"',
            "!platform_table_end",
        ],
    )
    batch = tmp_path / "batch.csv"
    _write_batch(batch, ["PROBE1", "PROBE2"])
    result = build_probe_mapping(
        annotation_path=annotation,
        batch_path=batch,
        binding_id="binding_geo",
        platform_id="GPL570",
        annotation_asset=_mapping_asset(annotation),
        output_dir=tmp_path,
    )
    summary = result.summary
    assert summary.total_probe_count == 2
    assert summary.mapped_probe_count == 1
    assert summary.unmapped_probe_count == 1
    assert summary.ambiguous_probe_count == 0
    assert summary.coverage_ratio == 0.5
    assert summary.mapping_status is ProbeMappingStatus.PARTIAL
    assert summary.target_namespace == "gene_symbol"
    assert summary.mapping_asset_id == _mapping_asset(annotation).asset_id
    assert result.probe_to_gene == {"PROBE1": "TP53"}

    audit = (tmp_path / "canonical" / "binding_geo_probe_mapping.csv").read_text()
    assert "PROBE1,TP53,gene_symbol,mapped" in audit
    assert "PROBE2,,,unmapped" in audit


def test_build_probe_mapping_emits_platform_record(tmp_path: Path) -> None:
    """F4 (Phase 5 review §3): ``build_probe_mapping`` emits one D3
    ``PlatformRecord`` per GPL attempt alongside the ProbeMappingSummary —
    mapped status carries the parsed probe/gene columns and the annotation
    asset identity."""
    annotation = tmp_path / "GPL570_annot.txt.gz"
    _write_annotation(
        annotation,
        [
            "!platform_table_begin",
            '"ID"\t"GENE_SYMBOL"',
            '"PROBE1"\t"TP53"',
            '"PROBE2"\t"---"',
            "!platform_table_end",
        ],
    )
    batch = tmp_path / "batch.csv"
    _write_batch(batch, ["PROBE1", "PROBE2"])
    asset = _mapping_asset(annotation)
    result = build_probe_mapping(
        annotation_path=annotation,
        batch_path=batch,
        binding_id="binding_geo",
        platform_id="GPL570",
        annotation_asset=asset,
        output_dir=tmp_path,
    )
    record = result.platform_record
    assert record is not None
    assert record.platform_id == "GPL570"
    assert record.source_id == "src_annotation"
    assert record.annotation_status is AnnotationStatus.MAPPED
    assert record.probe_id_field == "ID"
    assert record.gene_id_field == "GENE_SYMBOL"
    assert record.target_namespace == "gene_symbol"
    assert record.annotation_asset_id == asset.asset_id
    assert record.annotation_sha256 == asset.sha256


def test_build_probe_mapping_no_gene_column_platform_record(tmp_path: Path) -> None:
    """F4: a parsed annotation without a recognized gene column emits a
    NO_GENE_ANNOTATION PlatformRecord (probe column known, gene column
    absent) — never a MAPPED record."""
    annotation = tmp_path / "GPL1_annot.txt.gz"
    _write_annotation(
        annotation,
        ["!platform_table_begin", '"ID"\t"DESCRIPTION"', '"PROBE1"\t"x"', "!platform_table_end"],
    )
    batch = tmp_path / "batch.csv"
    _write_batch(batch, ["PROBE1"])
    result = build_probe_mapping(
        annotation_path=annotation,
        batch_path=batch,
        binding_id="binding_geo",
        platform_id="GPL1",
        annotation_asset=_mapping_asset(annotation),
        output_dir=tmp_path,
    )
    record = result.platform_record
    assert record is not None
    assert record.platform_id == "GPL1"
    assert record.annotation_status is AnnotationStatus.NO_GENE_ANNOTATION
    assert record.probe_id_field == "ID"
    assert record.gene_id_field is None
    assert record.target_namespace is None
    assert record.annotation_asset_id == _mapping_asset(annotation).asset_id


def test_build_probe_mapping_zero_coverage_unmapped(tmp_path: Path) -> None:
    """An annotation that maps none of the batch's probes → unmapped, 0.0."""
    annotation = tmp_path / "GPL570_annot.txt.gz"
    _write_annotation(
        annotation,
        [
            "!platform_table_begin",
            '"ID"\t"GENE_SYMBOL"',
            '"OTHER"\t"BRCA1"',
            "!platform_table_end",
        ],
    )
    batch = tmp_path / "batch.csv"
    _write_batch(batch, ["PROBE1", "PROBE2"])
    result = build_probe_mapping(
        annotation_path=annotation,
        batch_path=batch,
        binding_id="binding_geo",
        platform_id="GPL570",
        annotation_asset=_mapping_asset(annotation),
        output_dir=tmp_path,
    )
    assert result.summary.mapping_status is ProbeMappingStatus.UNMAPPED
    assert result.summary.coverage_ratio == 0.0
    assert result.summary.mapped_probe_count == 0
    assert result.summary.unmapped_probe_count == 2


def test_build_probe_mapping_full_coverage_mapped(tmp_path: Path) -> None:
    annotation = tmp_path / "GPL570_annot.txt.gz"
    _write_annotation(
        annotation,
        [
            "!platform_table_begin",
            '"ID"\t"GENE_SYMBOL"',
            '"PROBE1"\t"TP53"',
            '"PROBE2"\t"BRCA1"',
            "!platform_table_end",
        ],
    )
    batch = tmp_path / "batch.csv"
    _write_batch(batch, ["PROBE1", "PROBE2"])
    result = build_probe_mapping(
        annotation_path=annotation,
        batch_path=batch,
        binding_id="binding_geo",
        platform_id="GPL570",
        annotation_asset=_mapping_asset(annotation),
        output_dir=tmp_path,
    )
    assert result.summary.mapping_status is ProbeMappingStatus.MAPPED
    assert result.summary.coverage_ratio == 1.0
    assert result.summary.mapped_probe_count == 2


@pytest.mark.parametrize(
    ("lines", "expected_status"),
    [
        (["!platform_table_begin", '"ID"\t"DESCRIPTION"', "!platform_table_end"],
         ProbeMappingStatus.NO_GENE_ANNOTATION),
        (["not a platform table"], ProbeMappingStatus.NO_GENE_ANNOTATION),
    ],
)
def test_parse_platform_table_fail_closed(
    tmp_path: Path, lines: list[str], expected_status: ProbeMappingStatus
) -> None:
    annotation = tmp_path / "GPL1_annot.txt.gz"
    _write_annotation(annotation, lines)
    mapping, _target, status, _ambiguous, _probe_column, _gene_column = (
        parse_platform_table(annotation)
    )
    assert mapping == {}
    assert status is expected_status


# ---------------------------------------------------------------------------
# Phase 5 final review F2/F3: mapping-asset sha invariant + ambiguous probes
# ---------------------------------------------------------------------------


def _mapping_asset(path: Path, *, wrong_sha: str | None = None) -> object:
    """A content-addressed SourceAsset for the annotation file (or one whose
    declared sha256 does NOT match the file, when ``wrong_sha`` is given)."""
    import hashlib

    from app.domain.contracts import (
        DataLevel,
        SourceAsset,
        asset_id_from_sha256,
    )

    checksum = wrong_sha if wrong_sha is not None else hashlib.sha256(
        path.read_bytes()
    ).hexdigest()
    return SourceAsset(
        asset_id=asset_id_from_sha256(checksum),
        kind="source",
        relative_path="source_assets/GPL570_annot.txt.gz",
        sha256=checksum,
        size_bytes=1,
        media_type="text/tab-separated-values",
        source_id="src_annotation",
        successful_attempt_id="attempt_1",
        data_level=DataLevel.REPOSITORY_PROCESSED,
    )


def test_build_probe_mapping_rejects_annotation_asset_sha_mismatch(
    tmp_path: Path,
) -> None:
    """F2 (D3 bidirectional invariant): when the annotation SourceAsset's
    declared sha256 does not match the file actually parsed, the mapping is
    rejected with a typed error — the summary's mapping_asset_id must never
    be recorded against a different digest."""
    import hashlib

    from app.datasets.build.errors import ProbeMappingAssetMismatchError

    annotation = tmp_path / "GPL570_annot.txt.gz"
    _write_annotation(
        annotation,
        [
            "!platform_table_begin",
            '"ID"\t"GENE_SYMBOL"',
            '"PROBE1"\t"TP53"',
            "!platform_table_end",
        ],
    )
    batch = tmp_path / "batch.csv"
    _write_batch(batch, ["PROBE1"])

    wrong_sha = hashlib.sha256(b"some other file contents").hexdigest()
    asset = _mapping_asset(annotation, wrong_sha=wrong_sha)

    with pytest.raises(ProbeMappingAssetMismatchError, match="sha256"):
        build_probe_mapping(
            annotation_path=annotation,
            batch_path=batch,
            binding_id="binding_geo",
            platform_id="GPL570",
            annotation_asset=asset,
            output_dir=tmp_path,
        )


def test_build_probe_mapping_multi_target_probe_is_ambiguous(tmp_path: Path) -> None:
    """F3 (D2): a probe mapping to two distinct genes has no explicit
    disambiguation rule → it stays geo_probe (NOT mapped), is counted in
    ambiguous_probe_count, and is excluded from coverage."""
    annotation = tmp_path / "GPL570_annot.txt.gz"
    _write_annotation(
        annotation,
        [
            "!platform_table_begin",
            '"ID"\t"GENE_SYMBOL"',
            '"PROBE1"\t"TP53"',
            '"PROBE1"\t"BRCA1"',
            '"PROBE2"\t"TP53"',
            "!platform_table_end",
        ],
    )
    batch = tmp_path / "batch.csv"
    _write_batch(batch, ["PROBE1", "PROBE2"])
    asset = _mapping_asset(annotation)
    result = build_probe_mapping(
        annotation_path=annotation,
        batch_path=batch,
        binding_id="binding_geo",
        platform_id="GPL570",
        annotation_asset=asset,
        output_dir=tmp_path,
    )

    # PROBE1 (two distinct targets) is NOT mapped; PROBE2 maps cleanly.
    assert result.probe_to_gene == {"PROBE2": "TP53"}
    summary = result.summary
    assert summary.total_probe_count == 2
    assert summary.mapped_probe_count == 1
    assert summary.unmapped_probe_count == 1
    assert summary.ambiguous_probe_count == 1
    assert summary.coverage_ratio == 0.5
    assert summary.mapping_status is ProbeMappingStatus.PARTIAL
    assert summary.mapping_asset_id == asset.asset_id

    # The audit CSV marks the ambiguous probe as ambiguous, not mapped
    # (probe_id,target_gene_id,target_namespace,status → empty,empty,ambiguous).
    audit = (tmp_path / "canonical" / "binding_geo_probe_mapping.csv").read_text()
    assert "PROBE1,,,ambiguous" in audit
    assert "PROBE2,TP53,gene_symbol,mapped" in audit


def test_build_probe_mapping_duplicate_same_target_is_not_ambiguous(
    tmp_path: Path,
) -> None:
    """F3: duplicate rows for the same probe→gene pair are NOT ambiguous —
    only probes with multiple DISTINCT targets are."""
    annotation = tmp_path / "GPL570_annot.txt.gz"
    _write_annotation(
        annotation,
        [
            "!platform_table_begin",
            '"ID"\t"GENE_SYMBOL"',
            '"PROBE1"\t"TP53"',
            '"PROBE1"\t"TP53"',
            "!platform_table_end",
        ],
    )
    batch = tmp_path / "batch.csv"
    _write_batch(batch, ["PROBE1"])
    result = build_probe_mapping(
        annotation_path=annotation,
        batch_path=batch,
        binding_id="binding_geo",
        platform_id="GPL570",
        annotation_asset=_mapping_asset(annotation),
        output_dir=tmp_path,
    )
    assert result.probe_to_gene == {"PROBE1": "TP53"}
    assert result.summary.mapped_probe_count == 1
    assert result.summary.ambiguous_probe_count == 0
    assert result.summary.coverage_ratio == 1.0
    assert result.summary.mapping_status is ProbeMappingStatus.MAPPED
