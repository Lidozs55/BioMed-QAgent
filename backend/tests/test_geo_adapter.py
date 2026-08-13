"""GeoExpressionAdapter tests: tximport / series matrix / supplementary matrix.

Phase 5 T2: the ``geo.expression.v1`` adapter parses three explicit GEO
expression formats selected via typed ``AdapterParams`` (never inferred from
file names), fails closed on structure/checksum/gzip errors, audits non-finite
cells, raises a typed ``EmptySourceError`` when no valid expression rows
remain, and declares the per-row namespace
(``gene_id_namespace_declared``) plus the batch-level
``source_gene_id_namespace`` statistic.
"""

from __future__ import annotations

import csv
import gzip
import hashlib
from pathlib import Path

import pytest
from app.datasets.build.adapters import ADAPTER_REGISTRY, get_adapter
from app.datasets.build.errors import AdapterError, EmptySourceError
from app.datasets.contracts import AdapterParams, ValueScale
from app.domain.contracts import DataLevel, SourceAsset, asset_id_from_sha256

ADAPTER = get_adapter("geo.expression.v1")


def _params(
    *,
    format: str = "series_matrix",
    semantics: str = "normalized_expression_value",
    scale: ValueScale | str = ValueScale.LOG2,
    unit: str = "normalized_expression_value",
    normalized: bool = True,
    platform_ids: list[str] | None = None,
    delimiter: str = "auto",
) -> AdapterParams:
    return AdapterParams(
        format=format,  # type: ignore[arg-type]
        value_semantics=semantics,
        value_scale=scale if isinstance(scale, ValueScale) else ValueScale(scale),
        expression_unit=unit,
        is_normalized=normalized,
        platform_ids=platform_ids or [],
        delimiter=delimiter,
    )


def _asset_for_path(path: Path, source_id: str = "src_geo") -> SourceAsset:
    checksum = hashlib.sha256(path.read_bytes()).hexdigest()
    return SourceAsset(
        asset_id=asset_id_from_sha256(checksum),
        kind="source",
        relative_path=f"source_assets/{path.name}",
        sha256=checksum,
        size_bytes=path.stat().st_size,
        media_type="text/tab-separated-values",
        source_id=source_id,
        successful_attempt_id="attempt_1",
        data_level=DataLevel.REPOSITORY_PROCESSED,
    )


def _run(
    path: Path,
    params: AdapterParams,
    output_dir: Path,
    source_id: str = "src_geo",
    metadata_path: Path | None = None,
):
    return ADAPTER.parse(
        _asset_for_path(path, source_id=source_id),
        path,
        build_id="build_geo",
        binding_id="binding_geo",
        schema_ref="gene_expression.probe_long.v1",
        output_dir=output_dir,
        parameters=params,
        metadata_path=metadata_path,
    )


def _write(path: Path, text: str) -> Path:
    path.write_text(text, encoding="utf-8")
    return path


def _write_gzip(path: Path, text: str) -> Path:
    with gzip.open(path, "wt", encoding="utf-8") as handle:
        handle.write(text)
    return path


_TXIMPORT = (
    "counts.S1\tcounts.S2\n"
    "ENSG00000141510\t10\t20\n"
    "ENSG00000000003\t30\t40\n"
)

_SERIES_MATRIX = (
    "!Series_title = \"Test series\"\n"
    "!Sample_geo_accession = \"GSM1\"\t\"GSM2\"\n"
    "!series_matrix_table_begin\n"
    "\"ID_REF\"\t\"GSM1\"\t\"GSM2\"\n"
    "\"AFFX-BioB-5\"\t1.5\t2.0\n"
    "\"1007_s_at\"\t3.0\t4.0\n"
    "\"ENSG00000141510\"\t5.0\t6.0\n"
    "!series_matrix_table_end\n"
)

_SUPPLEMENTARY_CSV = (
    "probe_id,S1,S2\n"
    "AFFX-BioB-5,1.5,2.0\n"
    "1007_s_at,3.0,4.0\n"
)


# ---------------------------------------------------------------- registry


def test_geo_adapter_registry_resolves() -> None:
    """Phase 5 T2: geo.expression.v1 is a registered, resolvable adapter."""
    assert "geo.expression.v1" in ADAPTER_REGISTRY
    adapter = get_adapter("geo.expression.v1")
    assert adapter.adapter_id == "geo.expression.v1"
    assert adapter.version == "1.1.0"
    assert adapter.source_database == "geo"


def test_geo_adapter_requires_parameters(tmp_path: Path) -> None:
    """Fail closed: a GEO parse without AdapterParams is rejected."""
    path = _write(tmp_path / "counts.tsv", _TXIMPORT)
    with pytest.raises(AdapterError, match="AdapterParams"):
        ADAPTER.parse(
            _asset_for_path(path),
            path,
            build_id="build_geo",
            binding_id="binding_geo",
            schema_ref="gene_expression.probe_long.v1",
            output_dir=tmp_path,
        )
    assert not (tmp_path / "batches" / "binding_geo.csv").exists()
    assert not (tmp_path / "batches" / "binding_geo_rejected.csv").exists()


# ------------------------------------------------------------- tximport counts


def test_tximport_counts_minimal(tmp_path: Path) -> None:
    params = _params(
        format="tximport_counts",
        semantics="estimated_count",
        scale=ValueScale.LINEAR,
        unit="estimated_count",
        normalized=False,
    )
    batch = _run(_write(tmp_path / "counts.tsv", _TXIMPORT), params, tmp_path)
    assert batch.parser_id == "geo.expression.v1"
    assert batch.row_granularity == "probe_sample_measurement"
    assert batch.statistics["format"] == "tximport_counts"
    assert batch.statistics["sample_count"] == 2
    assert batch.statistics["source_row_count"] == 2
    assert batch.statistics["row_count"] == 4
    assert batch.statistics["rejected_count"] == 0
    assert batch.statistics["source_gene_id_namespace"] == "ensembl_gene"
    rows = (tmp_path / batch.file_asset.relative_path).read_text().splitlines()[1:]
    assert len(rows) == 4
    header = (tmp_path / batch.file_asset.relative_path).read_text().splitlines()[0]
    first = dict(zip(header.split(","), rows[0].split(","), strict=True))
    assert first["gene_id_raw"] == "ENSG00000141510"
    assert first["gene_id_namespace_declared"] == "ensembl_gene"
    assert first["sample_id"] == "S1"
    assert first["value_semantics"] == "estimated_count"
    assert first["value_scale"] == "linear"
    assert first["expression_unit"] == "estimated_count"
    assert first["is_normalized"] == "false"
    assert first["expression_value"] == "10"


def test_tximport_missing_counts_columns_fails_closed(tmp_path: Path) -> None:
    path = _write(
        tmp_path / "bad_counts.tsv",
        "gene\tS1\tS2\nENSG00000141510\t1\t2\n",
    )
    with pytest.raises(AdapterError, match="counts."):
        _run(path, _params(format="tximport_counts"), tmp_path)


def test_explicit_soft_metadata_must_contain_samples_matching_expression(
    tmp_path: Path,
) -> None:
    expression = _write(tmp_path / "counts.tsv", _TXIMPORT)
    empty_soft = _write(tmp_path / "empty.soft", "^SERIES = GSE1\n")

    with pytest.raises(AdapterError, match="contains no SAMPLE records"):
        _run(
            expression,
            _params(format="tximport_counts"),
            tmp_path,
            metadata_path=empty_soft,
        )

    unrelated_soft = _write(
        tmp_path / "unrelated.soft",
        "^SAMPLE = GSM999\n!Sample_title = unrelated\n",
    )
    with pytest.raises(AdapterError, match="do not match expression sample IDs"):
        _run(
            expression,
            _params(format="tximport_counts"),
            tmp_path,
            metadata_path=unrelated_soft,
        )

    matching_soft = _write(
        tmp_path / "matching.soft",
        "^SAMPLE = GSM1\n!Sample_description = Sample S1\n"
        "^SAMPLE = GSM2\n!Sample_description = Sample S2\n",
    )
    batch = _run(
        expression,
        _params(format="tximport_counts"),
        tmp_path,
        metadata_path=matching_soft,
    )
    with (
        tmp_path / batch.supporting_assets[0].relative_path
    ).open(encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))
    assert [(row["sample_id"], row["source_sample_alias"]) for row in rows] == [
        ("GSM1", "S1"),
        ("GSM2", "S2"),
    ]


# -------------------------------------------------------------- series matrix


def test_series_matrix_minimal(tmp_path: Path) -> None:
    batch = _run(
        _write_gzip(tmp_path / "GSE1_series_matrix.txt.gz", _SERIES_MATRIX),
        _params(format="series_matrix"),
        tmp_path,
    )
    assert batch.statistics["format"] == "series_matrix"
    assert batch.statistics["sample_count"] == 2
    assert batch.statistics["source_row_count"] == 3
    assert batch.statistics["row_count"] == 6
    assert batch.statistics["rejected_count"] == 0
    # AFFX-BioB-5 + 1007_s_at are probes; the ENSG row is a gene.
    assert batch.statistics["source_gene_id_namespace"] == (
        "mixed_ensembl_gene_geo_probe"
    )
    rows = (tmp_path / batch.file_asset.relative_path).read_text().splitlines()[1:]
    assert len(rows) == 6
    probe_row = next(r for r in rows if "AFFX-BioB-5" in r)
    assert ",geo_probe," in probe_row
    gene_row = next(r for r in rows if "ENSG00000141510" in r)
    assert ",ensembl_gene," in gene_row


def test_series_matrix_publishes_structured_sample_metadata_supporting_asset(
    tmp_path: Path,
) -> None:
    text = (
        '!Sample_geo_accession\t"GSM1"\t"GSM2"\n'
        '!Sample_title\t"Tumor P1"\t"Normal P1"\n'
        '!Sample_platform_id\t"GPL570"\t"GPL570"\n'
        '!Sample_characteristics_ch1\t"tissue type: tumor"\t"tissue type: normal"\n'
        '!Sample_characteristics_ch1\t"patient id: P1"\t"patient id: P1"\n'
        '!series_matrix_table_begin\n'
        '"ID_REF"\t"GSM1"\t"GSM2"\n'
        '"PROBE1"\t1.5\t2.0\n'
        '!series_matrix_table_end\n'
    )

    batch = _run(
        _write_gzip(tmp_path / "grouped.txt.gz", text),
        _params(format="series_matrix", platform_ids=["GPL570"]),
        tmp_path,
    )

    assert len(batch.supporting_assets) == 1
    support = batch.supporting_assets[0]
    assert support.relative_path == "supporting/binding_geo_sample_metadata.csv"
    with (tmp_path / support.relative_path).open(encoding="utf-8", newline="") as handle:
        rows = list(csv.DictReader(handle))
    assert [(row["sample_group"], row["pairing_id"]) for row in rows] == [
        ("tumor", "p1"),
        ("normal", "p1"),
    ]
    assert {row["group_rule_id"] for row in rows} == {"geo.sample-group.v1"}


def test_series_matrix_rejects_platform_declaration_that_conflicts_with_samples(
    tmp_path: Path,
) -> None:
    text = (
        '!Sample_platform_id\t"GPL96"\t"GPL96"\n'
        '!series_matrix_table_begin\n'
        '"ID_REF"\t"GSM1"\t"GSM2"\n'
        '"PROBE1"\t1.5\t2.0\n'
        '!series_matrix_table_end\n'
    )

    with pytest.raises(AdapterError, match="do not match"):
        _run(
            _write_gzip(tmp_path / "platform_mismatch.txt.gz", text),
            _params(format="series_matrix", platform_ids=["GPL570"]),
            tmp_path,
        )


def test_series_matrix_no_table_block_fails_closed(tmp_path: Path) -> None:
    path = _write_gzip(
        tmp_path / "no_block.txt.gz",
        "!Series_title = \"x\"\n!Sample_geo_accession = \"GSM1\"\n",
    )
    with pytest.raises(AdapterError, match="series_matrix_table_begin"):
        _run(path, _params(format="series_matrix"), tmp_path)


def test_series_matrix_duplicate_sample_headers_fail_closed(
    tmp_path: Path,
) -> None:
    text = (
        "!series_matrix_table_begin\n"
        "\"ID_REF\"\t\"GSM1\"\t\"GSM1\"\n"
        "\"AFFX-BioB-5\"\t1.5\t2.0\n"
        "!series_matrix_table_end\n"
    )
    path = _write_gzip(tmp_path / "dup.txt.gz", text)
    with pytest.raises(AdapterError, match="unique"):
        _run(path, _params(format="series_matrix"), tmp_path)


def test_series_matrix_column_width_mismatch_fails_closed(
    tmp_path: Path,
) -> None:
    text = (
        "!series_matrix_table_begin\n"
        "\"ID_REF\"\t\"GSM1\"\t\"GSM2\"\n"
        "\"AFFX-BioB-5\"\t1.5\n"  # missing a sample cell
        "!series_matrix_table_end\n"
    )
    path = _write_gzip(tmp_path / "width.txt.gz", text)
    with pytest.raises(AdapterError, match="field count"):
        _run(path, _params(format="series_matrix"), tmp_path)


def test_series_matrix_non_finite_cells_audited(tmp_path: Path) -> None:
    text = (
        "!series_matrix_table_begin\n"
        "\"ID_REF\"\t\"GSM1\"\t\"GSM2\"\n"
        "\"AFFX-BioB-5\"\t1.5\tnan\n"
        "\"1007_s_at\"\t3.0\tinf\n"
        "\"ENSG00000141510\"\t5.0\t6.0\n"
        "!series_matrix_table_end\n"
    )
    path = _write_gzip(tmp_path / "nan.txt.gz", text)
    batch = _run(path, _params(format="series_matrix"), tmp_path)
    assert batch.statistics["row_count"] == 4  # 2 valid cells survive
    assert batch.statistics["rejected_count"] == 2
    rejected = (tmp_path / "batches" / "binding_geo_rejected.csv").read_text()
    assert "non_finite_value" in rejected
    assert "nan" in rejected and "inf" in rejected


def test_series_matrix_zero_valid_rows_empty_source(tmp_path: Path) -> None:
    """Header-only matrix (or all-NA cells) is a typed EmptySourceError."""
    text = (
        "!series_matrix_table_begin\n"
        "\"ID_REF\"\t\"GSM1\"\t\"GSM2\"\n"
        "\"AFFX-BioB-5\"\tNA\tNA\n"
        "!series_matrix_table_end\n"
    )
    path = _write_gzip(tmp_path / "empty.txt.gz", text)
    with pytest.raises(EmptySourceError):
        _run(path, _params(format="series_matrix"), tmp_path)


def test_series_matrix_header_only_empty_source(tmp_path: Path) -> None:
    text = (
        "!series_matrix_table_begin\n"
        "\"ID_REF\"\t\"GSM1\"\t\"GSM2\"\n"
        "!series_matrix_table_end\n"
    )
    path = _write_gzip(tmp_path / "header_only.txt.gz", text)
    with pytest.raises(EmptySourceError):
        _run(path, _params(format="series_matrix"), tmp_path)


def test_truncated_gzip_fails_closed(tmp_path: Path) -> None:
    full = tmp_path / "full.txt.gz"
    _write_gzip(full, _SERIES_MATRIX)
    raw = full.read_bytes()
    truncated = tmp_path / "truncated.txt.gz"
    truncated.write_bytes(raw[: len(raw) // 2])
    with pytest.raises(AdapterError):
        _run(truncated, _params(format="series_matrix"), tmp_path)
    assert not (tmp_path / "batches" / "binding_geo.csv").exists()
    assert not (tmp_path / "batches" / "binding_geo_rejected.csv").exists()


# ------------------------------------------------------ supplementary matrix


def test_supplementary_matrix_minimal(tmp_path: Path) -> None:
    batch = _run(
        _write(tmp_path / "GSE1_counts.csv", _SUPPLEMENTARY_CSV),
        _params(
            format="supplementary_matrix",
            semantics="raw_count",
            scale=ValueScale.LINEAR,
            unit="counts",
            normalized=False,
        ),
        tmp_path,
    )
    assert batch.statistics["format"] == "supplementary_matrix"
    assert batch.statistics["sample_count"] == 2
    assert batch.statistics["row_count"] == 4
    assert batch.statistics["source_gene_id_namespace"] == "geo_probe"
    rows = (tmp_path / batch.file_asset.relative_path).read_text().splitlines()[1:]
    header = (tmp_path / batch.file_asset.relative_path).read_text().splitlines()[0]
    first = dict(zip(header.split(","), rows[0].split(","), strict=True))
    assert first["gene_id_raw"] == "AFFX-BioB-5"
    assert first["gene_id_namespace_declared"] == "geo_probe"
    assert first["value_semantics"] == "raw_count"
    assert first["value_scale"] == "linear"
    assert first["expression_unit"] == "counts"


def test_supplementary_explicit_delimiter(tmp_path: Path) -> None:
    text = "probe_id;S1;S2\nAFFX-BioB-5;1.5;2.0\n"
    path = _write(tmp_path / "semicolon.csv", text)
    batch = _run(
        path,
        _params(format="supplementary_matrix", delimiter=";"),
        tmp_path,
    )
    assert batch.statistics["row_count"] == 2


def test_supplementary_scale_comes_only_from_parameters(tmp_path: Path) -> None:
    """The file name never implies a scale; parameters are the only source."""
    path = _write(tmp_path / "GSE1_counts.csv", _SUPPLEMENTARY_CSV)
    log2_batch = _run(
        path,
        _params(
            format="supplementary_matrix",
            scale=ValueScale.LOG2,
            unit="log2_expression",
        ),
        tmp_path / "log2_out",
    )
    linear_batch = _run(
        path,
        _params(
            format="supplementary_matrix",
            scale=ValueScale.LINEAR,
            unit="counts",
            normalized=False,
        ),
        tmp_path / "linear_out",
    )
    log2_rows = (
        tmp_path / "log2_out" / log2_batch.file_asset.relative_path
    ).read_text().splitlines()[1:]
    linear_rows = (
        tmp_path / "linear_out" / linear_batch.file_asset.relative_path
    ).read_text().splitlines()[1:]
    assert all(",log2," in row for row in log2_rows)
    assert all(",linear," in row for row in linear_rows)


# ------------------------------------------------------------- fail-closed


def test_checksum_mismatch_fails_closed(tmp_path: Path) -> None:
    path = _write(tmp_path / "counts.tsv", _TXIMPORT)
    asset = _asset_for_path(path)
    tampered = SourceAsset(
        asset_id=asset_id_from_sha256("0" * 64),
        kind="source",
        relative_path=f"source_assets/{path.name}",
        sha256="0" * 64,
        size_bytes=asset.size_bytes,
        media_type="text/tab-separated-values",
        source_id="src_geo",
        successful_attempt_id="attempt_1",
        data_level=DataLevel.REPOSITORY_PROCESSED,
    )
    with pytest.raises(AdapterError, match="checksum"):
        ADAPTER.parse(
            tampered,
            path,
            build_id="build_geo",
            binding_id="binding_geo",
            schema_ref="gene_expression.probe_long.v1",
            output_dir=tmp_path,
            parameters=_params(format="tximport_counts"),
        )
    assert not (tmp_path / "batches").exists()


# -------------------------------------------------------- AdapterParams gates


def test_adapter_params_missing_format_rejected() -> None:
    with pytest.raises(ValueError):
        AdapterParams.model_validate(
            {
                "value_semantics": "expression",
                "value_scale": "log2",
                "expression_unit": "expression",
            }
        )


def test_adapter_params_unknown_format_rejected() -> None:
    with pytest.raises(ValueError):
        AdapterParams.model_validate(
            {
                "format": "bogus_format",
                "value_semantics": "expression",
                "value_scale": "log2",
                "expression_unit": "expression",
            }
        )


def test_adapter_params_inapplicable_delimiter_rejected() -> None:
    """delimiter outside supplementary_matrix is invalid (Phase 5 D1)."""
    with pytest.raises(Exception, match="delimiter"):
        AdapterParams.model_validate(
            {
                "format": "series_matrix",
                "value_semantics": "expression",
                "value_scale": "log2",
                "expression_unit": "expression",
                "delimiter": ";",
            }
        )
