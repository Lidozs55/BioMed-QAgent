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
from app.datasets.contracts import ProbeMappingStatus


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
    mapping, target_namespace, status = parse_platform_table(annotation)
    assert mapping == {"PROBE1": "TP53"}
    assert target_namespace == "gene_symbol"
    assert status is ProbeMappingStatus.MAPPED


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
    mapping, target_namespace, _status = parse_platform_table(annotation)
    assert mapping == {"PROBE1": "ENSG00000141510"}
    assert target_namespace == "ensembl_gene"


def test_parse_platform_table_no_gene_column(tmp_path: Path) -> None:
    annotation = tmp_path / "GPL1_annot.txt.gz"
    _write_annotation(
        annotation,
        ["!platform_table_begin", '"ID"\t"DESCRIPTION"', '"PROBE1"\t"x"', "!platform_table_end"],
    )
    mapping, _target, status = parse_platform_table(annotation)
    assert mapping == {}
    assert status is ProbeMappingStatus.NO_GENE_ANNOTATION


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
        source_asset_id="asset_mapping_abc",
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
    assert summary.mapping_asset_id == "asset_mapping_abc"
    assert result.probe_to_gene == {"PROBE1": "TP53"}

    audit = (tmp_path / "canonical" / "binding_geo_probe_mapping.csv").read_text()
    assert "PROBE1,TP53,gene_symbol,mapped" in audit
    assert "PROBE2,,,unmapped" in audit


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
        source_asset_id="asset_mapping_abc",
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
        source_asset_id="asset_mapping_abc",
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
    mapping, _target, status = parse_platform_table(annotation)
    assert mapping == {}
    assert status is expected_status
