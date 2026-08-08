"""GEO tximport-count processing with exact source coordinates."""

from __future__ import annotations

import csv
import gzip
import hashlib
import re
from dataclasses import dataclass
from typing import Literal

from pydantic import Field

from app.domain.contracts import (
    ContractModel,
    FileAsset,
    ParsedDataset,
    SourceAsset,
    asset_id_from_sha256,
    make_record_id,
)
from app.tools.workdir import TaskWorkDir

GROUP_RULE_ID = "geo.sample-group.v1"

GroupLabel = Literal["tumor", "normal", "unknown"]

# T8 词汇表定稿 (phase 5): versioned, closed vocabulary for tumor/normal
# sample grouping and explicit pairing. High-confidence keys are listed in
# priority order; every present high-confidence hit is same-priority evidence
# (a conflict between them → unknown + warning, never token-count voting).
_HIGH_CONFIDENCE_KEYS: tuple[str, ...] = (
    "sample type",
    "tissue type",
    "disease state",
    "condition",
    "tumor normal",
    "tumour normal",
)

# Multi-word tokens are matched (and their words consumed) before single
# words so "non-tumor" / "adjacent normal" / "primary tumor" classify
# directly instead of surfacing as single-word conflicts ("non tumor"
# contains "tumor"). "control" alone is NOT a normal token — only
# "control tissue" is, so cell-line "control" never auto-classifies normal.
_GROUP_PHRASES: tuple[tuple[str, GroupLabel], ...] = (
    ("primary tumor", "tumor"),
    ("adjacent normal", "normal"),
    ("normal adjacent", "normal"),
    ("non tumor", "normal"),
    ("non tumour", "normal"),
    ("control tissue", "normal"),
)
_TUMOR_WORDS: frozenset[str] = frozenset({
    "tumor", "tumour", "cancer", "carcinoma", "malignant", "metastatic",
})
_NORMAL_WORDS: frozenset[str] = frozenset({"normal", "healthy"})

# Pairing is accepted ONLY from these explicit keys (词汇表 point 6) — never
# inferred from GSM order, title similarity, or same-GSE membership.
_PAIRING_KEYS: tuple[str, ...] = (
    "pair id",
    "pairing id",
    "patient id",
    "subject id",
    "donor id",
    "individual id",
)


class GeoSampleMetadata(ContractModel):
    sample_id: str = Field(pattern=r"^GSM\d+$")
    # source_alias historically matched GSE178352's A/B nomenclature, but the
    # pipeline now also ingests arbitrary GEO series (via series_matrix) where
    # the only stable per-sample identifier is the GSM accession itself.
    source_alias: str = Field(pattern=r"^[A-Za-z0-9_-]+$")
    cell_line_raw: str
    cell_line_canonical: str
    normalization_rule: str
    treatment: str
    replicate: int = Field(ge=1)
    organism: str = "Homo sapiens"
    # Phase 5 T8: tumor/normal grouping + explicit pairing. Populated by the
    # shared versioned extractors below (group_rule_id="geo.sample-group.v1");
    # samples without classification fields stay sample_group="unknown".
    sample_group: GroupLabel = "unknown"
    sample_group_raw: str = ""
    pairing_id: str | None = None
    group_rule_id: str = GROUP_RULE_ID


_CELL_LINE_CANONICAL = {
    "MD-MBA-231": "MDA-MB-231",
    "MD-MBA-453": "MDA-MB-453",
}


@dataclass
class SampleGroupResult:
    """Outcome of the versioned tumor/normal group extractor."""

    sample_group: GroupLabel
    sample_group_raw: str
    warnings: list[str]


def _normalize_token(text: str) -> str:
    """T8 vocabulary key/value normalization (词汇表 point 1): trim,
    lowercase, ``_``/``-`` → space, collapse whitespace."""
    return " ".join(
        text.strip().lower().replace("_", " ").replace("-", " ").split()
    )


def _value_words(value: str) -> list[str]:
    """Lowercase alphanumeric word tokens of a characteristic value."""
    return re.findall(r"[a-z0-9]+", _normalize_token(value))


def _matched_group_tokens(value: str) -> set[str]:
    """Set of groups ("tumor"/"normal") matched by a value's tokens.

    Multi-word phrases are matched and their words consumed before single
    words, so "non-tumor" / "adjacent normal" / "primary tumor" classify
    directly instead of surfacing as single-word conflicts. Returns the
    empty set when no token matches (including cell-line "control", which
    is not a normal token unless it reads "control tissue").
    """
    words = _value_words(value)
    if not words:
        return set()
    remaining = list(words)
    matched: set[str] = set()
    for phrase, group in _GROUP_PHRASES:
        phrase_words = phrase.split(" ")
        for start in range(len(remaining) - len(phrase_words) + 1):
            if remaining[start : start + len(phrase_words)] == phrase_words:
                del remaining[start : start + len(phrase_words)]
                matched.add(group)
                break
    for word in remaining:
        if word in _TUMOR_WORDS:
            matched.add("tumor")
        if word in _NORMAL_WORDS:
            matched.add("normal")
    return matched


def _raw_evidence(raw_key: str, raw_value: str) -> str:
    """``key:value`` evidence string for ``sample_group_raw``."""
    return f"{raw_key.strip()}:{raw_value.strip()}"


def _classify_evidence(
    evidence: list[tuple[str, str]], rule_id: str
) -> SampleGroupResult:
    """Classify same-priority evidence entries ``(raw_key, raw_value)``.

    ``sample_group_raw`` keeps the ``key:value`` of the highest-priority
    classified hit; a conflict between tumor and normal markers →
    ``unknown`` + a warning (词汇表 point 4 — no token-count voting).
    """
    classified: list[tuple[str, str, set[str]]] = []
    for raw_key, raw_value in evidence:
        groups = _matched_group_tokens(raw_value)
        if groups:
            classified.append((raw_key, raw_value, groups))
    if not classified:
        return SampleGroupResult("unknown", "", [])
    raw_key, raw_value, _ = classified[0]
    raw = _raw_evidence(raw_key, raw_value)
    matched_groups: set[str] = set()
    for _, _, groups in classified:
        matched_groups |= groups
    if matched_groups == {"tumor"}:
        return SampleGroupResult("tumor", raw, [])
    if matched_groups == {"normal"}:
        return SampleGroupResult("normal", raw, [])
    raws = [_raw_evidence(k, v) for k, v, _ in classified]
    warning = (
        f"{rule_id}: conflicting tumor/normal evidence "
        f"({' vs '.join(raws)}) → sample_group=unknown"
    )
    return SampleGroupResult("unknown", raw, [warning])


def extract_sample_group(
    characteristics: dict[str, str] | None,
    title: str | None,
    *,
    rule_id: str = GROUP_RULE_ID,
) -> SampleGroupResult:
    """Extract a tumor/normal group from sample characteristics (T8).

    Implements the ``geo.sample-group.v1`` vocabulary exactly:

    * keys are normalized (trim/lower/``_``/``-`` → space/collapse) and the
      high-confidence key priority list decides which fields are evidence;
    * values are classified against the closed tumor/normal token lists;
    * same-priority conflicts → ``unknown`` + a warning; unrecognized values
      → ``unknown`` without a warning;
    * ``source name``/``title`` are low-priority evidence used only when no
      high-confidence field is present — and never for samples declaring a
      ``cell line`` characteristic (in-vitro models have no tissue
      tumor/normal identity, so titles saying "Breast Cancer cells" must
      not classify a cell-line sample as tumor).
    """
    characteristics = characteristics or {}
    evidence: list[tuple[str, str]] = []
    for key in _HIGH_CONFIDENCE_KEYS:
        for raw_key, raw_value in characteristics.items():
            if _normalize_token(raw_key) == key:
                evidence.append((raw_key, raw_value))
    if not evidence:
        if any(_normalize_token(key) == "cell line" for key in characteristics):
            return SampleGroupResult("unknown", "", [])
        for raw_key, raw_value in characteristics.items():
            if _normalize_token(raw_key) == "source name":
                evidence.append((raw_key, raw_value))
                break
        if title:
            evidence.append(("title", title))
        if not evidence:
            return SampleGroupResult("unknown", "", [])
    return _classify_evidence(evidence, rule_id)


def extract_pairing_id(characteristics: dict[str, str] | None) -> str | None:
    """Extract an explicit pairing identifier (T8 词汇表 point 6).

    Only the explicit pairing keys (pair id / pairing id / patient id /
    subject id / donor id / individual id) are accepted; pairing is NEVER
    inferred from GSM order, title similarity, or same-GSE membership. The
    value is normalized (trim/lower/``_``/``-`` → space/collapse) so
    inconsistently-cased GEO metadata yields one stable ``pairing_id``.
    """
    if not characteristics:
        return None
    for key in _PAIRING_KEYS:
        for raw_key, raw_value in characteristics.items():
            if _normalize_token(raw_key) == key:
                normalized = _normalize_token(raw_value)
                return normalized or None
    return None


def validate_pairings(samples: list[GeoSampleMetadata]) -> list[str]:
    """Warn about pairings missing a tumor or normal side.

    A pairing is valid only when at least one tumor and at least one normal
    sample share the same ``pairing_id`` (T8 词汇表 point 6). One-sided
    pairings produce a warning; ``unknown``-group samples never satisfy a
    side. Samples without a ``pairing_id`` are ignored.
    """
    groups_by_pairing: dict[str, set[str]] = {}
    for sample in samples:
        if sample.pairing_id:
            groups_by_pairing.setdefault(sample.pairing_id, set()).add(
                sample.sample_group
            )
    warnings: list[str] = []
    for pairing_id in sorted(groups_by_pairing):
        groups = groups_by_pairing[pairing_id]
        if "tumor" not in groups or "normal" not in groups:
            warnings.append(
                f"pairing {pairing_id} is one-sided "
                f"(groups={sorted(groups)}) — no valid tumor/normal pair"
            )
    return warnings


def parse_geo_soft_samples(compressed: bytes) -> list[GeoSampleMetadata]:
    text = gzip.decompress(compressed).decode("utf-8")
    samples: list[GeoSampleMetadata] = []
    current: dict[str, object] | None = None
    for line in text.splitlines():
        if line.startswith("^SAMPLE = "):
            if current is not None:
                samples.append(_build_sample(current))
            current = {"sample_id": line.split("=", 1)[1].strip(), "characteristics": {}}
        elif current is None:
            continue
        elif line.startswith("!Sample_description = Sample "):
            current["source_alias"] = line.rsplit(" ", 1)[-1].strip()
        elif line.startswith("!Sample_title = "):
            current["title"] = line.split("=", 1)[1].strip()
        elif line.startswith("!Sample_characteristics_ch1 = "):
            value = line.split("=", 1)[1].strip()
            if ": " in value:
                key, item = value.split(": ", 1)
                current["characteristics"][key] = item
    if current is not None:
        samples.append(_build_sample(current))
    aliases = [sample.source_alias for sample in samples]
    # Generalized validation (TODO §1.1): the previous ``len(samples) != 12``
    # check hardcoded GSE178352's twelve-sample shape and rejected every
    # other GEO series. The real invariants are:
    #   * at least one sample (a SOFT with zero samples is malformed),
    #   * source_alias uniqueness (downstream code keys samples by alias).
    # Sample count is now surfaced dynamically via ``processing_parameters``
    # in ParsedDataset (TODO §1.3) rather than enforced here.
    if not samples:
        raise ValueError("SOFT file contains no samples")
    if len(set(aliases)) != len(samples):
        raise ValueError(
            f"SOFT source aliases must be unique; got {len(samples)} samples "
            f"with {len(set(aliases))} unique aliases"
        )
    return samples


def _split_series_matrix_row(line: str) -> list[str]:
    """Split a tab-separated series_matrix metadata row into stripped values.

    Each value is wrapped in double quotes (e.g. ``"GSM8117703"``); this helper
    strips the surrounding quotes and returns the bare tokens.
    """
    parts = line.split("\t")
    return [part.strip().strip('"') for part in parts[1:]]


def parse_geo_series_matrix_samples(compressed: bytes) -> list[GeoSampleMetadata]:
    """Extract sample metadata from a GEO ``*_series_matrix.txt.gz`` file.

    Modern GEO series (snRNAseq, RNA-seq) frequently ship a series_matrix file
    whose expression-matrix block is empty (only a header row between
    ``!series_matrix_table_begin`` and ``!series_matrix_table_end``). The sample
    metadata lines (``!Sample_geo_accession``, ``!Sample_title``,
    ``!Sample_characteristics_ch1``, ``!Sample_organism_ch1``) are still
    populated, so we can recover a per-sample metadata table even when no
    expression values are available.

    The returned samples use the GSM accession as ``source_alias`` (the SOFT
    A/B nomenclature is GSE178352-specific and does not apply to arbitrary
    series). ``cell_line_raw``/``cell_line_canonical`` fall back to the
    ``cell line`` characteristic if present, otherwise empty string.
    ``treatment`` is derived from the sample title when no ``treatment``
    characteristic is present. ``replicate`` defaults to 1 when the title
    does not contain a ``rep.\\s*N`` token.
    """
    text = gzip.decompress(compressed).decode("utf-8")

    accessions: list[str] = []
    titles: list[str] = []
    organisms: list[str] = []
    # characteristics[i] holds the key→value map for sample index i.
    characteristics: list[dict[str, str]] = []

    for line in text.splitlines():
        if line.startswith("!Sample_geo_accession"):
            accessions = _split_series_matrix_row(line)
        elif line.startswith("!Sample_title"):
            titles = _split_series_matrix_row(line)
        elif line.startswith("!Sample_organism_ch1"):
            organisms = _split_series_matrix_row(line)
        elif line.startswith("!Sample_characteristics_ch1"):
            values = _split_series_matrix_row(line)
            if not values:
                continue
            first = values[0]
            if ": " not in first:
                # Lines whose first value isn't "key: value" don't map cleanly
                # onto per-sample fields — skip them.
                continue
            key, _ = first.split(": ", 1)
            key = key.strip().lower()
            # Ensure the characteristics list is long enough for all samples.
            while len(characteristics) < len(values):
                characteristics.append({})
            for i, value in enumerate(values):
                if ": " in value:
                    _, item = value.split(": ", 1)
                    characteristics[i][key] = item.strip()

    if not accessions:
        raise ValueError("series_matrix has no !Sample_geo_accession row")
    if not titles or len(titles) != len(accessions):
        # GEO should always pair accessions with titles, but fall back to
        # accession strings so we don't crash on malformed files.
        titles = titles if titles else list(accessions)

    samples: list[GeoSampleMetadata] = []
    for index, accession in enumerate(accessions):
        title = titles[index] if index < len(titles) else accession
        organism = organisms[index] if index < len(organisms) else "Homo sapiens"
        char_map = (
            characteristics[index] if index < len(characteristics) else {}
        )
        raw_cell_line = char_map.get("cell line", "")
        canonical = _CELL_LINE_CANONICAL.get(raw_cell_line, raw_cell_line)
        replicate_match = re.search(r"rep\.\s*(\d+)", title)
        treatment = char_map.get("treatment", "") or title
        group = extract_sample_group(char_map, title)
        samples.append(
            GeoSampleMetadata(
                sample_id=accession,
                source_alias=accession,
                cell_line_raw=raw_cell_line,
                cell_line_canonical=canonical,
                normalization_rule=(
                    "cell-line-name-correction-v1"
                    if canonical != raw_cell_line
                    else "identity"
                ),
                treatment=treatment,
                replicate=int(replicate_match.group(1)) if replicate_match else 1,
                organism=organism,
                sample_group=group.sample_group,
                sample_group_raw=group.sample_group_raw,
                pairing_id=extract_pairing_id(char_map),
                group_rule_id=GROUP_RULE_ID,
            )
        )
    return samples


def process_geo_series_matrix_expression(
    *,
    source_asset: SourceAsset,
    dataset_id: str,
    workdir: TaskWorkDir,
    samples: list[GeoSampleMetadata],
    gene_map: dict[str, str] | None = None,
    sample_gene_maps: dict[str, dict[str, str]] | None = None,
    probe_gene_mapping: str = "not_attempted",
) -> ParsedDataset | None:
    """Parse the expression matrix block from a GEO ``*_series_matrix.txt.gz``.

    Returns a ``ParsedDataset`` with real expression rows when the
    ``!series_matrix_table_begin`` / ``!series_matrix_table_end`` block
    contains data rows. Returns ``None`` when the block is empty (only a
    header row, as is common for snRNAseq/RNA-seq series whose expression
    matrices ship as supplementary files rather than in the series matrix).

    When ``gene_map`` (probe ID → gene symbol, from the platform annotation)
    is provided, probes present in the map are emitted with
    ``gene_id_namespace="gene_symbol"``; unmatched probes keep the raw probe
    ID and ``geo_id_ref`` namespace. ``probe_gene_mapping`` records the
    annotation status (mapped/unmapped/no_gene_annotation/...) in
    ``processing_parameters`` so the artifact builder can surface a warning
    when the platform provides no usable gene mapping.

    ``sample_gene_maps`` (Phase 5 D8) is the per-sample variant: a dict
    mapping each sample id to the gene map of the GPL that sample declares.
    When provided it takes precedence over ``gene_map`` and each row uses
    only its sample's GPL annotation — a GPL A annotation is never applied
    to GPL B samples. Samples absent from the map (no attributable GPL) keep
    raw probe IDs.

    Raises ``ValueError`` for malformed data within the block (e.g. a header
    row with no sample columns), and ``FileNotFoundError`` when the source
    asset is missing. Checksum mismatch raises ``ValueError``.
    """
    source_path = workdir.root / source_asset.relative_path
    if not source_path.is_file():
        raise FileNotFoundError(source_path)
    raw_bytes = source_path.read_bytes()
    if hashlib.sha256(raw_bytes).hexdigest() != source_asset.sha256:
        raise ValueError("source asset checksum mismatch before processing")

    text = gzip.decompress(raw_bytes).decode("utf-8")
    lines = text.splitlines()

    begin_idx: int | None = None
    end_idx: int | None = None
    for i, line in enumerate(lines):
        if line.startswith("!series_matrix_table_begin"):
            begin_idx = i
        elif line.startswith("!series_matrix_table_end") and begin_idx is not None:
            end_idx = i
            break

    if begin_idx is None or end_idx is None or end_idx <= begin_idx + 1:
        return None

    header_parts = [p.strip().strip('"') for p in lines[begin_idx + 1].split("\t")]
    sample_ids = header_parts[1:]
    if not sample_ids:
        return None

    sample_map = {s.sample_id: s for s in samples}
    data_lines = lines[begin_idx + 2 : end_idx]
    if not data_lines:
        return None

    output_path = workdir.parsed / f"{dataset_id}_series_matrix_long.csv"
    row_count = 0
    source_row_count = 0
    mapped_probes: set[str] = set()

    with output_path.open("w", encoding="utf-8-sig", newline="") as target:
        writer = csv.DictWriter(target, fieldnames=_OUTPUT_COLUMNS)
        writer.writeheader()
        for offset, data_line in enumerate(data_lines):
            values = [v.strip().strip('"') for v in data_line.split("\t")]
            if len(values) < 2:
                continue
            gene_id_raw = values[0]
            source_row_count += 1
            source_line_number = begin_idx + 3 + offset
            for col_idx, sample_id in enumerate(sample_ids):
                physical_index = col_idx + 1
                raw_value = values[physical_index] if physical_index < len(values) else ""
                if not raw_value or raw_value in {"NA", "null", "NaN"}:
                    continue
                try:
                    float(raw_value)
                except (ValueError, TypeError):
                    continue
                mapped_gene = _lookup_gene(gene_id_raw, sample_id, gene_map, sample_gene_maps)
                if mapped_gene:
                    mapped_probes.add(gene_id_raw)
                gene_id_out = mapped_gene or gene_id_raw
                gene_namespace = "gene_symbol" if mapped_gene else "geo_id_ref"
                sample = sample_map.get(sample_id)
                source_alias = sample.source_alias if sample else sample_id
                writer.writerow({
                    "record_id": make_record_id(dataset_id, gene_id_raw, sample_id),
                    "dataset_id": dataset_id,
                    "source_id": source_asset.source_id,
                    "asset_id": source_asset.asset_id,
                    "gene_id_raw": gene_id_raw,
                    "gene_id": gene_id_out,
                    "gene_id_namespace": gene_namespace,
                    "gene_id_version": "",
                    "sample_id": sample_id,
                    "source_sample_alias": source_alias,
                    "measurement_type": "series_matrix_expression",
                    "value_semantics": "normalized_expression_value",
                    "value_scale": "log2",
                    "is_normalized": "true",
                    "is_integer_expected": "false",
                    "expression_value": raw_value,
                    "expression_unit": "normalized_expression_value",
                    "source_logical_file": "series_matrix_expression",
                    "source_line_number": source_line_number,
                    "source_column_index": physical_index,
                    "source_column_name": sample_id,
                    "source_raw_value": raw_value,
                })
                row_count += 1

    if row_count == 0:
        # No valid expression rows (all values NA/non-numeric): do NOT leave
        # a schema-only placeholder CSV on disk (phase 4b T1 MUST-FIX 1).
        output_path.unlink(missing_ok=True)
        return None

    if mapped_probes:
        gene_namespace_summary = (
            "gene_symbol"
            if len(mapped_probes) == source_row_count
            else "mixed_geo_probe_gene_symbol"
        )
    else:
        gene_namespace_summary = "geo_id_ref"

    file_bytes = output_path.read_bytes()
    checksum = hashlib.sha256(file_bytes).hexdigest()
    file_asset = FileAsset(
        asset_id=asset_id_from_sha256(checksum),
        kind="parsed",
        relative_path=output_path.relative_to(workdir.root).as_posix(),
        sha256=checksum,
        size_bytes=len(file_bytes),
        media_type="text/csv",
        generated_by_step_id="step_geo_series_matrix_v1",
    )
    processing_parameters = {
        "measurement_type": "series_matrix_expression",
        "value_semantics": "normalized_expression_value",
        "value_scale": "log2",
        "is_normalized": True,
        "is_integer_expected": False,
        "sample_count": len(sample_ids),
        "source_logical_file": "series_matrix_expression",
        "gene_id_namespace": gene_namespace_summary,
        "probe_gene_mapping": probe_gene_mapping,
    }
    return ParsedDataset(
        dataset_id=dataset_id,
        source_id=source_asset.source_id,
        source_asset_id=source_asset.asset_id,
        file_asset=file_asset,
        columns=list(_OUTPUT_COLUMNS),
        row_count=row_count,
        parser_name="geo_series_matrix_expression",
        parser_version="1.0.0",
        source_row_count=source_row_count,
        processing_parameters=processing_parameters,
    )


def _lookup_gene(
    gene_id_raw: str,
    sample_id: str,
    gene_map: dict[str, str] | None,
    sample_gene_maps: dict[str, dict[str, str]] | None,
) -> str | None:
    """Resolve a probe row's mapped gene for one sample (Phase 5 D8).

    ``sample_gene_maps`` (per-sample GPL attribution) takes precedence: the
    sample's own GPL annotation decides the mapping, and samples without an
    attributable GPL get no mapping. Otherwise the single ``gene_map``
    applies (single-platform series).
    """
    if sample_gene_maps is not None:
        sample_map = sample_gene_maps.get(sample_id)
        if not sample_map:
            return None
        return sample_map.get(gene_id_raw)
    return (gene_map or {}).get(gene_id_raw)


def _build_sample(values: dict[str, object]) -> GeoSampleMetadata:
    characteristics = values["characteristics"]
    raw_cell_line = str(characteristics.get("cell line", ""))
    canonical = _CELL_LINE_CANONICAL.get(raw_cell_line, raw_cell_line)
    title = str(values.get("title", ""))
    replicate_match = re.search(r"rep\.\s*(\d+)", title)
    if not replicate_match:
        raise ValueError("sample title does not contain a replicate number")
    group = extract_sample_group(characteristics, title)
    return GeoSampleMetadata(
        sample_id=str(values["sample_id"]),
        source_alias=str(values["source_alias"]),
        cell_line_raw=raw_cell_line,
        cell_line_canonical=canonical,
        normalization_rule=(
            "cell-line-name-correction-v1" if canonical != raw_cell_line else "identity"
        ),
        treatment=str(characteristics.get("treatment", "")),
        replicate=int(replicate_match.group(1)),
        sample_group=group.sample_group,
        sample_group_raw=group.sample_group_raw,
        pairing_id=extract_pairing_id(characteristics),
        group_rule_id=GROUP_RULE_ID,
    )


_OUTPUT_COLUMNS = [
    "record_id", "dataset_id", "source_id", "asset_id", "gene_id_raw",
    "gene_id", "gene_id_namespace", "gene_id_version", "sample_id",
    "source_sample_alias", "measurement_type", "value_semantics", "value_scale",
    "is_normalized", "is_integer_expected", "expression_value", "expression_unit",
    "source_logical_file", "source_line_number", "source_column_index",
    "source_column_name", "source_raw_value",
]


def process_geo_series_matrix(
    source_asset: SourceAsset,
    dataset_id: str,
    workdir: TaskWorkDir,
) -> tuple[ParsedDataset, list[GeoSampleMetadata]]:
    source_path = workdir.root / source_asset.relative_path
    if not source_path.is_file():
        raise FileNotFoundError(source_path)
    compressed = source_path.read_bytes()
    if hashlib.sha256(compressed).hexdigest() != source_asset.sha256:
        raise ValueError("source asset checksum mismatch before processing")
    samples = parse_geo_series_matrix_samples(compressed)
    samples_by_id = {sample.sample_id: sample for sample in samples}
    output_path = workdir.parsed / f"{dataset_id}_series_matrix_long.csv"
    header: list[str] | None = None
    source_row_count = 0
    row_count = 0
    in_table = False

    try:
        with (
            gzip.open(source_path, "rt", encoding="utf-8", newline="") as source,
            output_path.open("w", encoding="utf-8-sig", newline="") as target,
        ):
            writer = csv.DictWriter(target, fieldnames=_OUTPUT_COLUMNS)
            writer.writeheader()
            for source_line_number, line in enumerate(source, start=1):
                marker = line.strip()
                if marker == "!series_matrix_table_begin":
                    in_table = True
                    continue
                if marker == "!series_matrix_table_end":
                    break
                if not in_table or not marker:
                    continue
                values = next(csv.reader([line], delimiter="\t", quotechar='"'))
                if header is None:
                    header = values
                    if len(header) < 2 or header[0] != "ID_REF":
                        raise ValueError(
                            "series_matrix expression table must start with ID_REF"
                        )
                    sample_ids = header[1:]
                    if (
                        len(set(sample_ids)) != len(sample_ids)
                        or any(sample_id not in samples_by_id for sample_id in sample_ids)
                    ):
                        raise ValueError(
                            "series_matrix expression columns do not match sample metadata"
                        )
                    continue
                if len(values) != len(header) or not values[0]:
                    raise ValueError(
                        f"invalid series_matrix expression row at line {source_line_number}"
                    )
                gene_id_raw = values[0]
                gene_id, separator, version = gene_id_raw.partition(".")
                namespace = (
                    "ensembl_gene" if gene_id_raw.upper().startswith("ENSG") else "geo_probe"
                )
                source_row_count += 1
                for column_index, sample_id in enumerate(header[1:], start=1):
                    raw_value = values[column_index]
                    try:
                        float(raw_value)
                    except ValueError as error:
                        raise ValueError(
                            "non-numeric series_matrix value at "
                            f"line {source_line_number}, column {column_index}"
                        ) from error
                    sample = samples_by_id[sample_id]
                    writer.writerow(
                        {
                            "record_id": make_record_id(
                                dataset_id, gene_id_raw, sample.sample_id
                            ),
                            "dataset_id": dataset_id,
                            "source_id": source_asset.source_id,
                            "asset_id": source_asset.asset_id,
                            "gene_id_raw": gene_id_raw,
                            "gene_id": gene_id,
                            "gene_id_namespace": namespace,
                            "gene_id_version": version if separator else "",
                            "sample_id": sample.sample_id,
                            "source_sample_alias": sample.source_alias,
                            "measurement_type": "geo_series_matrix_expression",
                            "value_semantics": "normalized_expression",
                            "value_scale": "unknown",
                            "is_normalized": "true",
                            "is_integer_expected": "false",
                            "expression_value": raw_value,
                            "expression_unit": "series_matrix_value",
                            "source_logical_file": source_path.name,
                            "source_line_number": source_line_number,
                            "source_column_index": column_index,
                            "source_column_name": sample_id,
                            "source_raw_value": raw_value,
                        }
                    )
                    row_count += 1
    except Exception:
        output_path.unlink(missing_ok=True)
        raise

    if header is None or source_row_count == 0:
        output_path.unlink(missing_ok=True)
        raise ValueError("series_matrix expression table contains no expression rows")

    file_bytes = output_path.read_bytes()
    checksum = hashlib.sha256(file_bytes).hexdigest()
    parsed = ParsedDataset(
        dataset_id=dataset_id,
        source_id=source_asset.source_id,
        source_asset_id=source_asset.asset_id,
        file_asset=FileAsset(
            asset_id=asset_id_from_sha256(checksum),
            kind="parsed",
            relative_path=output_path.relative_to(workdir.root).as_posix(),
            sha256=checksum,
            size_bytes=len(file_bytes),
            media_type="text/csv",
            generated_by_step_id="step_geo_series_matrix_v1",
        ),
        columns=list(_OUTPUT_COLUMNS),
        row_count=row_count,
        parser_name="geo_series_matrix",
        parser_version="1.0.0",
        source_row_count=source_row_count,
        processing_parameters={
            "measurement_type": "geo_series_matrix_expression",
            "value_semantics": "normalized_expression",
            "value_scale": "unknown",
            "is_normalized": True,
            "is_integer_expected": False,
            "sample_count": len(samples),
            "source_logical_file": source_path.name,
            "gene_id_namespace": "geo_probe_or_ensembl_gene",
        },
    )
    return parsed, samples


def process_geo_tximport_counts(
    *,
    source_asset: SourceAsset,
    dataset_id: str,
    workdir: TaskWorkDir,
    soft_gzip: bytes,
    logical_file: str,
) -> ParsedDataset:
    source_path = workdir.root / source_asset.relative_path
    if not source_path.is_file():
        raise FileNotFoundError(source_path)
    if hashlib.sha256(source_path.read_bytes()).hexdigest() != source_asset.sha256:
        raise ValueError("source asset checksum mismatch before processing")
    samples = {sample.source_alias: sample for sample in parse_geo_soft_samples(soft_gzip)}
    with gzip.open(source_path, "rt", encoding="utf-8", newline="") as source:
        rows = csv.reader(source, delimiter="\t", quotechar='"')
        header = next(rows)
        count_fields = [
            (index, name, name.split(".", 1)[1])
            for index, name in enumerate(header)
            if name.startswith("counts.")
        ]
        if len(count_fields) != 12:
            raise ValueError("tximport matrix must contain twelve counts columns")
        missing_aliases = [alias for _, _, alias in count_fields if alias not in samples]
        if missing_aliases:
            raise ValueError(f"counts aliases missing from SOFT metadata: {missing_aliases}")

        output_path = workdir.parsed / f"{dataset_id}_tximport_long.csv"
        row_count = 0
        source_row_count = 0
        try:
            # utf-8-sig writes a BOM so Excel opens UTF-8 CSVs without garbling (TODO §1.7).
            with output_path.open("w", encoding="utf-8-sig", newline="") as target:
                writer = csv.DictWriter(target, fieldnames=_OUTPUT_COLUMNS)
                writer.writeheader()
                for source_line_number, values in enumerate(rows, start=2):
                    if len(values) != len(header) + 1:
                        raise ValueError(
                            f"source line {source_line_number} has an unexpected field count"
                        )
                    gene_id_raw = values[0]
                    source_row_count += 1
                    for header_index, column_name, alias in count_fields:
                        physical_index = header_index + 1
                        raw_value = values[physical_index]
                        float(raw_value)
                        sample = samples[alias]
                        writer.writerow({
                            "record_id": make_record_id(dataset_id, gene_id_raw, sample.sample_id),
                            "dataset_id": dataset_id,
                            "source_id": source_asset.source_id,
                            "asset_id": source_asset.asset_id,
                            "gene_id_raw": gene_id_raw,
                            "gene_id": gene_id_raw,
                            "gene_id_namespace": "ensembl_gene",
                            "gene_id_version": "",
                            "sample_id": sample.sample_id,
                            "source_sample_alias": alias,
                            "measurement_type": "tximport_estimated_count",
                            "value_semantics": "estimated_count",
                            "value_scale": "linear",
                            "is_normalized": "false",
                            "is_integer_expected": "false",
                            "expression_value": raw_value,
                            "expression_unit": "estimated_count",
                            "source_logical_file": logical_file,
                            "source_line_number": source_line_number,
                            "source_column_index": physical_index,
                            "source_column_name": column_name,
                            "source_raw_value": raw_value,
                        })
                        row_count += 1
        except Exception:
            # Phase 4b T1 review round 2: a midstream parse failure must not
            # leave a partial ``<dataset>_tximport_long.csv`` in the parsed
            # workdir. The stage-level caller (run_processing) catches the
            # ValueError/OSError and continues to the no-primary path, so the
            # partial file would otherwise survive into staging. Unlink on ANY
            # exception so no partial file can ever be published.
            output_path.unlink(missing_ok=True)
            raise

    file_bytes = output_path.read_bytes()
    checksum = hashlib.sha256(file_bytes).hexdigest()
    file_asset = FileAsset(
        asset_id=asset_id_from_sha256(checksum),
        kind="parsed",
        relative_path=output_path.relative_to(workdir.root).as_posix(),
        sha256=checksum,
        size_bytes=len(file_bytes),
        media_type="text/csv",
        generated_by_step_id="step_geo_tximport_counts_v1",
    )
    # Surface the actual processing configuration so processing_log.parameters
    # reflects what the parser did, not a hardcoded ``{"measurement": "counts"}``
    # (TODO §1.3). ``source_row_count`` lets processing_log.rows_before report
    # the real upstream gene-row count instead of the previous hardcoded ``4``.
    processing_parameters = {
        "measurement_type": "tximport_estimated_count",
        "value_semantics": "estimated_count",
        "value_scale": "linear",
        "is_normalized": False,
        "is_integer_expected": False,
        "sample_count": len(samples),
        "source_logical_file": logical_file,
        "gene_id_namespace": "ensembl_gene",
    }
    return ParsedDataset(
        dataset_id=dataset_id,
        source_id=source_asset.source_id,
        source_asset_id=source_asset.asset_id,
        file_asset=file_asset,
        columns=list(_OUTPUT_COLUMNS),
        row_count=row_count,
        parser_name="geo_tximport_counts",
        parser_version="1.0.0",
        source_row_count=source_row_count,
        processing_parameters=processing_parameters,
    )


# ---------------------------------------------------------------------------
# Supplementary expression matrix parsing
# ---------------------------------------------------------------------------

_SUPPL_KEYWORD_MAP: list[tuple[str, str, str, str, bool]] = [
    # (keyword, measurement_type, value_semantics, value_scale, is_normalized)
    ("counts", "supplementary_counts", "estimated_count", "raw_count", False),
    ("count_", "supplementary_counts", "estimated_count", "raw_count", False),
    ("tpm", "supplementary_tpm", "tpm", "log2", True),
    ("fpkm", "supplementary_fpkm", "fpkm", "log2", True),
    ("expression", "supplementary_expression", "normalized_expression_value", "log2", True),
    ("expr", "supplementary_expression", "normalized_expression_value", "log2", True),
    ("normalized", "supplementary_expression", "normalized_expression_value", "log2", True),
]


def _infer_suppl_semantics(filename: str) -> tuple[str, str, str, bool]:
    """从 suppl 文件名推断 measurement_type / value_semantics / value_scale / is_normalized。"""
    lower = filename.lower()
    for keyword, measurement, semantics, scale, normalized in _SUPPL_KEYWORD_MAP:
        if keyword in lower:
            return measurement, semantics, scale, normalized
    return "supplementary_expression", "normalized_expression_value", "log2", True


def _detect_delimiter(sample_line: str) -> str:
    """自动检测分隔符：逗号或制表符。"""
    if "\t" in sample_line:
        return "\t"
    return ","


def process_geo_supplementary_expression(
    *,
    source_asset: SourceAsset,
    dataset_id: str,
    workdir: TaskWorkDir,
    samples: list[GeoSampleMetadata],
) -> ParsedDataset | None:
    """解析 GEO supplementary 表达矩阵文件。

    当 series_matrix 表达块为空（RNA-seq 数据集常见）时，acquisition 阶段
    会额外下载 supplementary 表达矩阵文件（如 ``*_counts.csv.gz``、
    ``*_TPM.txt.gz``）。本函数解析这些文件，自动检测分隔符（CSV/TSV），
    推断 measurement_type（counts/TPM/FPKM/expression）。

    第一列视为基因 ID，其余列视为样本表达值。样本列名优先与已知的
    GSM accession 匹配；若不匹配则按列序使用原始列名。

    返回 ``ParsedDataset``（含真实表达行），或 ``None``（文件为空或无有效行）。
    """
    source_path = workdir.root / source_asset.relative_path
    if not source_path.is_file():
        raise FileNotFoundError(source_path)
    raw_bytes = source_path.read_bytes()
    if hashlib.sha256(raw_bytes).hexdigest() != source_asset.sha256:
        raise ValueError("source asset checksum mismatch before processing")

    filename = source_asset.relative_path.rsplit("/", 1)[-1]
    measurement_type, value_semantics, value_scale, is_normalized = (
        _infer_suppl_semantics(filename)
    )

    # 解压
    if filename.endswith(".gz"):
        text = gzip.decompress(raw_bytes).decode("utf-8", errors="replace")
    else:
        text = raw_bytes.decode("utf-8", errors="replace")

    lines = text.splitlines()
    if len(lines) < 2:
        return None

    delimiter = _detect_delimiter(lines[0])
    header_parts = [p.strip().strip('"') for p in lines[0].split(delimiter)]
    if len(header_parts) < 2:
        return None

    sample_columns = header_parts[1:]

    # 构建 sample_id → source_alias 映射
    sample_map: dict[str, str] = {}
    for s in samples:
        sample_map[s.sample_id] = s.source_alias
        # 也支持列名只有 GSM 后缀数字的情况
        if s.sample_id.startswith("GSM"):
            sample_map[s.sample_id[3:]] = s.source_alias

    output_path = workdir.parsed / f"{dataset_id}_suppl_expression_long.csv"
    row_count = 0
    source_row_count = 0

    with output_path.open("w", encoding="utf-8-sig", newline="") as target:
        writer = csv.DictWriter(target, fieldnames=_OUTPUT_COLUMNS)
        writer.writeheader()

        for line_idx, line in enumerate(lines[1:], start=2):
            values = [v.strip().strip('"') for v in line.split(delimiter)]
            if len(values) < 2:
                continue
            gene_id_raw = values[0]
            if not gene_id_raw:
                continue
            source_row_count += 1

            for col_idx, col_name in enumerate(sample_columns):
                physical_index = col_idx + 1
                raw_value = values[physical_index] if physical_index < len(values) else ""
                if not raw_value or raw_value in {"NA", "null", "NaN", ""}:
                    continue
                try:
                    float(raw_value)
                except (ValueError, TypeError):
                    continue

                # 匹配样本
                source_alias = sample_map.get(col_name, col_name)
                sample_id = col_name
                # 如果列名不是 GSM 格式，尝试匹配 samples 中的 source_alias
                if not col_name.startswith("GSM"):
                    for s in samples:
                        if s.source_alias == col_name:
                            sample_id = s.sample_id
                            break

                writer.writerow({
                    "record_id": make_record_id(dataset_id, gene_id_raw, sample_id),
                    "dataset_id": dataset_id,
                    "source_id": source_asset.source_id,
                    "asset_id": source_asset.asset_id,
                    "gene_id_raw": gene_id_raw,
                    "gene_id": gene_id_raw,
                    "gene_id_namespace": "gene_symbol",
                    "gene_id_version": "",
                    "sample_id": sample_id,
                    "source_sample_alias": source_alias,
                    "measurement_type": measurement_type,
                    "value_semantics": value_semantics,
                    "value_scale": value_scale,
                    "is_normalized": "true" if is_normalized else "false",
                    "is_integer_expected": "false" if is_normalized else "true",
                    "expression_value": raw_value,
                    "expression_unit": value_semantics,
                    "source_logical_file": "supplementary_expression",
                    "source_line_number": line_idx,
                    "source_column_index": physical_index,
                    "source_column_name": col_name,
                    "source_raw_value": raw_value,
                })
                row_count += 1

    if row_count == 0:
        # No valid expression rows (all values NA/non-numeric): do NOT leave
        # a schema-only placeholder CSV on disk (phase 4b T1 MUST-FIX 1).
        output_path.unlink(missing_ok=True)
        return None

    file_bytes = output_path.read_bytes()
    checksum = hashlib.sha256(file_bytes).hexdigest()
    file_asset = FileAsset(
        asset_id=asset_id_from_sha256(checksum),
        kind="parsed",
        relative_path=output_path.relative_to(workdir.root).as_posix(),
        sha256=checksum,
        size_bytes=len(file_bytes),
        media_type="text/csv",
        generated_by_step_id="step_geo_suppl_expression_v1",
    )
    processing_parameters = {
        "measurement_type": measurement_type,
        "value_semantics": value_semantics,
        "value_scale": value_scale,
        "is_normalized": is_normalized,
        "sample_count": len(sample_columns),
        "source_logical_file": "supplementary_expression",
        "gene_id_namespace": "gene_symbol",
        "source_filename": filename,
    }
    return ParsedDataset(
        dataset_id=dataset_id,
        source_id=source_asset.source_id,
        source_asset_id=source_asset.asset_id,
        file_asset=file_asset,
        columns=list(_OUTPUT_COLUMNS),
        row_count=row_count,
        parser_name="geo_supplementary_expression",
        parser_version="1.0.0",
        source_row_count=source_row_count,
        processing_parameters=processing_parameters,
    )
