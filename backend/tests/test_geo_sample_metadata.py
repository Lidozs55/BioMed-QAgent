"""Phase 5 T8: versioned GEO sample grouping and explicit pairing."""

from __future__ import annotations

from io import StringIO

from app.datasets.build.geo_sample_metadata import (
    GROUP_RULE_ID,
    GeoSampleMetadata,
    extract_pairing_id,
    extract_sample_group,
    parse_geo_series_matrix_samples,
    parse_geo_soft_samples,
    validate_pairings,
)


def _sample(
    sample_id: str,
    group: str,
    pairing_id: str | None,
) -> GeoSampleMetadata:
    return GeoSampleMetadata(
        sample_id=sample_id,
        sample_group=group,
        pairing_id=pairing_id,
    )


def test_grouping_normalizes_keys_and_preserves_raw_evidence() -> None:
    result = extract_sample_group({"TISSUE_TYPE": "Primary Tumor"}, None)

    assert result.sample_group == "tumor"
    assert result.sample_group_raw == "TISSUE_TYPE:Primary Tumor"
    assert result.warnings == []


def test_grouping_conflict_is_unknown_and_cell_line_control_is_not_normal() -> None:
    conflict = extract_sample_group(
        {"sample type": "tumor", "condition": "normal"}, None
    )
    control = extract_sample_group(
        {"cell line": "MCF7", "condition": "control"}, "Cancer control"
    )

    assert conflict.sample_group == "unknown"
    assert conflict.warnings and "conflicting" in conflict.warnings[0]
    assert control.sample_group == "unknown"


def test_pairing_accepts_only_explicit_normalized_keys() -> None:
    assert extract_pairing_id({"PATIENT_ID": "Patient-01"}) == "patient 01"
    assert extract_pairing_id({"sample name": "Patient-01"}) is None


def test_pairing_validation_requires_both_tumor_and_normal_sides() -> None:
    warnings = validate_pairings(
        [
            _sample("GSM1", "tumor", "p1"),
            _sample("GSM2", "normal", "p1"),
            _sample("GSM3", "tumor", "p2"),
        ]
    )

    assert len(warnings) == 1
    assert "p2" in warnings[0]
    assert "p1" not in warnings[0]


def test_series_matrix_and_soft_share_the_versioned_extractor() -> None:
    matrix = StringIO(
        '!Sample_geo_accession\t"GSM10"\t"GSM11"\n'
        '!Sample_title\t"Tumor P1"\t"Normal P1"\n'
        '!Sample_organism_ch1\t"Homo sapiens"\t"Homo sapiens"\n'
        '!Sample_platform_id\t"GPL570"\t"GPL570"\n'
        '!Sample_characteristics_ch1\t"tissue type: tumor"\t"tissue type: normal"\n'
        '!Sample_characteristics_ch1\t"subject id: P1"\t"subject id: P1"\n'
        '!series_matrix_table_begin\n'
    )
    soft = StringIO(
        '^SAMPLE = GSM10\n'
        '!Sample_description = Sample A1\n'
        '!Sample_title = Tumor P1\n'
        '!Sample_platform_id = GPL570\n'
        '!Sample_characteristics_ch1 = tissue type: tumor\n'
        '!Sample_characteristics_ch1 = subject id: P1\n'
    )

    matrix_samples, matrix_warnings = parse_geo_series_matrix_samples(matrix)
    soft_samples, soft_warnings = parse_geo_soft_samples(soft)

    assert matrix_warnings == []
    assert soft_warnings == [
        "pairing p1 is one-sided (groups=['tumor']) - no valid tumor/normal pair"
    ]
    assert [sample.sample_group for sample in matrix_samples] == ["tumor", "normal"]
    assert [sample.pairing_id for sample in matrix_samples] == ["p1", "p1"]
    assert matrix_samples[0].platform_id == "GPL570"
    assert soft_samples[0].sample_group == "tumor"
    assert soft_samples[0].source_sample_alias == "A1"
    assert soft_samples[0].group_rule_id == GROUP_RULE_ID
