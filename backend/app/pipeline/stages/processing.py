"""Processing stage: parse GEO tximport counts into ParsedDataset."""

from __future__ import annotations

import csv
import hashlib
import logging
import os
import tempfile
from contextlib import suppress

from app.domain.contracts import (
    ParsedDataset,
    SourceAsset,
    StageName,
    asset_id_from_sha256,
)
from app.domain.processing import ParsedDataset as OldParsedDataset
from app.pipeline.processing.gdc import parse_gdc_table
from app.pipeline.processing.geo_tximport import (
    _OUTPUT_COLUMNS,
    GeoSampleMetadata,
    parse_geo_series_matrix_samples,
    parse_geo_soft_samples,
    process_geo_series_matrix_expression,
    process_geo_supplementary_expression,
    process_geo_tximport_counts,
)
from app.pipeline.processing.reactome import parse_reactome_table
from app.pipeline.processing.xena_matrix import parse_xena_matrix
from app.pipeline.stages.base import (
    CleaningReportModel,
    ProcessingOutput,
    StageContext,
    StageResult,
)
from app.tools.alignment import normalize_field_names

logger = logging.getLogger(__name__)

_CLEANING_MAX_ROWS = 500_000


def _build_minimal_parsed_dataset(
    source_asset: SourceAsset,
    dataset_id: str,
    ctx: StageContext,
    samples: list[GeoSampleMetadata] | None = None,
) -> ParsedDataset:
    """Produce a ParsedDataset for cases where tximport parsing fails.

    When ``samples`` is provided (e.g. recovered from a series_matrix file
    whose expression block is empty), one row per sample is written with
    ``measurement_type="sample_metadata"`` so that ``main_data.csv`` always
    carries the per-sample metadata even when no expression matrix is
    available. Expression-related fields (``gene_id_raw``, ``expression_value``,
    etc.) are left blank, and ``source_line_number``/``source_column_index``
    are set to ``0`` to signal "no source locator" — the validation gate
    skips lineage checks for these rows.

    When ``samples`` is empty or None, the file is schema-only (0 rows) for
    backward compatibility with callers that have no sample metadata to
    recover (e.g. fixture-mode tests that don't exercise live mode).
    """
    import csv

    from app.domain.contracts import FileAsset, asset_id_from_sha256, make_record_id

    output_path = ctx.workdir.parsed / f"{dataset_id}_tximport_long.csv"
    row_count = 0
    # utf-8-sig writes a BOM so Excel opens UTF-8 CSVs without garbling (TODO §1.7).
    with output_path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=_OUTPUT_COLUMNS)
        writer.writeheader()
        if samples:
            for sample in samples:
                writer.writerow(
                    {
                        "record_id": make_record_id(
                            dataset_id, "sample_metadata", sample.sample_id
                        ),
                        "dataset_id": dataset_id,
                        "source_id": source_asset.source_id,
                        "asset_id": source_asset.asset_id,
                        "gene_id_raw": "",
                        "gene_id": "",
                        "gene_id_namespace": "",
                        "gene_id_version": "",
                        "sample_id": sample.sample_id,
                        "source_sample_alias": sample.source_alias,
                        "measurement_type": "sample_metadata",
                        "value_semantics": "metadata_only",
                        "value_scale": "na",
                        "is_normalized": "false",
                        "is_integer_expected": "false",
                        "expression_value": "",
                        "expression_unit": "na",
                        "source_logical_file": "series_matrix_metadata",
                        "source_line_number": 0,
                        "source_column_index": 0,
                        "source_column_name": "sample_metadata",
                        "source_raw_value": "",
                    }
                )
                row_count += 1
    file_bytes = output_path.read_bytes()
    checksum = hashlib.sha256(file_bytes).hexdigest()
    file_asset = FileAsset(
        asset_id=asset_id_from_sha256(checksum),
        kind="parsed",
        relative_path=output_path.relative_to(ctx.workdir.root).as_posix(),
        sha256=checksum,
        size_bytes=len(file_bytes),
        media_type="text/csv",
        generated_by_step_id="step_geo_minimal_v1",
    )
    # The minimal parser emits one row per sample (no expression matrix).
    # ``source_row_count`` is 0 because the source series_matrix had no
    # expression data rows; ``processing_parameters`` records the actual
    # measurement_type so processing_log.parameters is not hardcoded (TODO §1.3).
    processing_parameters = {
        "measurement_type": "sample_metadata",
        "value_semantics": "metadata_only",
        "value_scale": "na",
        "is_normalized": False,
        "is_integer_expected": False,
        "sample_count": len(samples) if samples else 0,
        "source_logical_file": "series_matrix_metadata",
        "gene_id_namespace": "",
    }
    return ParsedDataset(
        dataset_id=dataset_id,
        source_id=source_asset.source_id,
        source_asset_id=source_asset.asset_id,
        file_asset=file_asset,
        columns=list(_OUTPUT_COLUMNS),
        row_count=row_count,
        parser_name="geo_minimal_placeholder",
        parser_version="1.0.0",
        source_row_count=0,
        processing_parameters=processing_parameters,
    )


def _clean_parsed_dataset(
    ctx: StageContext,
    parsed: ParsedDataset,
) -> tuple[ParsedDataset, CleaningReportModel]:
    """Apply conservative deterministic cleaning and analyze data quality.

    Trims surrounding whitespace, normalizes unambiguous missing sentinels,
    and removes exact duplicate rows while preserving first-seen order. The
    transformed CSV is atomically replaced and its immutable file identity is
    refreshed before downstream artifact construction.
    """
    csv_path = ctx.workdir.root / parsed.file_asset.relative_path
    if not csv_path.is_file():
        logger.warning("cleaning: parsed CSV not found at %s", csv_path)
        return parsed, CleaningReportModel()

    with csv_path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        all_rows = []
        for row in reader:
            if len(all_rows) >= _CLEANING_MAX_ROWS:
                logger.warning(
                    "cleaning: row limit (%d) reached for %s, truncating",
                    _CLEANING_MAX_ROWS, csv_path.name,
                )
                break
            all_rows.append(row)
        columns = reader.fieldnames or []

    if not all_rows:
        return parsed, CleaningReportModel()

    normalized_rows: list[dict[str, str]] = []
    seen_rows: set[tuple[str, ...]] = set()
    trimmed_values = 0
    normalized_missing_values = 0
    duplicate_count = 0
    missing_sentinels = {"n/a", "null", "none"}
    for row in all_rows:
        normalized: dict[str, str] = {}
        for col in columns:
            raw_value = row.get(col) or ""
            value = raw_value.strip()
            if value != raw_value:
                trimmed_values += 1
            if value.casefold() in missing_sentinels:
                value = ""
                normalized_missing_values += 1
            normalized[col] = value
        fingerprint = tuple(normalized[col] for col in columns)
        if fingerprint in seen_rows:
            duplicate_count += 1
            continue
        seen_rows.add(fingerprint)
        normalized_rows.append(normalized)

    # --- missing value stats ---
    missing_stats: dict[str, int] = {}
    for col in columns:
        count = sum(1 for row in normalized_rows if row.get(col, "") == "")
        if count > 0:
            missing_stats[col] = count

    # --- type-consistency check ---
    # Heuristic: for each column, try to infer the most common type and flag
    # rows where the value does not match.
    type_issues: dict[str, int] = {}
    for col in columns:
        mismatch = 0
        # Collect non-empty values for type inference
        values = [
            row.get(col, "")
            for row in normalized_rows
            if row.get(col) is not None and row.get(col, "").strip() != ""
        ]
        if not values:
            continue
        # Quick majority-type inference
        ints = 0
        floats = 0
        others = 0
        for v in values:
            try:
                int(v)
                ints += 1
            except (ValueError, TypeError):
                try:
                    float(v)
                    floats += 1
                except (ValueError, TypeError):
                    others += 1
        total = ints + floats + others
        majority = max(ints, floats, others)
        if majority == 0:
            continue
        if majority == ints and ints / total >= 0.8:
            # Expect ints — flag non-int values
            for row in normalized_rows:
                val = row.get(col, "")
                if val and val.strip():
                    try:
                        int(val.strip())
                    except (ValueError, TypeError):
                        mismatch += 1
        elif majority == floats and (ints + floats) / total >= 0.8:
            # Expect numeric — flag non-numeric values
            for row in normalized_rows:
                val = row.get(col, "")
                if val and val.strip():
                    try:
                        float(val.strip())
                    except (ValueError, TypeError):
                        mismatch += 1
        if mismatch > 0:
            type_issues[col] = mismatch

    # --- anomaly flags ---
    anomaly_flags: list[str] = []
    for col, count in missing_stats.items():
        anomaly_flags.append(f"字段 '{col}' 有 {count} 个缺失值")
    if duplicate_count > 0:
        anomaly_flags.append(f"检测到 {duplicate_count} 个精确重复行")
    for col, count in type_issues.items():
        anomaly_flags.append(f"字段 '{col}' 有 {count} 个类型不匹配值")

    total_anomalies = sum(missing_stats.values()) + duplicate_count + sum(type_issues.values())

    format_corrections = {
        name: count
        for name, count in {
            "trimmed_values": trimmed_values,
            "normalized_missing_values": normalized_missing_values,
            "removed_duplicate_rows": duplicate_count,
        }.items()
        if count > 0
    }
    transformed = bool(format_corrections)
    cleaned = parsed
    if transformed:
        temporary_path = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="w",
                encoding="utf-8-sig",
                newline="",
                dir=csv_path.parent,
                prefix=f".{csv_path.name}.",
                suffix=".tmp",
                delete=False,
            ) as handle:
                temporary_path = handle.name
                writer = csv.DictWriter(
                    handle,
                    fieldnames=columns,
                    extrasaction="raise",
                )
                writer.writeheader()
                writer.writerows(normalized_rows)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary_path, csv_path)
            temporary_path = None
        finally:
            if temporary_path is not None:
                with suppress(FileNotFoundError):
                    os.unlink(temporary_path)

        file_bytes = csv_path.read_bytes()
        checksum = hashlib.sha256(file_bytes).hexdigest()
        cleaned_asset = parsed.file_asset.model_copy(
            update={
                "asset_id": asset_id_from_sha256(checksum),
                "sha256": checksum,
                "size_bytes": len(file_bytes),
                "generated_by_step_id": "step_deterministic_cleaning_v1",
            }
        )
        cleaned = parsed.model_copy(
            update={
                "file_asset": cleaned_asset,
                "row_count": len(normalized_rows),
            }
        )

    report = CleaningReportModel(
        missing_stats=missing_stats,
        duplicate_count=duplicate_count,
        type_issues=type_issues,
        format_corrections=format_corrections,
        anomaly_flags=anomaly_flags,
        total_anomalies=total_anomalies,
    )
    return cleaned, report


def _build_field_alignment(
    parsed_datasets: list[ParsedDataset],
    ctx: StageContext,
) -> dict[str, list[str]]:
    """Build a field-name alignment across one or more parsed CSV files.

    For a single dataset the result is a simple ``{normalized: [raw]}``
    mapping derived from ``normalize_field_names``.  When two or more
    datasets are present their column sets are aligned via
    ``alignment.align_fields`` so that downstream merging can use it.
    """
    if not parsed_datasets:
        return {}

    if len(parsed_datasets) == 1:
        csv_path = ctx.workdir.root / parsed_datasets[0].file_asset.relative_path
        try:
            with csv_path.open("r", encoding="utf-8-sig", newline="") as handle:
                columns = csv.DictReader(handle).fieldnames or []
        except (OSError, UnicodeDecodeError):
            logger.warning("alignment: cannot read CSV at %s", csv_path)
            return {}
        norm_map = normalize_field_names(columns)
        return {norm: [orig] for orig, norm in norm_map.items()}

    # --- multi-dataset alignment (TODO §1.2: merge_datasets) ---
    old_datasets = _to_legacy_parsed_datasets(parsed_datasets, ctx)
    from app.tools.alignment import align_fields

    return align_fields(old_datasets)


def _to_legacy_parsed_datasets(
    parsed_datasets: list[ParsedDataset],
    ctx: StageContext,
) -> list[OldParsedDataset]:
    """Convert Pipeline ParsedDataset entries into the legacy in-memory model.

    ``alignment.align_fields`` / ``alignment.merge_datasets`` operate on the
    legacy ``app.domain.processing.ParsedDataset`` (rows kept in memory).
    This adapter reads each parsed CSV back so the deterministic merge tools
    can be reused without duplicating their logic (TODO §1.2).
    """

    old_datasets: list[OldParsedDataset] = []
    for pd_dataset in parsed_datasets:
        csv_path = ctx.workdir.root / pd_dataset.file_asset.relative_path
        try:
            with csv_path.open("r", encoding="utf-8-sig", newline="") as handle:
                reader = csv.DictReader(handle)
                columns = reader.fieldnames or []
                rows = list(reader)
        except (OSError, UnicodeDecodeError):
            logger.warning("alignment: cannot read CSV at %s", csv_path)
            continue
        field_types: dict[str, str] = {}
        for col in columns:
            for row in rows:
                val = row.get(col, "")
                if val and val.strip():
                    try:
                        int(val)
                        field_types[col] = "int"
                    except (ValueError, TypeError):
                        try:
                            float(val)
                            field_types[col] = "float"
                        except (ValueError, TypeError):
                            field_types[col] = "string"
                    break
            if col not in field_types:
                field_types[col] = "string"
        old_datasets.append(
            OldParsedDataset(
                dataset_id=pd_dataset.dataset_id,
                source_file=str(csv_path),
                table_name=pd_dataset.dataset_id,
                field_names=list(columns),
                field_types=field_types,
                rows=rows,
                source_locator="csv",
            )
        )
    return old_datasets


def merge_parsed_datasets(
    ctx: StageContext,
    parsed_datasets: list[ParsedDataset],
    merged_dataset_id: str,
) -> ParsedDataset:
    """Deterministically merge two or more parsed datasets (TODO §1.2).

    Uses ``alignment.align_fields`` to build the canonical field mapping and
    ``alignment.merge_datasets`` to vertically merge rows. The merged result
    is written as ``parsed/{merged_dataset_id}_merged.csv`` and returned as
    a Pipeline ``ParsedDataset`` with the same lineage columns every parsed
    dataset carries.

    Raises ``ValueError`` when fewer than two datasets are supplied — the
    merge path must never fabricate a merged artifact from a single source.
    """
    if len(parsed_datasets) < 2:
        raise ValueError("merge requires at least two parsed datasets")

    import hashlib

    from app.domain.contracts import FileAsset, asset_id_from_sha256, make_record_id
    from app.tools.alignment import align_fields, merge_datasets

    old_datasets = _to_legacy_parsed_datasets(parsed_datasets, ctx)
    if len(old_datasets) != len(parsed_datasets):
        raise ValueError("one or more parsed datasets could not be read for merging")
    field_mapping = align_fields(old_datasets)
    if not field_mapping:
        raise ValueError("field alignment produced no shared fields; merge aborted")
    merged = merge_datasets(
        old_datasets,
        field_mapping,
        output_name=merged_dataset_id,
    )

    output_path = ctx.workdir.parsed / f"{merged_dataset_id}_merged.csv"
    columns = list(merged.field_names)
    with output_path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=columns, extrasaction="raise")
        writer.writeheader()
        for row in merged.rows:
            writer.writerow({col: row.get(col, "") for col in columns})
    file_bytes = output_path.read_bytes()
    checksum = hashlib.sha256(file_bytes).hexdigest()
    file_asset = FileAsset(
        asset_id=asset_id_from_sha256(checksum),
        kind="parsed",
        relative_path=output_path.relative_to(ctx.workdir.root).as_posix(),
        sha256=checksum,
        size_bytes=len(file_bytes),
        media_type="text/csv",
        generated_by_step_id="step_multi_source_merge_v1",
    )
    record_id = make_record_id(merged_dataset_id, "merged", "row")
    return ParsedDataset(
        dataset_id=merged_dataset_id,
        source_id=",".join(dataset.source_id for dataset in parsed_datasets),
        source_asset_id=",".join(
            dataset.source_asset_id for dataset in parsed_datasets
        ),
        file_asset=file_asset,
        columns=columns,
        row_count=len(merged.rows),
        parser_name="alignment_merger",
        parser_version="0.1.0",
        source_row_count=sum(dataset.source_row_count for dataset in parsed_datasets),
        processing_parameters={
            "merge_algorithm": "alignment.merge_datasets",
            "merged_dataset_id": merged_dataset_id,
            "input_dataset_ids": [d.dataset_id for d in parsed_datasets],
            "shared_field_count": len(field_mapping),
            "record_id_example": record_id,
        },
    )


def _recover_samples_from_series_matrix(
    source_asset: SourceAsset,
    ctx: StageContext,
) -> list[GeoSampleMetadata]:
    """Try to parse the downloaded series_matrix file for sample metadata.

    Returns an empty list when the downloaded file is not a series_matrix
    (e.g. fixture mode) or when parsing fails. The caller (``run_processing``)
    uses the result to populate ``sample_metadata.csv`` even when the
    expression-matrix block is empty.
    """
    source_path = ctx.workdir.root / source_asset.relative_path
    if not source_path.is_file():
        logger.warning("processing: source asset not found at %s", source_path)
        return []
    try:
        compressed = source_path.read_bytes()
    except OSError as exc:
        logger.warning("processing: cannot read source asset: %s", exc)
        return []
    try:
        return parse_geo_series_matrix_samples(compressed)
    except (ValueError, OSError) as exc:
        logger.warning("processing: series_matrix sample recovery failed: %s", exc)
        return []


def _try_series_matrix_expression_or_minimal(
    source_asset: SourceAsset,
    dataset_id: str,
    ctx: StageContext,
    samples: list[GeoSampleMetadata],
    suppl_asset: SourceAsset | None = None,
) -> ParsedDataset:
    """Try parsing the series_matrix expression block; fall back to minimal.

    When the series_matrix has a non-empty ``!series_matrix_table_begin``/
    ``!series_matrix_table_end`` block, produces real expression rows.
    When the block is empty but a supplementary expression asset is available
    (downloaded by the acquisition stage for RNA-seq series), parses that
    instead. Otherwise falls back to ``_build_minimal_parsed_dataset``
    (metadata-only).
    """
    if samples:
        try:
            expression_parsed = process_geo_series_matrix_expression(
                source_asset=source_asset,
                dataset_id=dataset_id,
                workdir=ctx.workdir,
                samples=samples,
            )
            if expression_parsed is not None:
                logger.info(
                    "processing: parsed %d expression rows from series_matrix",
                    expression_parsed.row_count,
                )
                return expression_parsed
            # series_matrix 表达块为空 —— 尝试 supplementary 表达矩阵
            if suppl_asset is not None:
                try:
                    suppl_parsed = process_geo_supplementary_expression(
                        source_asset=suppl_asset,
                        dataset_id=dataset_id,
                        workdir=ctx.workdir,
                        samples=samples,
                    )
                    if suppl_parsed is not None:
                        logger.info(
                            "processing: parsed %d expression rows from supplementary file",
                            suppl_parsed.row_count,
                        )
                        return suppl_parsed
                    logger.info(
                        "processing: supplementary expression file yielded no rows",
                    )
                except (ValueError, FileNotFoundError, OSError) as exc:
                    logger.warning(
                        "processing: supplementary expression parse failed (%s)",
                        exc,
                    )
            logger.info(
                "processing: series_matrix expression block is empty; "
                "falling back to sample_metadata rows",
            )
        except (ValueError, FileNotFoundError, OSError) as exc:
            logger.warning(
                "processing: series_matrix expression parse failed (%s); "
                "falling back to sample_metadata rows",
                exc,
            )
    return _build_minimal_parsed_dataset(source_asset, dataset_id, ctx, samples=samples)


def _run_multi_dataset_processing(
    ctx: StageContext,
    assets: list[SourceAsset],
    datasets: list,
) -> StageResult:
    """Parse multiple data-type datasets and deterministically merge them.

    TODO §1.2: each dataset/asset pair is parsed into a ``ParsedDataset`` via
    the existing per-database parsers; then ``alignment.align_fields`` builds
    the real field mapping and ``alignment.merge_datasets`` vertically merges
    the rows. The merged result is returned as ``merged_dataset`` so the
    artifact build can publish it as ``main_data.csv`` while retaining every
    per-source parsed dataset for lineage.
    """
    if len(datasets) < 2:
        raise ValueError("multi-dataset processing requires at least two datasets")

    parsed_datasets: list[ParsedDataset] = []
    used_asset_ids: set[str] = set()
    for dataset in datasets:
        matching = [
            asset
            for asset in assets
            if asset.source_id == dataset.source_id
            and asset.asset_id not in used_asset_ids
        ]
        if not matching:
            matching = [
                asset for asset in assets if asset.asset_id not in used_asset_ids
            ]
        dataset_asset = matching[0] if matching else None
        if dataset_asset is None:
            raise ValueError(
                f"multi-dataset processing: no asset for {dataset.dataset_id}"
            )
        used_asset_ids.add(dataset_asset.asset_id)
        database = dataset.database.value
        if database == "gdc":
            if not dataset.data_type:
                raise ValueError("GDC processing requires data_type")
            parsed_datasets.append(
                parse_gdc_table(dataset_asset, dataset.dataset_id, ctx.workdir, dataset.data_type)
            )
        elif database in {"xena", "ucsc_xena"}:
            parsed_datasets.append(
                parse_xena_matrix(dataset_asset, dataset.dataset_id, ctx.workdir)
            )
        elif database == "geo":
            # GEO expression parsing needs its SOFT/context pairing; the
            # deterministic merge path keeps GEO as the primary dataset and
            # skips re-parsing it here (the merged row set is derived from
            # the other sources' parsed long-form rows).
            continue
        else:
            raise ValueError(f"multi-dataset processing: unsupported {database}")

    if len(parsed_datasets) < 2:
        raise ValueError(
            "multi-dataset processing requires at least two parseable datasets"
        )
    field_alignment = _build_field_alignment(parsed_datasets, ctx)
    merged = merge_parsed_datasets(
        ctx, parsed_datasets, merged_dataset_id=f"{parsed_datasets[0].dataset_id}_merged"
    )
    merged, cleaning_report = _clean_parsed_dataset(ctx, merged)
    output = ProcessingOutput(
        parsed_datasets=parsed_datasets,
        samples=[],
        cleaning_report=cleaning_report,
        field_alignment=field_alignment,
        merged_dataset=merged,
    )
    ctx.emit_progress_sync(
        stage=StageName.PROCESSING,
        kind="cleaned_rows",
        current=merged.row_count,
        total=None,
        detail={
            "dataset_id": merged.dataset_id,
            "file_asset": merged.file_asset.relative_path,
            "merged_inputs": [d.dataset_id for d in parsed_datasets],
        },
    )
    digest = hashlib.sha256(merged.file_asset.sha256.encode("utf-8")).hexdigest()
    return StageResult(output_digest=digest, output=output)


def _data_type_datasets(
    ctx: StageContext,
) -> list:
    """Return the data-type datasets selected in the specification."""
    if ctx.specification is None:
        return []
    return [
        dataset
        for dataset in ctx.specification.datasets
        if dataset.database.value in {"gdc", "ucsc_xena", "xena"}
    ]


def run_processing(
    ctx: StageContext,
    source_assets: SourceAsset | list[SourceAsset],
    dataset_id: str,
) -> StageResult:
    """Parse the GEO tximport counts file into a long-form ParsedDataset.

    In fixture mode, reads the fixture SOFT file for sample metadata. In live
    mode, when acquisition returns both tximport counts and the corresponding
    family SOFT asset, the actual downloaded SOFT is used to parse real
    expression rows. If acquisition falls back to a series matrix, processing
    recovers sample metadata from that asset instead.

    When the specification selects two or more data-type datasets (GDC/Xena)
    the multi-dataset merge path runs instead: every selected dataset is
    parsed and the results are deterministically merged (TODO §1.2).
    """
    assets = source_assets if isinstance(source_assets, list) else [source_assets]
    data_type_datasets = _data_type_datasets(ctx)
    if len(data_type_datasets) >= 2:
        return _run_multi_dataset_processing(ctx, assets, data_type_datasets)
    databases = {database.strip().lower() for database in ctx.databases if database.strip()}
    if not databases:
        raise ValueError("processing requires a non-empty database selection")
    if len(databases) != 1 and not databases <= {"pubmed", "geo"}:
        raise ValueError(f"processing does not support mixed databases: {sorted(databases)}")
    database = "geo" if databases <= {"pubmed", "geo"} else next(iter(databases))
    if database == "gdc":
        if len(assets) != 1:
            raise ValueError("GDC processing requires one source asset")
        dataset_type = next(
            (
                d.data_type
                for d in (ctx.specification.datasets if ctx.specification else [])
                if d.database.value == "gdc"
            ),
            None,
        )
        if not dataset_type:
            raise ValueError("GDC processing requires data_type")
        parsed = parse_gdc_table(assets[0], dataset_id, ctx.workdir, dataset_type)
        parsed, cleaning_report = _clean_parsed_dataset(ctx, parsed)
        output = ProcessingOutput(
            parsed_datasets=[parsed],
            samples=[],
            cleaning_report=cleaning_report,
            field_alignment=_build_field_alignment([parsed], ctx),
        )
        return StageResult(
            output_digest=hashlib.sha256(parsed.file_asset.sha256.encode()).hexdigest(),
            output=output,
        )
    if database == "reactome":
        reactome_asset = next(
            (
                asset for asset in assets
                if asset.media_type == "text/tab-separated-values"
            ),
            None,
        )
        if reactome_asset is None:
            raise ValueError("Reactome processing requires a normalized TSV source asset")
        pathway_id = next(
            (
                dataset.accession
                for dataset in (ctx.specification.datasets if ctx.specification else [])
                if dataset.database.value == "reactome"
            ),
            None,
        )
        parsed = parse_reactome_table(reactome_asset, dataset_id, ctx.workdir, pathway_id)
        parsed, cleaning_report = _clean_parsed_dataset(ctx, parsed)
        field_alignment = _build_field_alignment([parsed], ctx)
        output = ProcessingOutput(
            parsed_datasets=[parsed],
            samples=[],
            cleaning_report=cleaning_report,
            field_alignment=field_alignment,
        )
        ctx.emit_progress_sync(
            stage=StageName.PROCESSING,
            kind="cleaned_rows",
            current=parsed.row_count,
            total=None,
            detail={"dataset_id": parsed.dataset_id, "file_asset": parsed.file_asset.relative_path},
        )
        digest = hashlib.sha256(parsed.file_asset.sha256.encode("utf-8")).hexdigest()
        return StageResult(output_digest=digest, output=output)
    if database in {"xena", "ucsc_xena"}:
        if len(assets) != 1:
            raise ValueError("Xena gene-expression processing requires one source asset")
        parsed = parse_xena_matrix(assets[0], dataset_id, ctx.workdir)
        parsed, cleaning_report = _clean_parsed_dataset(ctx, parsed)
        field_alignment = _build_field_alignment([parsed], ctx)
        output = ProcessingOutput(
            parsed_datasets=[parsed],
            samples=[],
            cleaning_report=cleaning_report,
            field_alignment=field_alignment,
        )
        ctx.emit_progress_sync(
            stage=StageName.PROCESSING,
            kind="cleaned_rows",
            current=parsed.row_count,
            total=None,
            detail={
                "dataset_id": parsed.dataset_id,
                "file_asset": parsed.file_asset.relative_path,
            },
        )
        digest = hashlib.sha256(parsed.file_asset.sha256.encode("utf-8")).hexdigest()
        return StageResult(output_digest=digest, output=output)

    if database not in {"geo"}:
        raise ValueError(f"unsupported processing database: {database}")

    source_asset = next(
        (asset for asset in assets if "tximportCounts" in asset.relative_path),
        assets[0],
    )
    soft_asset = next((asset for asset in assets if "family.soft" in asset.relative_path), None)
    suppl_asset = next(
        (
            asset for asset in assets
            if "tximportCounts" not in asset.relative_path
            and "series_matrix" not in asset.relative_path
            and "family.soft" not in asset.relative_path
        ),
        None,
    )
    samples: list[GeoSampleMetadata] = []
    parsed: ParsedDataset
    if ctx.mode == "fixture":
        try:
            parsed = process_geo_tximport_counts(
                source_asset=source_asset,
                dataset_id=dataset_id,
                workdir=ctx.workdir,
                soft_gzip=(ctx.fixture_dir / "gse178352_family.soft.gz").read_bytes(),
                logical_file="GSE178352_tximportCounts.txt",
            )
            samples = parse_geo_soft_samples(
                (ctx.fixture_dir / "gse178352_family.soft.gz").read_bytes()
            )
            logger.info(
                "processing: parsed tximport counts (%d rows, %d samples)",
                parsed.row_count,
                len(samples),
            )
        except (ValueError, FileNotFoundError, OSError) as exc:
            # Fixture-mode fallback: try series_matrix expression parsing,
            # then fall back to sample_metadata rows.
            logger.warning(
                "processing: tximport parse failed (%s); attempting series_matrix recovery",
                exc,
            )
            samples = _recover_samples_from_series_matrix(source_asset, ctx)
            parsed = _try_series_matrix_expression_or_minimal(
                source_asset, dataset_id, ctx, samples, suppl_asset=suppl_asset
            )
    else:
        if soft_asset is not None and "tximportCounts" in source_asset.relative_path:
            soft_bytes = (ctx.workdir.root / soft_asset.relative_path).read_bytes()
            parsed = process_geo_tximport_counts(
                source_asset=source_asset,
                dataset_id=dataset_id,
                workdir=ctx.workdir,
                soft_gzip=soft_bytes,
                logical_file=source_asset.relative_path.rsplit("/", 1)[-1],
            )
            samples = parse_geo_soft_samples(soft_bytes)
        else:
            samples = _recover_samples_from_series_matrix(source_asset, ctx)
            parsed = _try_series_matrix_expression_or_minimal(
                source_asset, dataset_id, ctx, samples, suppl_asset=suppl_asset
            )
        if not samples and not parsed.row_count:
            logger.warning(
                "processing: series_matrix recovery yielded no samples; "
                "main_data.csv will be schema-only (0 rows)"
            )

    # --- cleaning ---
    parsed, cleaning_report = _clean_parsed_dataset(ctx, parsed)

    # Surface processing progress: "Processing: cleaned N rows".
    # See docs/REVIEW_2026-07-18.md §4.
    ctx.emit_progress_sync(
        stage=StageName.PROCESSING,
        kind="cleaned_rows",
        current=parsed.row_count,
        total=None,
        detail={
            "dataset_id": parsed.dataset_id,
            "file_asset": parsed.file_asset.relative_path,
        },
    )

    # --- field alignment ---
    field_alignment = _build_field_alignment([parsed], ctx)

    output = ProcessingOutput(
        parsed_datasets=[parsed],
        samples=samples,
        cleaning_report=cleaning_report,
        field_alignment=field_alignment,
    )
    digest = hashlib.sha256(parsed.file_asset.sha256.encode("utf-8")).hexdigest()
    return StageResult(output_digest=digest, output=output)
