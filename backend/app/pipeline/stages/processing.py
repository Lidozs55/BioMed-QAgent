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
from app.domain.contracts.discovery import GeoSeriesRecord
from app.domain.processing import ParsedDataset as OldParsedDataset
from app.pipeline.processing.gdc import parse_gdc_table
from app.pipeline.processing.geo_annotation import (
    NOT_ATTEMPTED,
    fetch_platform_annotation,
)
from app.pipeline.processing.geo_tximport import (
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
from app.tools.content_cache import ContentCache

logger = logging.getLogger(__name__)

# REVIEW 2026-08-05 P0-1: 原 500_000 会静默截断 GSE183795（4,695,780 行）。
# 流式清洗后内存不再依赖行数，上限提高为防御值；超出部分经
# CleaningReportModel.truncated_rows + warnings.csv 对用户可见。
_CLEANING_MAX_ROWS = 5_000_000


def _clean_parsed_dataset(
    ctx: StageContext,
    parsed: ParsedDataset,
) -> tuple[ParsedDataset, CleaningReportModel]:
    """Apply conservative deterministic cleaning and analyze data quality.

    Trims surrounding whitespace, normalizes unambiguous missing sentinels,
    and removes exact duplicate rows while preserving first-seen order. The
    transformed CSV is atomically replaced and its immutable file identity is
    refreshed before downstream artifact construction.

    REVIEW 2026-08-05 P0-1: 改为**流式**处理（逐行读 + 写临时文件），不再全量
    加载 ``all_rows``，避免大矩阵内存溢出；超过 ``_CLEANING_MAX_ROWS`` 的行
    计数为 ``truncated_rows`` 并通过 cleaning_report / warnings 对用户可见，
    不再静默截断。去重用行指纹哈希（碰撞概率 2^-64 量级，可忽略）。
    """
    csv_path = ctx.workdir.root / parsed.file_asset.relative_path
    if not csv_path.is_file():
        logger.warning("cleaning: parsed CSV not found at %s", csv_path)
        return parsed, CleaningReportModel()

    missing_sentinels = {"n/a", "null", "none"}
    temporary_path: str | None = None
    try:
        with csv_path.open("r", encoding="utf-8-sig", newline="") as handle:
            reader = csv.DictReader(handle)
            columns = reader.fieldnames or []
            with tempfile.NamedTemporaryFile(
                mode="w",
                encoding="utf-8-sig",
                newline="",
                dir=csv_path.parent,
                prefix=f".{csv_path.name}.",
                suffix=".tmp",
                delete=False,
            ) as out_handle:
                temporary_path = out_handle.name
                writer = csv.DictWriter(
                    out_handle,
                    fieldnames=columns,
                    extrasaction="raise",
                )
                writer.writeheader()
                seen_rows: set[int] = set()
                trimmed_values = 0
                normalized_missing_values = 0
                duplicate_count = 0
                truncated_rows = 0
                processed_rows = 0
                missing_counts: dict[str, int] = {}
                # 每列类型投票 [ints, floats, others]，基于去重后的非空值
                type_votes: dict[str, list[int]] = {}
                for row in reader:
                    if processed_rows >= _CLEANING_MAX_ROWS:
                        truncated_rows += 1
                        continue
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
                    if hash(fingerprint) in seen_rows:
                        duplicate_count += 1
                        continue
                    seen_rows.add(hash(fingerprint))
                    writer.writerow(normalized)
                    processed_rows += 1
                    for col in columns:
                        value = normalized[col]
                        if value == "":
                            missing_counts[col] = missing_counts.get(col, 0) + 1
                            continue
                        votes = type_votes.setdefault(col, [0, 0, 0])
                        try:
                            int(value)
                            votes[0] += 1
                        except (ValueError, TypeError):
                            try:
                                float(value)
                                votes[1] += 1
                            except (ValueError, TypeError):
                                votes[2] += 1
                out_handle.flush()
                os.fsync(out_handle.fileno())

        if truncated_rows:
            logger.warning(
                "cleaning: row limit (%d) reached for %s, %d rows truncated",
                _CLEANING_MAX_ROWS, csv_path.name, truncated_rows,
            )

        if processed_rows == 0:
            return parsed, CleaningReportModel()

        # --- missing value stats（基于去重后的行） ---
        missing_stats: dict[str, int] = {
            col: count for col, count in missing_counts.items() if count > 0
        }

        # --- type-consistency check（复刻原 0.8 多数类型阈值语义） ---
        type_issues: dict[str, int] = {}
        with open(temporary_path, encoding="utf-8-sig", newline="") as handle:
            for row in csv.DictReader(handle):
                for col, (ints, floats, others) in type_votes.items():
                    total = ints + floats + others
                    if total == 0:
                        continue
                    majority = max(ints, floats, others)
                    if majority == ints and ints / total >= 0.8:
                        expected = "int"
                    elif majority == floats and (ints + floats) / total >= 0.8:
                        expected = "float"
                    else:
                        continue
                    val = row.get(col, "")
                    if val and val.strip():
                        try:
                            if expected == "int":
                                int(val.strip())
                            else:
                                float(val.strip())
                        except (ValueError, TypeError):
                            type_issues[col] = type_issues.get(col, 0) + 1

        # --- anomaly flags ---
        anomaly_flags: list[str] = []
        for col, count in missing_stats.items():
            anomaly_flags.append(f"字段 '{col}' 有 {count} 个缺失值")
        if duplicate_count > 0:
            anomaly_flags.append(f"检测到 {duplicate_count} 个精确重复行")
        for col, count in type_issues.items():
            anomaly_flags.append(f"字段 '{col}' 有 {count} 个类型不匹配值")
        if truncated_rows > 0:
            anomaly_flags.append(f"数据行数超过清洗上限，截断 {truncated_rows} 行")

        total_anomalies = (
            sum(missing_stats.values()) + duplicate_count + sum(type_issues.values())
        )

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
            os.replace(temporary_path, csv_path)
            temporary_path = None

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
                    "row_count": processed_rows,
                }
            )

        report = CleaningReportModel(
            missing_stats=missing_stats,
            duplicate_count=duplicate_count,
            type_issues=type_issues,
            format_corrections=format_corrections,
            anomaly_flags=anomaly_flags,
            total_anomalies=total_anomalies,
            truncated_rows=truncated_rows,
        )
        return cleaned, report
    finally:
        if temporary_path is not None:
            with suppress(FileNotFoundError):
                os.unlink(temporary_path)


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
    gene_map: dict[str, str] | None = None,
    probe_gene_mapping: str = NOT_ATTEMPTED,
    skip_series_matrix: bool = False,
) -> tuple[ParsedDataset | None, str | None]:
    """Try series_matrix / supplementary expression; no-primary fallback.

    When the series_matrix has a non-empty ``!series_matrix_table_begin``/
    ``!series_matrix_table_end`` block, produces real expression rows and
    returns ``(parsed, None)``. When the block is empty but a supplementary
    expression asset is available (downloaded by the acquisition stage for
    RNA-seq series), parses that instead — real expression always wins.
    The supplementary parser does not require samples (GSM columns map
    directly, raw column names fall back), so supplementary recovery is
    attempted even when *samples* is empty; only the series-matrix block
    parse is skipped in that case (phase 4b T1 review round 2).

    ``skip_series_matrix=True`` skips the series-matrix block attempt
    entirely and goes straight to supplementary recovery. It is used on the
    live tximport-failure path where *source_asset* is a tximport COUNTS
    file, not a series matrix: routing counts bytes through the
    series-matrix parser could raise (e.g. gzip.BadGzipFile on corrupt
    bytes) and return ``series_matrix_expression_parse_failed`` before the
    supplementary branch is ever reached (phase 4b T1 review round 3).

    When no expression data can be recovered anywhere, returns
    ``(None, reason)`` where ``reason`` is a stable string recorded on
    ``ProcessingOutput.no_primary_reason``. The old metadata-only fallback
    (``_build_minimal_parsed_dataset`` / ``geo_minimal_placeholder``) is
    removed: without expression data no parsed primary dataset is produced
    (ADR-011 / phase 4b T1).

    ``gene_map`` / ``probe_gene_mapping`` are forwarded to the expression
    parser so probe rows can be rewritten to gene symbols and the annotation
    status (mapped/unmapped/...) is recorded in processing_parameters.
    """
    # The series_matrix expression block needs samples to map its columns;
    # the supplementary parser does NOT (GSM columns map directly and raw
    # column names fall back). So when *samples* is empty we skip only the
    # series-matrix block and still attempt supplementary recovery — the real
    # tximport-counts topology (tximport file + family SOFT, no series_matrix
    # asset) must not lose supplementary expression recovery just because the
    # SOFT yielded no samples (phase 4b T1 review round 2).
    if samples and not skip_series_matrix:
        try:
            expression_parsed = process_geo_series_matrix_expression(
                source_asset=source_asset,
                dataset_id=dataset_id,
                workdir=ctx.workdir,
                samples=samples,
                gene_map=gene_map,
                probe_gene_mapping=probe_gene_mapping,
            )
            if expression_parsed is not None:
                logger.info(
                    "processing: parsed %d expression rows from series_matrix",
                    expression_parsed.row_count,
                )
                return expression_parsed, None
        except (ValueError, FileNotFoundError, OSError) as exc:
            logger.warning(
                "processing: series_matrix expression parse failed (%s); "
                "no primary dataset (no expression data)",
                exc,
            )
            return None, "series_matrix_expression_parse_failed"

    # series_matrix 表达块为空（或样本不可用）—— 尝试 supplementary 表达矩阵
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
                return suppl_parsed, None
            # Supplementary asset is present but yielded no rows: the
            # reason must not claim "no supplementary file" (phase 4b T1
            # MUST-FIX 3).
            logger.info(
                "processing: supplementary expression file yielded no rows",
            )
            if not samples:
                return None, "series_matrix_samples_unavailable"
            return None, "series_matrix_expression_empty_and_supplementary_empty"
        except (ValueError, FileNotFoundError, OSError) as exc:
            logger.warning(
                "processing: supplementary expression parse failed (%s)",
                exc,
            )
            return None, "series_matrix_expression_empty_and_supplementary_unparsable"
    if not samples:
        # No samples recovered from the series_matrix (or SOFT) and no
        # supplementary asset: no expression data is available.
        return None, "series_matrix_samples_unavailable"
    logger.info(
        "processing: series_matrix expression block is empty; "
        "no primary dataset (no expression data)",
    )
    return None, "series_matrix_expression_empty_and_no_supplementary"


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


def _load_geo_gene_map(
    ctx: StageContext, geo: GeoSeriesRecord | None
) -> tuple[dict[str, str] | None, str]:
    """Load the platform probe → gene map for the first GPL of *geo*.

    Returns ``(map, status)``. When *geo* carries no platform, returns
    ``(None, NOT_ATTEMPTED)``. Download/discovery failures degrade to
    ``(None, "annotation_unavailable")`` — a missing probe→gene map is a
    data-quality warning, not a processing failure.
    """
    if geo is None or not geo.platform_ids:
        return None, NOT_ATTEMPTED
    gpl = geo.platform_ids[0]
    cache = ContentCache(ctx.workdir.root.parent.parent / "cache" / "ncbi")
    try:
        return fetch_platform_annotation(gpl, cache)
    except Exception as exc:
        logger.warning(
            "processing: GEO annotation fetch failed for %s (%s: %s)",
            gpl, type(exc).__name__, exc,
        )
        return None, "annotation_unavailable"


def _no_primary_digest(reason: str, samples: list[GeoSampleMetadata]) -> str:
    """Deterministic digest for the no-primary path (ADR-011 D1).

    The regular processing digest hashes the parsed file's sha256; with no
    parsed file (no expression data) we hash the reason string plus the
    canonical sample records — the full serialized ``GeoSampleMetadata``
    metadata (``model_dump`` with sorted keys, records sorted by sample_id) —
    so the digest is stable for identical inputs and changes when the
    recovered samples' metadata changes, not just their ids (phase 4b T1
    MUST-FIX 4).
    """
    import json

    sample_records = sorted(
        (sample.model_dump() for sample in samples),
        key=lambda record: record["sample_id"],
    )
    payload = json.dumps(
        {
            "no_primary_reason": reason,
            "samples": sample_records,
        },
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def run_processing(
    ctx: StageContext,
    source_assets: SourceAsset | list[SourceAsset],
    dataset_id: str,
    geo: GeoSeriesRecord | None = None,
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
    parsed: ParsedDataset | None = None
    no_primary_reason: str | None = None
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
            # Fixture-mode fallback: try series_matrix expression parsing;
            # if that finds no expression either, the tximport counts parse
            # failure is the root cause of the no-primary outcome.
            logger.warning(
                "processing: tximport parse failed (%s); attempting series_matrix recovery",
                exc,
            )
            samples = _recover_samples_from_series_matrix(source_asset, ctx)
            parsed, no_primary_reason = _try_series_matrix_expression_or_minimal(
                source_asset, dataset_id, ctx, samples, suppl_asset=suppl_asset
            )
            if parsed is None and no_primary_reason is not None:
                no_primary_reason = "tximport_parse_failed_no_expression"
    else:
        if soft_asset is not None and "tximportCounts" in source_asset.relative_path:
            try:
                soft_bytes = (ctx.workdir.root / soft_asset.relative_path).read_bytes()
                parsed = process_geo_tximport_counts(
                    source_asset=source_asset,
                    dataset_id=dataset_id,
                    workdir=ctx.workdir,
                    soft_gzip=soft_bytes,
                    logical_file=source_asset.relative_path.rsplit("/", 1)[-1],
                )
                samples = parse_geo_soft_samples(soft_bytes)
                logger.info(
                    "processing: parsed tximport counts (%d rows, %d samples)",
                    parsed.row_count,
                    len(samples),
                )
            except (ValueError, FileNotFoundError, OSError) as exc:
                # Live-mode fallback (REAL topology): when tximport counts
                # were downloaded, acquisition pairs them with the family SOFT
                # asset and there is NO series_matrix file in the workdir.
                # Recover samples from the family SOFT (soft_asset is
                # guaranteed present in this branch) and attempt supplementary
                # expression; if that finds no expression either, the tximport
                # counts parse failure is the root cause of the no-primary
                # outcome.
                logger.warning(
                    "processing: live tximport parse failed (%s); "
                    "recovering samples from family SOFT",
                    exc,
                )
                try:
                    soft_bytes = (
                        ctx.workdir.root / soft_asset.relative_path
                    ).read_bytes()
                    samples = parse_geo_soft_samples(soft_bytes)
                except (ValueError, FileNotFoundError, OSError) as soft_exc:
                    logger.warning(
                        "processing: family SOFT sample recovery failed (%s)",
                        soft_exc,
                    )
                    samples = []
                gene_map, probe_gene_mapping = _load_geo_gene_map(ctx, geo)
                parsed, no_primary_reason = _try_series_matrix_expression_or_minimal(
                    source_asset, dataset_id, ctx, samples,
                    suppl_asset=suppl_asset,
                    gene_map=gene_map,
                    probe_gene_mapping=probe_gene_mapping,
                    # source_asset here is the tximport COUNTS file, NOT a
                    # series matrix: never route counts bytes through the
                    # series-matrix parser (a corrupt counts gzip would raise
                    # BadGzipFile and short-circuit supplementary recovery —
                    # phase 4b T1 review round 3).
                    skip_series_matrix=True,
                )
                if parsed is None and no_primary_reason is not None:
                    no_primary_reason = "tximport_parse_failed_no_expression"
        else:
            samples = _recover_samples_from_series_matrix(source_asset, ctx)
            gene_map, probe_gene_mapping = _load_geo_gene_map(ctx, geo)
            parsed, no_primary_reason = _try_series_matrix_expression_or_minimal(
                source_asset, dataset_id, ctx, samples,
                suppl_asset=suppl_asset,
                gene_map=gene_map,
                probe_gene_mapping=probe_gene_mapping,
            )

    if parsed is None:
        # No expression data anywhere (empty block / parse failure / no
        # supplementary): ADR-011 — do NOT emit a metadata-only placeholder
        # primary. Recovered samples stay on the output for the supporting
        # sample_metadata.csv; the digest hashes the reason + canonical
        # sample records (deterministic, and independent of any parsed
        # file's sha256).
        logger.warning(
            "processing: no primary dataset; reason=%s (samples=%d)",
            no_primary_reason,
            len(samples),
        )
        ctx.emit_progress_sync(
            stage=StageName.PROCESSING,
            kind="cleaned_rows",
            current=0,
            total=None,
            detail={
                "dataset_id": dataset_id,
                "no_primary_reason": no_primary_reason or "no_expression_data",
            },
        )
        output = ProcessingOutput(
            parsed_datasets=[],
            samples=samples,
            no_primary_reason=no_primary_reason,
        )
        digest = _no_primary_digest(
            no_primary_reason or "no_expression_data", samples
        )
        return StageResult(output_digest=digest, output=output)

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
