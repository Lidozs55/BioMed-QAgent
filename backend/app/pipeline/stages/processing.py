"""Processing stage: parse GEO tximport counts into ParsedDataset."""
from __future__ import annotations

import csv
import hashlib
import logging

from app.domain.contracts import ParsedDataset, SourceAsset, StageName
from app.pipeline.processing.geo_tximport import (
    _OUTPUT_COLUMNS,
    GeoSampleMetadata,
    parse_geo_series_matrix_samples,
    parse_geo_soft_samples,
    process_geo_tximport_counts,
)
from app.pipeline.stages.base import (
    CleaningReportModel,
    ProcessingOutput,
    StageContext,
    StageResult,
)
from app.tools.alignment import normalize_field_names

logger = logging.getLogger(__name__)


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
                writer.writerow({
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
                })
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
) -> CleaningReportModel:
    """Analyze a parsed CSV for data quality issues.

    Returns a ``CleaningReportModel`` with missing value stats, duplicate
    detection, type-consistency checks, and anomaly flags that can be
    persisted to ``warnings.csv`` and ``cleaning_report.csv``.
    """
    csv_path = ctx.workdir.root / parsed.file_asset.relative_path
    if not csv_path.is_file():
        logger.warning("cleaning: parsed CSV not found at %s", csv_path)
        return CleaningReportModel()

    with csv_path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        all_rows = list(reader)
        columns = reader.fieldnames or []

    if not all_rows:
        return CleaningReportModel()

    # --- missing value stats ---
    missing_stats: dict[str, int] = {}
    for col in columns:
        count = sum(
            1 for row in all_rows
            if row.get(col) is None or row.get(col, "").strip() == ""
        )
        if count > 0:
            missing_stats[col] = count

    # --- duplicate detection ---
    seen: set[str] = set()
    duplicate_count = 0
    for row in all_rows:
        fingerprint = repr(tuple(str(row.get(c, "")) for c in columns))
        if fingerprint in seen:
            duplicate_count += 1
        else:
            seen.add(fingerprint)

    # --- type-consistency check ---
    # Heuristic: for each column, try to infer the most common type and flag
    # rows where the value does not match.
    type_issues: dict[str, int] = {}
    for col in columns:
        mismatch = 0
        # Collect non-empty values for type inference
        values = [
            row.get(col, "") for row in all_rows
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
            for row in all_rows:
                val = row.get(col, "")
                if val and val.strip():
                    try:
                        int(val.strip())
                    except (ValueError, TypeError):
                        mismatch += 1
        elif majority == floats and (ints + floats) / total >= 0.8:
            # Expect numeric — flag non-numeric values
            for row in all_rows:
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
        anomaly_flags.append(
            f"字段 '{col}' 有 {count} 个缺失值"
        )
    if duplicate_count > 0:
        anomaly_flags.append(
            f"检测到 {duplicate_count} 个精确重复行"
        )
    for col, count in type_issues.items():
        anomaly_flags.append(
            f"字段 '{col}' 有 {count} 个类型不匹配值"
        )

    total_anomalies = (
        sum(missing_stats.values())
        + duplicate_count
        + sum(type_issues.values())
    )

    return CleaningReportModel(
        missing_stats=missing_stats,
        duplicate_count=duplicate_count,
        type_issues=type_issues,
        anomaly_flags=anomaly_flags,
        total_anomalies=total_anomalies,
    )


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
    from app.domain.processing import ParsedDataset as OldParsedDataset

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
    from app.tools.alignment import align_fields

    return align_fields(old_datasets)


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
        logger.warning(
            "processing: series_matrix sample recovery failed: %s", exc
        )
        return []


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
    """
    assets = source_assets if isinstance(source_assets, list) else [source_assets]
    source_asset = next(
        (asset for asset in assets if "tximportCounts" in asset.relative_path),
        assets[0],
    )
    soft_asset = next(
        (asset for asset in assets if "family.soft" in asset.relative_path), None
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
            # Fixture-mode fallback: series_matrix recovery for fixture
            # series whose expression block is empty.
            logger.warning(
                "processing: tximport parse failed (%s); attempting "
                "series_matrix sample recovery",
                exc,
            )
            samples = _recover_samples_from_series_matrix(source_asset, ctx)
            parsed = _build_minimal_parsed_dataset(
                source_asset, dataset_id, ctx, samples=samples
            )
            if samples:
                logger.info(
                    "processing: recovered %d samples from series_matrix; "
                    "main_data.csv will contain %d sample_metadata rows "
                    "(expression block is empty)",
                    len(samples),
                    parsed.row_count,
                )
            else:
                logger.warning(
                    "processing: series_matrix recovery yielded no samples; "
                    "main_data.csv will be schema-only (0 rows)"
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
            parsed = _build_minimal_parsed_dataset(
                source_asset, dataset_id, ctx, samples=samples
            )
        if soft_asset is not None and "tximportCounts" in source_asset.relative_path:
            logger.info(
                "processing: live mode parsed %d expression rows from "
                "downloaded tximport counts",
                parsed.row_count,
            )
        elif samples:
            logger.info(
                "processing: live mode recovered %d samples from "
                "series_matrix; main_data.csv will contain %d "
                "sample_metadata rows",
                len(samples),
                parsed.row_count,
            )
        else:
            logger.warning(
                "processing: live mode series_matrix recovery yielded no "
                "samples; main_data.csv will be schema-only (0 rows)"
            )

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

    # --- cleaning ---
    cleaning_report = _clean_parsed_dataset(ctx, parsed)

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
