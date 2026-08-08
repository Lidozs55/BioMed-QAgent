"""Phase 5 T8: tumor/normal sample grouping + pairing (red-first).

Covers the ``geo.sample-group.v1`` versioned extractor (key normalization,
high-confidence key priority, token matching, conflict → unknown + warning),
the explicit pairing extractor, series-level pairing validation, the shared
SOFT/series-matrix parser wiring, and the ``sample_metadata.csv`` artifact
columns (present only when the extractor produced evidence; the cell-line
GSE178352 fixture output stays byte-identical).
"""
from __future__ import annotations

import csv
import gzip
from datetime import UTC, datetime
from pathlib import Path

from app.domain.contracts import (
    Database,
    DataLevel,
    DatasetSelection,
    SourceAsset,
    SourceRecord,
    TaskSpecification,
    asset_id_from_sha256,
)
from app.pipeline.processing.geo_tximport import (
    GROUP_RULE_ID,
    GeoSampleMetadata,
    extract_pairing_id,
    extract_sample_group,
    parse_geo_series_matrix_samples,
    parse_geo_soft_samples,
    validate_pairings,
)
from app.pipeline.stages.artifact_build.builder import run_artifact_build
from app.pipeline.stages.base import StageContext
from app.tools.workdir import create_task_workdir

FIXTURE_DIR = (
    Path(__file__).parents[1] / "fixtures" / "ncbi" / "gse178352"
)

_NO_DATA_REASON = "series_matrix_expression_empty_and_no_supplementary"


def _sample(
    sample_id: str,
    *,
    sample_group: str = "unknown",
    sample_group_raw: str = "",
    pairing_id: str | None = None,
) -> GeoSampleMetadata:
    return GeoSampleMetadata(
        sample_id=sample_id,
        source_alias=sample_id,
        cell_line_raw="",
        cell_line_canonical="",
        normalization_rule="identity",
        treatment="",
        replicate=1,
        sample_group=sample_group,
        sample_group_raw=sample_group_raw,
        pairing_id=pairing_id,
        group_rule_id=GROUP_RULE_ID,
    )


# ---------------------------------------------------------------------------
# extract_sample_group — canonical keys / aliases
# ---------------------------------------------------------------------------


def test_extract_sample_group_canonical_high_confidence_keys() -> None:
    """Every canonical high-confidence key classifies its value (词汇表 point 2)."""
    assert extract_sample_group({"sample type": "tumor"}, None).sample_group == "tumor"
    assert extract_sample_group({"tissue type": "normal"}, None).sample_group == "normal"
    assert extract_sample_group({"disease state": "tumor"}, None).sample_group == "tumor"
    assert extract_sample_group({"condition": "normal"}, None).sample_group == "normal"
    assert extract_sample_group({"tumor normal": "tumor"}, None).sample_group == "tumor"
    assert extract_sample_group({"tumour normal": "normal"}, None).sample_group == "normal"


def test_extract_sample_group_normalizes_keys_and_values() -> None:
    """Keys are trimmed, lowercased, and ``_``/``-`` map to spaces; values are
    matched case-insensitively (词汇表 point 1)."""
    assert extract_sample_group({"TISSUE_TYPE": "Tumor"}, None).sample_group == "tumor"
    assert extract_sample_group({"Tissue-Type": "Normal"}, None).sample_group == "normal"
    assert extract_sample_group({"  sample type  ": "tumor"}, None).sample_group == "tumor"
    assert extract_sample_group({"tissue type": "  Tumor  "}, None).sample_group == "tumor"


def test_extract_sample_group_token_variants() -> None:
    """Tumor/normal token lists (词汇表 point 3): phrases are not misread as
    single-word conflicts."""
    assert extract_sample_group({"tissue type": "non-tumor"}, None).sample_group == "normal"
    assert extract_sample_group({"tissue type": "non tumour"}, None).sample_group == "normal"
    assert extract_sample_group({"tissue type": "adjacent normal"}, None).sample_group == "normal"
    assert extract_sample_group({"tissue type": "normal adjacent"}, None).sample_group == "normal"
    assert extract_sample_group({"sample type": "primary tumor"}, None).sample_group == "tumor"
    assert extract_sample_group({"tissue type": "metastatic"}, None).sample_group == "tumor"
    assert extract_sample_group({"disease state": "carcinoma"}, None).sample_group == "tumor"
    assert extract_sample_group({"condition": "healthy"}, None).sample_group == "normal"


# ---------------------------------------------------------------------------
# extract_sample_group — conflict / unknown
# ---------------------------------------------------------------------------


def test_extract_sample_group_same_priority_conflict_is_unknown_with_warning() -> None:
    """Two high-confidence keys disagreeing → unknown + warning, no voting
    (词汇表 point 4)."""
    result = extract_sample_group(
        {"sample type": "tumor", "condition": "normal"}, None
    )
    assert result.sample_group == "unknown"
    assert result.sample_group_raw == "sample type:tumor"
    assert result.warnings
    assert any("conflict" in warning for warning in result.warnings)
    assert any("condition:normal" in warning for warning in result.warnings)


def test_extract_sample_group_internal_value_conflict_is_unknown_with_warning() -> None:
    """A single value carrying both tumor and normal markers is also a
    same-priority conflict → unknown + warning."""
    result = extract_sample_group({"condition": "tumor and normal"}, None)
    assert result.sample_group == "unknown"
    assert any("conflict" in warning for warning in result.warnings)


def test_extract_sample_group_unrecognized_value_is_unknown_without_warning() -> None:
    """A high-confidence key whose value matches no token → unknown, no raw
    (未命中), and no warning — only conflicts warn."""
    result = extract_sample_group({"condition": "treated"}, None)
    assert result.sample_group == "unknown"
    assert result.sample_group_raw == ""
    assert result.warnings == []


def test_extract_sample_group_absent_or_non_classification_characteristics() -> None:
    """No classification field at all → unknown with no raw/warnings."""
    for characteristics in (None, {}, {"cell line": "MCF7", "treatment": "DMSO"}):
        result = extract_sample_group(characteristics, None)
        assert result.sample_group == "unknown"
        assert result.sample_group_raw == ""
        assert result.warnings == []


def test_extract_sample_group_raw_prefers_earlier_priority_key() -> None:
    """sample_group_raw records the highest-priority classified hit."""
    result = extract_sample_group(
        {"condition": "treated", "tissue type": "tumor"}, None
    )
    assert result.sample_group == "tumor"
    assert result.sample_group_raw == "tissue type:tumor"


def test_extract_sample_group_honors_rule_id_override() -> None:
    """The versioned rule id appears in warning messages so callers can see
    which rule produced the outcome."""
    result = extract_sample_group(
        {"sample type": "tumor", "condition": "normal"},
        None,
        rule_id="geo.sample-group.v2",
    )
    assert result.sample_group == "unknown"
    assert any("geo.sample-group.v2" in warning for warning in result.warnings)


# ---------------------------------------------------------------------------
# extract_sample_group — cell-line semantics
# ---------------------------------------------------------------------------


def test_extract_sample_group_cell_line_control_is_not_auto_normal() -> None:
    """``control`` alone is not a normal token (only ``control tissue`` is),
    so a cell-line sample with ``condition: control`` stays unknown — the
    vocab's cell-line guard (词汇表 point 3)."""
    for characteristics in (
        {"condition": "control"},
        {"cell line": "MCF7", "condition": "control"},
    ):
        result = extract_sample_group(characteristics, None)
        assert result.sample_group == "unknown"
        assert result.sample_group != "normal"
    assert extract_sample_group({"condition": "control tissue"}, None).sample_group == "normal"


def test_extract_sample_group_low_priority_source_name_and_title() -> None:
    """Without high-confidence fields, ``source name`` then title provide
    low-priority evidence (词汇表 point 2)."""
    result = extract_sample_group({"source name": "tumor tissue"}, None)
    assert result.sample_group == "tumor"
    assert result.sample_group_raw == "source name:tumor tissue"
    result = extract_sample_group({}, "Tumor sample from patient 01")
    assert result.sample_group == "tumor"
    assert result.sample_group_raw == "title:Tumor sample from patient 01"


def test_extract_sample_group_low_priority_conflict_warns() -> None:
    """source name and title disagreeing (both low priority) → unknown + warning."""
    result = extract_sample_group(
        {"source name": "tumor tissue"}, "Normal adjacent tissue"
    )
    assert result.sample_group == "unknown"
    assert any("conflict" in warning for warning in result.warnings)


def test_extract_sample_group_cell_line_skips_low_priority_evidence() -> None:
    """Samples declaring a ``cell line`` characteristic are in-vitro models:
    low-priority source-name/title evidence must NOT classify them, even when
    the title says 'Breast Cancer cells' (T8 fixture regression guard)."""
    result = extract_sample_group(
        {"cell line": "MD-MBA-231"}, "Breast Cancer cells rep. 1"
    )
    assert result.sample_group == "unknown"
    assert result.sample_group_raw == ""


# ---------------------------------------------------------------------------
# extract_pairing_id — explicit keys only
# ---------------------------------------------------------------------------


def test_extract_pairing_id_explicit_keys() -> None:
    """All six explicit pairing keys are accepted (词汇表 point 6)."""
    assert extract_pairing_id({"patient id": "P1"}) == "p1"
    assert extract_pairing_id({"subject id": "S1"}) == "s1"
    assert extract_pairing_id({"pair id": "pair-1"}) == "pair 1"
    assert extract_pairing_id({"pairing id": "P2"}) == "p2"
    assert extract_pairing_id({"donor id": "D3"}) == "d3"
    assert extract_pairing_id({"individual id": "I4"}) == "i4"


def test_extract_pairing_id_normalizes_to_stable_value() -> None:
    """Inconsistent case/separators normalize to one stable pairing_id."""
    assert extract_pairing_id({"patient id": "Patient 1"}) == "patient 1"
    assert extract_pairing_id({"patient id": "Patient-1"}) == "patient 1"
    assert extract_pairing_id({"PATIENT_ID": "P1"}) == "p1"


def test_extract_pairing_id_absent() -> None:
    """No explicit pairing key → no pairing (never inferred from GSM order,
    title similarity, or same-GSE membership)."""
    assert extract_pairing_id(None) is None
    assert extract_pairing_id({}) is None
    assert extract_pairing_id({"cell line": "MCF7", "treatment": "DMSO"}) is None


def test_extract_pairing_id_first_matching_key_wins() -> None:
    """When several explicit pairing keys are present the earlier vocabulary
    key takes precedence."""
    assert extract_pairing_id({"donor id": "D1", "patient id": "P1"}) == "p1"


# ---------------------------------------------------------------------------
# validate_pairings — one-sided warning / valid pair
# ---------------------------------------------------------------------------


def test_validate_pairings_one_sided_warning() -> None:
    """A pairing with only one group (tumor-only or normal-only) warns; no
    valid tumor/normal pair exists (词汇表 point 6)."""
    warnings = validate_pairings([
        _sample("GSM1", sample_group="tumor", pairing_id="p1"),
        _sample("GSM2", sample_group="tumor", pairing_id="p1"),
        _sample("GSM3", sample_group="normal", pairing_id="p2"),
    ])
    assert len(warnings) == 2
    assert any("p1" in warning for warning in warnings)
    assert any("p2" in warning for warning in warnings)


def test_validate_pairings_tumor_normal_pair_is_valid() -> None:
    """The same pairing_id with both tumor and normal samples forms a valid
    pair and produces no warning; a one-sided sibling still warns."""
    warnings = validate_pairings([
        _sample("GSM1", sample_group="tumor", pairing_id="p1"),
        _sample("GSM2", sample_group="normal", pairing_id="p1"),
        _sample("GSM3", sample_group="tumor", pairing_id="p2"),
    ])
    assert len(warnings) == 1
    assert "p1" not in warnings[0]
    assert "p2" in warnings[0]


def test_validate_pairings_unknown_group_does_not_satisfy_side() -> None:
    """Unknown-group samples never complete a pair side."""
    warnings = validate_pairings([
        _sample("GSM1", sample_group="tumor", pairing_id="p1"),
        _sample("GSM2", sample_group="unknown", pairing_id="p1"),
    ])
    assert any("p1" in warning for warning in warnings)


def test_validate_pairings_ignores_unpaired_samples() -> None:
    """Samples without a pairing_id are not part of any pairing check."""
    assert validate_pairings([
        _sample("GSM1", sample_group="tumor"),
        _sample("GSM2", sample_group="normal"),
    ]) == []


# ---------------------------------------------------------------------------
# parser wiring — shared versioned extractor for SOFT and series_matrix
# ---------------------------------------------------------------------------


def _soft_bytes(samples: list[dict[str, object]]) -> bytes:
    """Build a minimal SOFT gzip payload. Each sample dict carries sample_id,
    alias, title (must contain ``rep. N``), and optional ``characteristics``
    list of ``"key: value"`` strings."""
    lines: list[str] = []
    for sample in samples:
        lines.append(f"^SAMPLE = {sample['sample_id']}")
        lines.append(f"!Sample_description = Sample {sample['alias']}")
        lines.append(f"!Sample_title = {sample['title']}")
        for characteristic in sample.get("characteristics", []):
            lines.append(f"!Sample_characteristics_ch1 = {characteristic}")
    return gzip.compress("\n".join(lines).encode("utf-8"), mtime=0)


def test_soft_parser_populates_sample_group_and_pairing_fields() -> None:
    """The SOFT parser wires the shared extractor: tumor/normal samples with
    explicit patient pairing carry sample_group/sample_group_raw/pairing_id/
    group_rule_id."""
    soft = _soft_bytes([
        {
            "sample_id": "GSM9000100", "alias": "T1",
            "title": "Tumor patient P1 rep. 1",
            "characteristics": ["tissue type: tumor", "patient id: P1"],
        },
        {
            "sample_id": "GSM9000101", "alias": "T2",
            "title": "Normal patient P1 rep. 2",
            "characteristics": ["tissue type: normal", "patient id: P1"],
        },
    ])
    samples = parse_geo_soft_samples(soft)
    assert len(samples) == 2
    by_id = {sample.sample_id: sample for sample in samples}
    assert by_id["GSM9000100"].sample_group == "tumor"
    assert by_id["GSM9000100"].sample_group_raw == "tissue type:tumor"
    assert by_id["GSM9000100"].pairing_id == "p1"
    assert by_id["GSM9000101"].sample_group == "normal"
    assert by_id["GSM9000101"].sample_group_raw == "tissue type:normal"
    assert by_id["GSM9000101"].pairing_id == "p1"
    assert all(sample.group_rule_id == GROUP_RULE_ID for sample in samples)


def test_series_matrix_parser_populates_sample_group_and_pairing_fields() -> None:
    """The series_matrix parser wires the same versioned extractor."""
    matrix = (
        '!Series_title\t"Tumor normal series"\n'
        '!Sample_geo_accession\t"GSM9000200"\t"GSM9000201"\n'
        '!Sample_title\t"Tumor P1"\t"Normal P1"\n'
        '!Sample_organism_ch1\t"Homo sapiens"\t"Homo sapiens"\n'
        '!Sample_characteristics_ch1\t"tissue type: tumor"\t"tissue type: normal"\n'
        '!Sample_characteristics_ch1\t"subject id: P1"\t"subject id: P1"\n'
        '!series_matrix_table_begin\n'
        '"ID_REF"\t"GSM9000200"\t"GSM9000201"\n'
        '!series_matrix_table_end\n'
    )
    compressed = gzip.compress(matrix.encode("utf-8"), mtime=0)
    samples = parse_geo_series_matrix_samples(compressed)
    assert len(samples) == 2
    by_id = {sample.sample_id: sample for sample in samples}
    assert by_id["GSM9000200"].sample_group == "tumor"
    assert by_id["GSM9000200"].sample_group_raw == "tissue type:tumor"
    assert by_id["GSM9000200"].pairing_id == "p1"
    assert by_id["GSM9000201"].sample_group == "normal"
    assert by_id["GSM9000201"].pairing_id == "p1"
    assert by_id["GSM9000200"].group_rule_id == GROUP_RULE_ID


def test_existing_cell_line_fixture_samples_stay_unknown() -> None:
    """T8 fixture regression: GSE178352 declares cell-line/treatment
    characteristics only — no high-confidence classification key, no pairing
    key — so every recovered sample stays sample_group="unknown" with empty
    raw and no pairing. The extractor must NOT read 'Breast Cancer cells' out
    of the fixture titles (cell-line samples skip low-priority evidence)."""
    samples = parse_geo_soft_samples(
        (FIXTURE_DIR / "gse178352_family.soft.gz").read_bytes()
    )
    assert len(samples) == 12
    for sample in samples:
        assert sample.sample_group == "unknown"
        assert sample.sample_group_raw == ""
        assert sample.pairing_id is None
        assert sample.group_rule_id == GROUP_RULE_ID


# ---------------------------------------------------------------------------
# sample_metadata artifact — extended columns only with evidence
# ---------------------------------------------------------------------------


def _stage_context(tmp_path: Path) -> StageContext:
    return StageContext(
        task_id="task_t8_group",
        workdir=create_task_workdir(
            "task_t8_group", base_dir=str(tmp_path / "tasks")
        ),
        fixture_dir=tmp_path,
        topic="GSE999999",
        started_at=datetime.now(UTC),
        mode="fixture",
        databases=["geo"],
        specification=TaskSpecification(
            topic="GSE999999",
            datasets=[
                DatasetSelection(
                    dataset_id="ds_gse999999",
                    database=Database.GEO,
                    accession="GSE999999",
                    reason="explicit",
                    source_id="src_geo_gse999999",
                )
            ],
        ),
    )


def _geo_source(
    ctx: StageContext, now: datetime
) -> tuple[SourceRecord, SourceAsset]:
    source_asset = SourceAsset(
        asset_id=asset_id_from_sha256("d" * 64),
        kind="source",
        relative_path="source_assets/GSE999999_series_matrix.txt.gz",
        sha256="d" * 64,
        size_bytes=2316,
        media_type="application/gzip",
        source_id="src_geo_gse999999",
        successful_attempt_id="attempt_matrix",
        data_level=DataLevel.REPOSITORY_PROCESSED,
    )
    source_record = SourceRecord(
        source_id="src_geo_gse999999",
        database=Database.GEO,
        accession="GSE999999",
        url="https://ftp.ncbi.nlm.nih.gov/geo/series/GSE999nnn/GSE999999/matrix/GSE999999_series_matrix.txt.gz",
        title="GSE999999 series matrix",
        retrieved_at=now,
    )
    return source_record, source_asset


def _build_no_data(
    ctx: StageContext,
    now: datetime,
    *,
    samples: list[GeoSampleMetadata],
) -> object:
    source_record, source_asset = _geo_source(ctx, now)
    return run_artifact_build(
        ctx=ctx,
        sources=[source_record],
        source_assets=[source_asset],
        download_attempts=[],
        parsed_dataset=None,
        parsed_datasets=[],
        no_primary_reason=_NO_DATA_REASON,
        samples=samples,
        literature=None,
        geo=None,
        specification=ctx.specification,
        retrieved_at=now,
        stage_attempt_id="attempt_build",
        dataset_id="ds_gse999999",
        dataset_source_id="src_geo_gse999999",
        dataset_accession="GSE999999",
        cleaning_report=None,
    )


def _read_csv(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def test_sample_metadata_artifact_gains_group_columns_with_evidence(
    tmp_path: Path,
) -> None:
    """When the extractor produced evidence (non-empty raw / pairing), the
    sample_metadata.csv rows gain sample_group/sample_group_raw/pairing_id/
    group_rule_id."""
    ctx = _stage_context(tmp_path)
    now = datetime.now(UTC)
    result = _build_no_data(ctx, now, samples=[
        _sample(
            "GSM9999991",
            sample_group="tumor",
            sample_group_raw="tissue type:tumor",
            pairing_id="p1",
        ),
        _sample(
            "GSM9999992",
            sample_group="normal",
            sample_group_raw="tissue type:normal",
            pairing_id="p1",
        ),
    ])
    sample_rows = _read_csv(result.output.staging_dir / "sample_metadata.csv")
    assert len(sample_rows) == 2
    assert {
        "sample_group", "sample_group_raw", "pairing_id", "group_rule_id",
    } <= set(sample_rows[0])
    by_id = {row["sample_id"]: row for row in sample_rows}
    assert by_id["GSM9999991"]["sample_group"] == "tumor"
    assert by_id["GSM9999991"]["sample_group_raw"] == "tissue type:tumor"
    assert by_id["GSM9999991"]["pairing_id"] == "p1"
    assert by_id["GSM9999991"]["group_rule_id"] == GROUP_RULE_ID
    assert by_id["GSM9999992"]["sample_group"] == "normal"


def test_sample_metadata_artifact_unchanged_without_group_evidence(
    tmp_path: Path,
) -> None:
    """T8 fixture regression at the artifact level: cell-line/treatment-only
    samples (the GSE178352 shape) produce no extractor evidence, so
    sample_metadata.csv keeps the historic base columns — no group columns,
    byte-identical header."""
    ctx = _stage_context(tmp_path)
    now = datetime.now(UTC)
    samples = parse_geo_soft_samples(
        (FIXTURE_DIR / "gse178352_family.soft.gz").read_bytes()
    )
    result = _build_no_data(ctx, now, samples=samples)
    sample_rows = _read_csv(result.output.staging_dir / "sample_metadata.csv")
    assert len(sample_rows) == 12
    assert set(sample_rows[0]) == {
        "sample_id", "dataset_id", "source_id", "source_sample_alias",
        "cell_line_raw", "cell_line_canonical", "normalization_rule",
        "treatment", "replicate", "organism", "source_url",
    }


# ---------------------------------------------------------------------------
# Phase 5 final review F6: T8 warnings persisted into warnings.csv
# ---------------------------------------------------------------------------


def test_artifact_warnings_persist_group_conflict_and_one_sided_pairing(
    tmp_path: Path,
) -> None:
    """F6: conflict (unknown + raw evidence) and one-sided-pairing warnings
    exposed by the T8 extractors must reach the built warnings.csv via the
    same artifact channel as the cell-line corrections."""
    ctx = _stage_context(tmp_path)
    now = datetime.now(UTC)
    result = _build_no_data(ctx, now, samples=[
        # Conflict: high-confidence tumor marker + normal marker → the
        # extractor emits a warning and keeps sample_group_raw evidence.
        _sample(
            "GSM9999991",
            sample_group="unknown",
            sample_group_raw="tissue type:tumor",
        ),
        # One-sided pairing: only a tumor side exists for pairing p9.
        _sample(
            "GSM9999992",
            sample_group="tumor",
            sample_group_raw="tissue type:tumor",
            pairing_id="p9",
        ),
    ])
    warning_rows = _read_csv(result.output.staging_dir / "warnings.csv")
    codes = {row["code"] for row in warning_rows}
    assert "sample_group_conflict" in codes
    assert "pairing_one_sided" in codes
    conflict = [row for row in warning_rows if row["code"] == "sample_group_conflict"]
    assert len(conflict) == 1
    assert "conflict" in conflict[0]["message"]
    assert conflict[0]["record_id"] == "GSM9999991"
    one_sided = [row for row in warning_rows if row["code"] == "pairing_one_sided"]
    assert any("p9" in row["message"] for row in one_sided)


def test_artifact_warnings_skip_clean_group_evidence(tmp_path: Path) -> None:
    """F6 complement: samples with clean (non-conflicting) group evidence and
    a valid tumor/normal pairing produce no T8 warning rows."""
    ctx = _stage_context(tmp_path)
    now = datetime.now(UTC)
    result = _build_no_data(ctx, now, samples=[
        _sample(
            "GSM9999991",
            sample_group="tumor",
            sample_group_raw="tissue type:tumor",
            pairing_id="p1",
        ),
        _sample(
            "GSM9999992",
            sample_group="normal",
            sample_group_raw="tissue type:normal",
            pairing_id="p1",
        ),
    ])
    warning_rows = _read_csv(result.output.staging_dir / "warnings.csv")
    codes = {row["code"] for row in warning_rows}
    assert "sample_group_conflict" not in codes
    assert "pairing_one_sided" not in codes
