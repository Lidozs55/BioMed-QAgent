"""Field mapping and field description CSV building helpers.

Builds ``field_mapping.csv`` rows from the alignment result and
``field_descriptions.csv`` rows from the parsed dataset's columns (TODO §1.2).
"""
from __future__ import annotations

from app.domain.contracts import ParsedDataset
from app.pipeline.processing.geo_tximport import GeoSampleMetadata
from app.pipeline.stages.artifact_build.columns import _FIELD_DESCRIPTIONS


def _build_field_mapping_rows(
    dataset_id: str,
    source_id: str,
    field_alignment: dict[str, list[str]] | None,
    samples: list[GeoSampleMetadata],
    parsed_datasets: list[ParsedDataset] | None = None,
) -> list[dict[str, object]]:
    """Build ``field_mapping.csv`` rows from the alignment result.

    When ``field_alignment`` is available (e.g. from ``alignment.normalize_field_names``),
    each entry maps ``raw_field → canonical_field`` with a confidence score
    derived from the similarity heuristic. Falls back to the per-sample
    expression-value mapping when alignment is missing. Every row carries the
    originating ``source_id`` so multi-source runs keep one mapping group per
    SourceAsset (§1.5.3).

    For a multi-dataset alignment (``parsed_datasets`` with ≥2 entries) the
    alignment list has one slot per dataset; one mapping group is emitted per
    dataset so ``field_mapping.csv`` reflects the real merge used to build
    ``main_data.csv`` (TODO §1.2).
    """
    if field_alignment:
        rows: list[dict[str, object]] = []
        num_datasets = len(parsed_datasets) if parsed_datasets else 1
        for norm_name, originals in field_alignment.items():
            if len(originals) < num_datasets:
                continue
            for ds_index in range(num_datasets):
                raw = originals[ds_index]
                if not raw:
                    continue
                rows.append({
                    "dataset_id": (
                        parsed_datasets[ds_index].dataset_id
                        if parsed_datasets and ds_index < len(parsed_datasets)
                        else dataset_id
                    ),
                    "source_id": (
                        parsed_datasets[ds_index].source_id
                        if parsed_datasets and ds_index < len(parsed_datasets)
                        else source_id
                    ),
                    "raw_field": raw,
                    "canonical_field": norm_name,
                    "conversion": "identity",
                    "confidence": "1.0" if raw == norm_name else "0.9",
                    "notes": "alignment:align_fields",
                })
        return rows

    # Fallback: per-sample expression_value mapping (backward compat).
    return [
        {
            "dataset_id": dataset_id,
            "source_id": source_id,
            "raw_field": f"counts.{sample.source_alias}",
            "canonical_field": "expression_value",
            "conversion": "identity numeric parse",
            "confidence": "1.0",
            "notes": sample.sample_id,
        }
        for sample in samples
    ]


def _build_field_descriptions_rows(
    primary: ParsedDataset | None = None,
) -> list[dict[str, object]]:
    """Build ``field_descriptions.csv`` rows for the primary parsed dataset.

    Looks up each column in ``_FIELD_DESCRIPTIONS``; unknown columns fall back
    to a generic ``("string", "Source column", "", "true", "")`` entry.
    When there is no primary (phase 4b NO_DATA package) there are no parsed
    columns to describe, so the file is header-only.
    """
    if primary is None:
        return []
    field_descriptions: list[dict[str, object]] = []
    for field in primary.columns:
        metadata = _FIELD_DESCRIPTIONS.get(field, ("string", "Source column", "", "true", ""))
        field_descriptions.append({
            "field_name": field,
            "data_type": metadata[0],
            "description": metadata[1],
            "unit": metadata[2],
            "nullable": metadata[3],
            "source": primary.parser_name,
            "example": metadata[4],
        })
    return field_descriptions
