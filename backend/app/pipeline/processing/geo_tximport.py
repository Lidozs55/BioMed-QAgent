"""GEO tximport-count processing with exact source coordinates."""

from __future__ import annotations

import csv
import gzip
import hashlib
import re

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


_CELL_LINE_CANONICAL = {
    "MD-MBA-231": "MDA-MB-231",
    "MD-MBA-453": "MDA-MB-453",
}


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
    if len(samples) != 12 or len(set(aliases)) != 12:
        raise ValueError("GSE178352 SOFT must contain twelve unique source aliases")
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
            )
        )
    return samples


def _build_sample(values: dict[str, object]) -> GeoSampleMetadata:
    characteristics = values["characteristics"]
    raw_cell_line = str(characteristics.get("cell line", ""))
    canonical = _CELL_LINE_CANONICAL.get(raw_cell_line, raw_cell_line)
    title = str(values.get("title", ""))
    replicate_match = re.search(r"rep\.\s*(\d+)", title)
    if not replicate_match:
        raise ValueError("sample title does not contain a replicate number")
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
    )


_OUTPUT_COLUMNS = [
    "record_id", "dataset_id", "source_id", "asset_id", "gene_id_raw",
    "gene_id", "gene_id_namespace", "gene_id_version", "sample_id",
    "source_sample_alias", "measurement_type", "value_semantics", "value_scale",
    "is_normalized", "is_integer_expected", "expression_value", "expression_unit",
    "source_logical_file", "source_line_number", "source_column_index",
    "source_column_name", "source_raw_value",
]


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
    return ParsedDataset(
        dataset_id=dataset_id,
        source_id=source_asset.source_id,
        source_asset_id=source_asset.asset_id,
        file_asset=file_asset,
        columns=list(_OUTPUT_COLUMNS),
        row_count=row_count,
        parser_name="geo_tximport_counts",
        parser_version="1.0.0",
    )
