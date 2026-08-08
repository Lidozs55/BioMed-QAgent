"""Canonicalizer tests: namespace authorization, unit policy, audits."""

from __future__ import annotations

import csv
import hashlib
from pathlib import Path

from app.datasets.build.adapters import GdcExpressionAdapter, XenaMatrixAdapter
from app.datasets.build.canonicalizer import (
    CanonicalizationResult,
    authorize_namespace,
    canonicalize,
)
from app.datasets.build.gene_maps import SYMBOL_TO_ENSEMBL
from app.datasets.build.profiles import _expression_normalization_v1
from app.datasets.contracts import NormalizationProfile
from app.datasets.schema_registry import build_gene_expression_schema
from app.domain.contracts import DataLevel, SourceAsset, asset_id_from_sha256, make_record_id

FIXTURES = Path(__file__).parent / "fixtures"


def _source_asset(relative_path: str) -> SourceAsset:
    path = FIXTURES / relative_path
    checksum = hashlib.sha256(path.read_bytes()).hexdigest()
    return SourceAsset(
        asset_id=asset_id_from_sha256(checksum),
        kind="source",
        relative_path=f"source_assets/{relative_path}",
        sha256=checksum,
        size_bytes=path.stat().st_size,
        media_type="text/tab-separated-values",
        source_id="src_test",
        successful_attempt_id="attempt_1",
        data_level=DataLevel.REPOSITORY_PROCESSED,
    )


def _canonicalize(
    fixture: str,
    adapter,
    tmp_path: Path,
    *,
    gene_symbol_map: dict[str, str] | None = None,
) -> CanonicalizationResult:
    asset = _source_asset(fixture)
    batch = adapter.parse(
        asset,
        FIXTURES / fixture,
        build_id="build_test",
        binding_id="binding_1",
        schema_ref="gene_expression.long.v1",
        output_dir=tmp_path,
    )
    return canonicalize(
        batch=batch,
        schema=build_gene_expression_schema(),
        profile=_expression_normalization_v1(),
        output_dir=tmp_path,
        gene_symbol_map=gene_symbol_map,
    )


def test_authorize_namespace_rules() -> None:
    assert authorize_namespace("ENSG00000141510") == (
        "ENSG00000141510", "ensembl_gene", "",
    )
    assert authorize_namespace("ENSG00000141510.17") == (
        "ENSG00000141510", "ensembl_gene", "17",
    )
    assert authorize_namespace("TP53") == ("TP53", "gene_symbol", "")
    assert authorize_namespace("BRCA1") == ("BRCA1", "gene_symbol", "")
    assert authorize_namespace("1007_s_at") is None
    assert authorize_namespace("") is None


def test_probe_id_misclassified_by_symbol_regex_is_regression_target() -> None:
    """GEO probe IDs must not be authorized as ``gene_symbol`` by shape alone.

    ``authorize_namespace`` (canonicalizer.py:88-96) currently treats any
    alphanumeric token starting with a letter as ``gene_symbol``, so a probe
    like ``AFFX-BioB-5`` is misclassified into the gene contract (and a
    numeric probe like ``1007_s_at`` is wrongly rejected instead of being
    declared ``geo_probe``).  T2 replaces the shape heuristic with the
    adapter-declared ``gene_id_namespace_declared`` source-long column; this
    test pins the bug until that fix lands.
    """
    assert authorize_namespace("AFFX-BioB-5") is None
    assert authorize_namespace("1007_s_at") is None


def test_canonical_matrix_rows(tmp_path: Path) -> None:
    result = _canonicalize(
        "gdc/gdc_expression.tsv", GdcExpressionAdapter(), tmp_path
    )
    assert result.row_count == 4
    assert result.rejected_count == 0
    assert result.namespaces == ("gene_symbol",)
    columns = [field.name for field in build_gene_expression_schema().fields]
    with result.canonical_path.open(encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))
    assert list(rows[0].keys()) == columns
    assert rows[0]["gene_id"] == "TP53"
    assert rows[0]["gene_id_namespace"] == "gene_symbol"
    assert rows[0]["gene_id_version"] == ""
    assert rows[0]["gene_id_raw"] == "TP53"
    assert rows[0]["source_sample_alias"] == "S1"
    assert rows[0]["record_id"].startswith("rec_")


def test_canonical_star_ensembl_normalization(tmp_path: Path) -> None:
    result = _canonicalize(
        "gdc/gdc_star_counts.tsv", GdcExpressionAdapter(), tmp_path
    )
    # The annotation row was already rejected at the adapter (parse) level,
    # so the canonicalizer sees only the two ENSG rows.
    assert result.row_count == 2
    assert result.rejected_count == 0
    assert result.namespaces == ("ensembl_gene",)
    with result.canonical_path.open(encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))
    assert rows[0]["gene_id"] == "ENSG00000141510"
    assert rows[0]["gene_id_namespace"] == "ensembl_gene"
    assert rows[0]["gene_id_version"] == "17"
    assert rows[0]["source_sample_alias"] == ""  # no column alias in single-sample files
    assert rows[0]["record_id"] == make_record_id(
        "build_test", "ENSG00000141510.17", "gdc_star_counts"
    )
    log = (tmp_path / "canonical" / "binding_1_normalization_log.csv").read_text()
    assert "ensembl_version_split" in log
    assert "ENSG00000141510" in log


def test_canonical_rejected_rows_audit(tmp_path: Path) -> None:
    _canonicalize("gdc/gdc_star_counts.tsv", GdcExpressionAdapter(), tmp_path)
    # Parse-level rejection stays at the adapter output.
    parse_rejected = (tmp_path / "batches" / "binding_1_rejected.csv").read_text()
    assert "__no_feature" in parse_rejected
    assert "non_ensg_annotation_row" in parse_rejected
    # Canonicalizer audit is present (header only for this fixture).
    normalization_rejected = (
        tmp_path / "canonical" / "binding_1_rejected.csv"
    ).read_text()
    assert "unauthorized_namespace" not in normalization_rejected


def test_field_mappings_audit_written(tmp_path: Path) -> None:
    _canonicalize("gdc/gdc_expression.tsv", GdcExpressionAdapter(), tmp_path)
    mappings_path = tmp_path / "canonical" / "binding_1_field_mappings.csv"
    lines = mappings_path.read_text().splitlines()
    assert len(lines) == 6  # header + gene_id + 2 per sample (x2 samples)
    assert "adapter_declared" in lines[1]


def test_canonical_batch_metadata(tmp_path: Path) -> None:
    result = _canonicalize(
        "ncbi/gse178352/xena_matrix.tsv", XenaMatrixAdapter(), tmp_path
    )
    batch = result.batch
    assert batch.schema_ref == "gene_expression.long.v1"
    assert batch.row_count == 4
    assert batch.column_count == len(build_gene_expression_schema().fields)
    assert batch.file_asset.kind == "normalized"
    assert batch.statistics["gene_id_namespaces"] == ["gene_symbol"]


def test_canonical_is_deterministic(tmp_path: Path) -> None:
    first = _canonicalize("gdc/gdc_expression.tsv", GdcExpressionAdapter(), tmp_path)
    second = _canonicalize("gdc/gdc_expression.tsv", GdcExpressionAdapter(), tmp_path)
    assert first.canonical_path.read_bytes() == second.canonical_path.read_bytes()
    assert first.batch.file_asset.sha256 == second.batch.file_asset.sha256


def test_unknown_unit_rejected(tmp_path: Path) -> None:
    # GDC STAR uses unstranded counts; remove it from the allowed set to force
    # an unknown_unit rejection via a custom profile.
    from app.datasets.contracts import NormalizationProfile

    profile = _expression_normalization_v1()
    restricted = NormalizationProfile(
        profile_id="gene_expression.normalization.restricted.v1",
        dataset_family="gene_expression",
        allowed_namespaces=profile.allowed_namespaces,
        allowed_units=["expression_value"],  # tpm_unstranded not allowed
        allowed_semantics=profile.allowed_semantics,
        allowed_value_scales=profile.allowed_value_scales,
        aggregation_policy="keep_all",
    )
    asset = _source_asset("gdc/gdc_star_counts.tsv")
    batch = GdcExpressionAdapter().parse(
        asset,
        FIXTURES / "gdc/gdc_star_counts.tsv",
        build_id="build_test",
        binding_id="binding_1",
        schema_ref="gene_expression.long.v1",
        output_dir=tmp_path,
    )
    result = canonicalize(
        batch=batch,
        schema=build_gene_expression_schema(),
        profile=restricted,
        output_dir=tmp_path,
    )
    assert result.row_count == 0
    assert result.rejected_count == 2
    rejected = (tmp_path / "canonical" / "binding_1_rejected.csv").read_text()
    assert "unknown_unit" in rejected


def test_gene_symbol_map_resolves_symbols_to_ensembl(tmp_path: Path) -> None:
    result = _canonicalize(
        "gdc/gdc_expression.tsv",
        GdcExpressionAdapter(),
        tmp_path,
        gene_symbol_map=SYMBOL_TO_ENSEMBL,
    )
    assert result.row_count == 4
    assert result.rejected_count == 0
    assert result.namespaces == ("ensembl_gene",)
    assert result.batch.statistics["gene_symbol_mapped_count"] == 4
    with result.canonical_path.open(encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))
    assert rows[0]["gene_id"] == "ENSG00000141510"  # TP53
    assert rows[0]["gene_id_namespace"] == "ensembl_gene"
    assert rows[0]["gene_id_version"] == ""
    log = (tmp_path / "canonical" / "binding_1_normalization_log.csv").read_text()
    assert "gene_symbol_map" in log
    assert "local gene symbol map" in log


def test_gene_symbol_map_keeps_unmapped_symbols(tmp_path: Path) -> None:
    matrix = tmp_path / "symbol_matrix.tsv"
    matrix.write_text("gene_id\tS1\nTP53\t1.5\nMYH9\t2.5\n", encoding="utf-8")
    checksum = hashlib.sha256(matrix.read_bytes()).hexdigest()
    asset = SourceAsset(
        asset_id=asset_id_from_sha256(checksum),
        kind="source",
        relative_path="source_assets/symbol_matrix.tsv",
        sha256=checksum,
        size_bytes=matrix.stat().st_size,
        media_type="text/tab-separated-values",
        source_id="src_test",
        successful_attempt_id="attempt_1",
        data_level=DataLevel.REPOSITORY_PROCESSED,
    )
    batch = GdcExpressionAdapter().parse(
        asset,
        matrix,
        build_id="build_test",
        binding_id="binding_1",
        schema_ref="gene_expression.long.v1",
        output_dir=tmp_path,
    )
    result = canonicalize(
        batch=batch,
        schema=build_gene_expression_schema(),
        profile=_expression_normalization_v1(),
        output_dir=tmp_path,
        gene_symbol_map=SYMBOL_TO_ENSEMBL,
    )
    assert result.row_count == 2
    assert result.rejected_count == 0
    assert result.namespaces == ("ensembl_gene", "gene_symbol")
    assert result.batch.statistics["gene_symbol_mapped_count"] == 1
    with result.canonical_path.open(encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))
    by_id = {row["gene_id_raw"]: row for row in rows}
    assert by_id["TP53"]["gene_id_namespace"] == "ensembl_gene"
    assert by_id["MYH9"]["gene_id_namespace"] == "gene_symbol"
    assert by_id["MYH9"]["gene_id"] == "MYH9"  # never dropped when unmapped


def test_multi_unit_batch_detected_as_inconsistency(tmp_path: Path) -> None:
    """A batch mixing two allowed units is flagged, not silently merged."""
    matrix = tmp_path / "mixed_unit_matrix.tsv"
    matrix.write_text(
        "gene_id\tS1\tS2\n"
        "TP53\t1.5\t2.5\n"
        "BRCA1\t3.5\t4.5\n",
        encoding="utf-8",
    )
    checksum = hashlib.sha256(matrix.read_bytes()).hexdigest()
    asset = SourceAsset(
        asset_id=asset_id_from_sha256(checksum),
        kind="source",
        relative_path="source_assets/mixed_unit_matrix.tsv",
        sha256=checksum,
        size_bytes=matrix.stat().st_size,
        media_type="text/tab-separated-values",
        source_id="src_test",
        successful_attempt_id="attempt_1",
        data_level=DataLevel.REPOSITORY_PROCESSED,
    )
    batch = GdcExpressionAdapter().parse(
        asset,
        matrix,
        build_id="build_test",
        binding_id="binding_1",
        schema_ref="gene_expression.long.v1",
        output_dir=tmp_path,
    )
    # Both units are in the allowed set, so neither row is rejected; the
    # canonicalizer must still surface the inconsistency for the publisher.
    from app.datasets.contracts import NormalizationProfile

    base = _expression_normalization_v1()
    profile = NormalizationProfile(
        profile_id="gene_expression.normalization.mixed.v1",
        dataset_family="gene_expression",
        allowed_namespaces=base.allowed_namespaces,
        allowed_units=["tpm_unstranded", "unstranded", "expression_value"],
        allowed_semantics=base.allowed_semantics,
        allowed_value_scales=base.allowed_value_scales,
        aggregation_policy="keep_all",
    )
    # Inject a second unit into the parsed batch rows so the canonicalizer
    # sees two distinct expression_unit values.
    from app.datasets.contracts import DataBatch

    def _remap_unit(row: dict[str, str]) -> dict[str, str]:
        row = dict(row)
        if row.get("sample_id") == "S2":
            row["expression_unit"] = "unstranded"
        return row

    source_path = tmp_path / batch.file_asset.relative_path
    mixed_dir = tmp_path / "source_assets"
    mixed_dir.mkdir(parents=True, exist_ok=True)
    mixed = mixed_dir / "mixed_parsed.tsv"
    with source_path.open("r", encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        columns = reader.fieldnames
        rows = [_remap_unit(row) for row in reader]
    with mixed.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=columns)
        writer.writeheader()
        writer.writerows(rows)
    mixed_checksum = hashlib.sha256(mixed.read_bytes()).hexdigest()
    mixed_batch = DataBatch(
        batch_id="binding_1",
        binding_id="binding_1",
        dataset_family=batch.dataset_family,
        row_granularity=batch.row_granularity,
        schema_ref=batch.schema_ref,
        file_asset=batch.file_asset.model_copy(
                update={
                    "asset_id": asset_id_from_sha256(mixed_checksum),
                    "sha256": mixed_checksum,
                    "relative_path": "source_assets/mixed_parsed.tsv",
                    "size_bytes": mixed.stat().st_size,
                }
            ),
        row_count=batch.row_count,
        column_count=batch.column_count,
        parser_id=batch.parser_id,
        parser_version=batch.parser_version,
        statistics=dict(batch.statistics),
    )
    result = canonicalize(
        batch=mixed_batch,
        schema=build_gene_expression_schema(),
        profile=profile,
        output_dir=tmp_path,
    )
    assert result.row_count == 4
    assert result.rejected_count == 0
    assert result.batch.statistics["unit_inconsistency_detected"] is True
    assert any(
        "multiple expression units" in warning for warning in result.batch.warnings
    )
    assert set(result.batch.statistics["expression_units"]) == {
        "expression_value",
        "unstranded",
    }


# ---------------------------------------------------------------------------
# Phase 5 T2: the canonicalizer consumes the adapter-declared namespace
# ---------------------------------------------------------------------------


def test_canonicalizer_consumes_declared_namespace(tmp_path: Path) -> None:
    """GEO probe rows are not authorized as gene_symbol by ID shape alone.

    Phase 5 D1: the adapter declares ``geo_probe`` for non-ENSG ID_REF rows;
    the canonicalizer must consume that declaration — the probe row keeps the
    honest ``geo_probe`` namespace instead of being guessed as
    ``gene_symbol``.  Phase 5 T7 (D2/D5): ``geo_probe`` is a canonical
    namespace (the entity-level publish policy — residual probe rows fail the
    gene release gate — lives in the validation profile, not here), so the
    probe rows pass canonicalization with ``geo_probe``.
    """
    import gzip as gzip_module

    from app.datasets.build.adapters import GeoExpressionAdapter

    matrix = tmp_path / "geo_series_matrix.txt.gz"
    text = (
        "!series_matrix_table_begin\n"
        "\"ID_REF\"\t\"GSM1\"\t\"GSM2\"\n"
        "\"AFFX-BioB-5\"\t1.5\t2.0\n"
        "\"ENSG00000141510\"\t5.0\t6.0\n"
        "!series_matrix_table_end\n"
    )
    with gzip_module.open(matrix, "wt", encoding="utf-8") as handle:
        handle.write(text)
    from app.datasets.contracts import AdapterParams, ValueScale

    params = AdapterParams(
        format="series_matrix",
        value_semantics="normalized_expression",
        value_scale=ValueScale.LOG2,
        expression_unit="log2_expression",
        platform_ids=["GPL570"],
    )
    checksum = hashlib.sha256(matrix.read_bytes()).hexdigest()
    asset = SourceAsset(
        asset_id=asset_id_from_sha256(checksum),
        kind="source",
        relative_path=f"source_assets/{matrix.name}",
        sha256=checksum,
        size_bytes=matrix.stat().st_size,
        media_type="text/tab-separated-values",
        source_id="src_geo",
        successful_attempt_id="attempt_1",
        data_level=DataLevel.REPOSITORY_PROCESSED,
    )
    batch = GeoExpressionAdapter().parse(
        asset,
        matrix,
        build_id="build_geo",
        binding_id="binding_geo",
        schema_ref="gene_expression.long.v1",
        output_dir=tmp_path,
        parameters=params,
    )
    result = canonicalize(
        batch=batch,
        schema=build_gene_expression_schema(),
        profile=_expression_normalization_v1(),
        output_dir=tmp_path,
    )
    # Both namespaces pass canonicalization; the probe row keeps the honest
    # geo_probe namespace (never guessed as gene_symbol).  The gene release
    # profile fails residual geo_probe rows (T5 probe_coverage_required_gene_
    # level), which is the entity-level enforcement point.
    assert result.namespaces == ("ensembl_gene", "geo_probe")
    assert result.row_count == 4
    assert result.rejected_count == 0
    normalization = result.audit_paths[1].read_text()
    assert "AFFX-BioB-5" in normalization
    assert "namespace_geo_probe" in normalization


def test_canonicalizer_accepts_declared_ensembl_gene(tmp_path: Path) -> None:
    """tximport rows (declared ensembl_gene) canonicalize under the gene schema."""
    from app.datasets.build.adapters import GeoExpressionAdapter
    from app.datasets.contracts import AdapterParams, ValueScale

    counts = tmp_path / "counts.tsv"
    counts.write_text(
        "counts.S1\tcounts.S2\n"
        "ENSG00000141510\t10\t20\n"
        "ENSG00000000003\t30\t40\n",
        encoding="utf-8",
    )
    params = AdapterParams(
        format="tximport_counts",
        value_semantics="raw_count",
        value_scale=ValueScale.LINEAR,
        expression_unit="estimated_count",
        is_normalized=False,
    )
    checksum = hashlib.sha256(counts.read_bytes()).hexdigest()
    asset = SourceAsset(
        asset_id=asset_id_from_sha256(checksum),
        kind="source",
        relative_path="source_assets/counts.tsv",
        sha256=checksum,
        size_bytes=counts.stat().st_size,
        media_type="text/tab-separated-values",
        source_id="src_geo",
        successful_attempt_id="attempt_1",
        data_level=DataLevel.REPOSITORY_PROCESSED,
    )
    batch = GeoExpressionAdapter().parse(
        asset,
        counts,
        build_id="build_geo",
        binding_id="binding_geo",
        schema_ref="gene_expression.long.v1",
        output_dir=tmp_path,
        parameters=params,
    )
    result = canonicalize(
        batch=batch,
        schema=build_gene_expression_schema(),
        profile=_expression_normalization_v1(),
        output_dir=tmp_path,
    )
    assert result.namespaces == ("ensembl_gene",)
    assert result.row_count == 4
    assert result.rejected_count == 0


# ---------------------------------------------------------------------------
# Phase 5 T4: canonicalizer value-scale validation (spec D3)
# ---------------------------------------------------------------------------


def _series_matrix_source(tmp_path: Path) -> tuple[Path, Path]:
    """Write a small GEO series-matrix file; return (source_path, source_asset_path)."""
    import gzip as gzip_module

    matrix = tmp_path / "geo_scale_matrix.txt.gz"
    text = (
        "!series_matrix_table_begin\n"
        "\"ID_REF\"\t\"GSM1\"\t\"GSM2\"\n"
        "\"ENSG00000141510\"\t5.0\t6.0\n"
        "!series_matrix_table_end\n"
    )
    with gzip_module.open(matrix, "wt", encoding="utf-8") as handle:
        handle.write(text)
    checksum = hashlib.sha256(matrix.read_bytes()).hexdigest()
    asset = SourceAsset(
        asset_id=asset_id_from_sha256(checksum),
        kind="source",
        relative_path=f"source_assets/{matrix.name}",
        sha256=checksum,
        size_bytes=matrix.stat().st_size,
        media_type="text/tab-separated-values",
        source_id="src_geo",
        successful_attempt_id="attempt_1",
        data_level=DataLevel.REPOSITORY_PROCESSED,
    )
    return matrix, asset


def _canonicalize_geo_series(
    tmp_path: Path,
    *,
    value_scale: str,
    profile: NormalizationProfile,
) -> CanonicalizationResult:
    from app.datasets.build.adapters import GeoExpressionAdapter
    from app.datasets.contracts import AdapterParams, ValueScale

    matrix, asset = _series_matrix_source(tmp_path)
    params = AdapterParams(
        format="series_matrix",
        value_semantics="normalized_expression",
        value_scale=ValueScale(value_scale),
        expression_unit="log2_expression",
        platform_ids=["GPL570"],
    )
    batch = GeoExpressionAdapter().parse(
        asset,
        matrix,
        build_id="build_geo",
        binding_id="binding_geo",
        schema_ref="gene_expression.long.v1",
        output_dir=tmp_path,
        parameters=params,
    )
    return canonicalize(
        batch=batch,
        schema=build_gene_expression_schema(),
        profile=profile,
        output_dir=tmp_path,
    )


def test_scale_outside_allowlist_rejected(tmp_path: Path) -> None:
    """A row whose value_scale is not in the profile allowlist is rejected.

    T4 D3: ``unknown`` is honest but must be explicitly allowed — a profile
    allowing only {log2, linear} rejects an unknown-scale declaration.
    """
    from app.datasets.contracts import NormalizationProfile, ValueScale

    profile = NormalizationProfile(
        profile_id="gene_expression.normalization.restricted_scale.v1",
        dataset_family="gene_expression",
        allowed_namespaces=["ensembl_gene"],
        allowed_units=["log2_expression"],
        allowed_semantics=["normalized_expression"],
        allowed_value_scales=[ValueScale.LOG2, ValueScale.LINEAR],
        aggregation_policy="keep_all",
    )
    result = _canonicalize_geo_series(
        tmp_path,
        value_scale="unknown",
        profile=profile,
    )
    assert result.row_count == 0
    assert result.rejected_count == 2
    rejected = (tmp_path / "canonical" / "binding_geo_rejected.csv").read_text()
    assert "unknown_scale" in rejected


def test_unknown_scale_accepted_when_explicitly_allowed(tmp_path: Path) -> None:
    """A profile allowing ``unknown`` accepts an honestly declared unknown.

    T4 D3: ``unknown`` must never be promoted to a known scale (log2) by
    inference; the canonical row and the measurement identity keep it.
    """
    from app.datasets.contracts import NormalizationProfile, ValueScale

    profile = NormalizationProfile(
        profile_id="gene_expression.normalization.unknown_ok.v1",
        dataset_family="gene_expression",
        allowed_namespaces=["ensembl_gene"],
        allowed_units=["log2_expression"],
        allowed_semantics=["normalized_expression"],
        allowed_value_scales=[ValueScale.LOG2, ValueScale.UNKNOWN],
        aggregation_policy="keep_all",
    )
    result = _canonicalize_geo_series(
        tmp_path,
        value_scale="unknown",
        profile=profile,
    )
    assert result.row_count == 2
    assert result.rejected_count == 0
    assert result.batch.statistics["measurement_identities"] == [
        ["normalized_expression", "unknown", "log2_expression"]
    ]
    with result.canonical_path.open(encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))
    assert all(row["value_scale"] == "unknown" for row in rows)


def test_raw_count_scale_declaration_rejected(tmp_path: Path) -> None:
    """``raw_count`` is a semantics, not a scale: the canonicalizer rejects it.

    AdapterParams already rejects ``raw_count`` as a ValueScale; this proves
    the canonicalizer fails closed too when a raw unparseable scale string
    reaches it (defense in depth, T4 D3).
    """
    from app.datasets.build.adapters import GdcExpressionAdapter
    from app.datasets.contracts import DataBatch

    asset = _source_asset("gdc/gdc_expression.tsv")
    batch = GdcExpressionAdapter().parse(
        asset,
        FIXTURES / "gdc/gdc_expression.tsv",
        build_id="build_test",
        binding_id="binding_1",
        schema_ref="gene_expression.long.v1",
        output_dir=tmp_path,
    )
    source_path = tmp_path / batch.file_asset.relative_path
    remap_dir = tmp_path / "source_assets"
    remap_dir.mkdir(parents=True, exist_ok=True)
    remapped = remap_dir / "raw_count_scale.tsv"
    with source_path.open("r", encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        columns = reader.fieldnames
        rows = []
        for row in reader:
            row["value_scale"] = "raw_count"
            rows.append(row)
    with remapped.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=columns)
        writer.writeheader()
        writer.writerows(rows)
    remapped_checksum = hashlib.sha256(remapped.read_bytes()).hexdigest()
    remapped_batch = DataBatch(
        batch_id=batch.batch_id,
        binding_id=batch.binding_id,
        dataset_family=batch.dataset_family,
        row_granularity=batch.row_granularity,
        schema_ref=batch.schema_ref,
        file_asset=batch.file_asset.model_copy(
            update={
                "asset_id": asset_id_from_sha256(remapped_checksum),
                "sha256": remapped_checksum,
                "relative_path": "source_assets/raw_count_scale.tsv",
                "size_bytes": remapped.stat().st_size,
            }
        ),
        row_count=batch.row_count,
        column_count=batch.column_count,
        parser_id=batch.parser_id,
        parser_version=batch.parser_version,
        statistics=dict(batch.statistics),
    )
    result = canonicalize(
        batch=remapped_batch,
        schema=build_gene_expression_schema(),
        profile=_expression_normalization_v1(),
        output_dir=tmp_path,
    )
    assert result.row_count == 0
    assert result.rejected_count == 4
    rejected = (tmp_path / "canonical" / "binding_1_rejected.csv").read_text()
    assert "unknown_scale" in rejected
