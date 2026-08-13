"""Versioned GEO sample metadata extraction for V2 publications.

The rules in this module are deterministic and source-format agnostic: GEO
SOFT and series-matrix metadata both become ``GeoSampleMetadata`` and use the
same closed ``geo.sample-group.v1`` tumor/normal vocabulary. Pairing is never
inferred; only explicit subject/patient/donor identifiers are accepted.
"""

from __future__ import annotations

import csv
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, TextIO

from pydantic import Field

from app.domain.contracts.base import ContractModel

GROUP_RULE_ID = "geo.sample-group.v1"

GroupLabel = Literal["tumor", "normal", "unknown"]

_HIGH_CONFIDENCE_KEYS = (
    "sample type",
    "tissue type",
    "disease state",
    "condition",
    "tumor normal",
    "tumour normal",
)
_GROUP_PHRASES: tuple[tuple[str, GroupLabel], ...] = (
    ("primary tumor", "tumor"),
    ("adjacent normal", "normal"),
    ("normal adjacent", "normal"),
    ("non tumor", "normal"),
    ("non tumour", "normal"),
    ("control tissue", "normal"),
)
_TUMOR_WORDS = frozenset(
    {"tumor", "tumour", "cancer", "carcinoma", "malignant", "metastatic"}
)
_NORMAL_WORDS = frozenset({"normal", "healthy"})
_PAIRING_KEYS = (
    "pair id",
    "pairing id",
    "patient id",
    "subject id",
    "donor id",
    "individual id",
)

SAMPLE_METADATA_COLUMNS = (
    "sample_id",
    "source_sample_alias",
    "title",
    "organism",
    "platform_id",
    "sample_group",
    "sample_group_raw",
    "pairing_id",
    "group_rule_id",
)


class GeoSampleMetadata(ContractModel):
    sample_id: str = Field(pattern=r"^GSM\d+$")
    source_sample_alias: str | None = None
    title: str = ""
    organism: str = ""
    platform_id: str | None = Field(default=None, pattern=r"^GPL\d+$")
    sample_group: GroupLabel = "unknown"
    sample_group_raw: str = ""
    pairing_id: str | None = None
    group_rule_id: str = GROUP_RULE_ID


@dataclass(frozen=True, slots=True)
class SampleGroupResult:
    sample_group: GroupLabel
    sample_group_raw: str
    warnings: list[str]


def _normalize_token(text: str) -> str:
    return " ".join(text.strip().lower().replace("_", " ").replace("-", " ").split())


def _matched_group_tokens(value: str) -> set[str]:
    remaining = re.findall(r"[a-z0-9]+", _normalize_token(value))
    matched: set[str] = set()
    for phrase, group in _GROUP_PHRASES:
        phrase_words = phrase.split()
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


def _classify_evidence(
    evidence: list[tuple[str, str]], rule_id: str
) -> SampleGroupResult:
    classified = [
        (key, value, groups)
        for key, value in evidence
        if (groups := _matched_group_tokens(value))
    ]
    if not classified:
        return SampleGroupResult("unknown", "", [])
    raw = f"{classified[0][0].strip()}:{classified[0][1].strip()}"
    groups = set().union(*(item[2] for item in classified))
    if groups == {"tumor"}:
        return SampleGroupResult("tumor", raw, [])
    if groups == {"normal"}:
        return SampleGroupResult("normal", raw, [])
    details = " vs ".join(
        f"{key.strip()}:{value.strip()}" for key, value, _ in classified
    )
    return SampleGroupResult(
        "unknown",
        raw,
        [
            f"{rule_id}: conflicting tumor/normal evidence "
            f"({details}) -> sample_group=unknown"
        ],
    )


def extract_sample_group(
    characteristics: dict[str, str] | None,
    title: str | None,
    *,
    rule_id: str = GROUP_RULE_ID,
) -> SampleGroupResult:
    characteristics = characteristics or {}
    evidence: list[tuple[str, str]] = []
    for expected_key in _HIGH_CONFIDENCE_KEYS:
        evidence.extend(
            (raw_key, raw_value)
            for raw_key, raw_value in characteristics.items()
            if _normalize_token(raw_key) == expected_key
        )
    if not evidence:
        if any(_normalize_token(key) == "cell line" for key in characteristics):
            return SampleGroupResult("unknown", "", [])
        evidence.extend(
            (raw_key, raw_value)
            for raw_key, raw_value in characteristics.items()
            if _normalize_token(raw_key) == "source name"
        )
        if title:
            evidence.append(("title", title))
    return _classify_evidence(evidence, rule_id)


def extract_pairing_id(characteristics: dict[str, str] | None) -> str | None:
    if not characteristics:
        return None
    for expected_key in _PAIRING_KEYS:
        for raw_key, raw_value in characteristics.items():
            if _normalize_token(raw_key) == expected_key:
                normalized = _normalize_token(raw_value)
                return normalized or None
    return None


def validate_pairings(samples: list[GeoSampleMetadata]) -> list[str]:
    groups_by_pair: dict[str, set[str]] = {}
    for sample in samples:
        if sample.pairing_id:
            groups_by_pair.setdefault(sample.pairing_id, set()).add(
                sample.sample_group
            )
    return [
        f"pairing {pairing_id} is one-sided (groups={sorted(groups)}) - "
        "no valid tumor/normal pair"
        for pairing_id, groups in sorted(groups_by_pair.items())
        if "tumor" not in groups or "normal" not in groups
    ]


def _split_metadata_values(values: list[str]) -> list[str]:
    return [value.strip() for value in values[1:]]


def _samples_from_columns(
    metadata: dict[str, list[str]],
    characteristics: list[dict[str, str]],
) -> tuple[list[GeoSampleMetadata], list[str]]:
    accessions = metadata.get("geo_accession", [])
    if not accessions:
        return [], []
    samples: list[GeoSampleMetadata] = []
    warnings: list[str] = []
    titles = metadata.get("title", [])
    organisms = metadata.get("organism_ch1", [])
    platforms = metadata.get("platform_id", [])
    for index, accession in enumerate(accessions):
        char_map = characteristics[index] if index < len(characteristics) else {}
        title = titles[index] if index < len(titles) else ""
        group = extract_sample_group(char_map, title)
        warnings.extend(f"{accession}: {warning}" for warning in group.warnings)
        samples.append(
            GeoSampleMetadata(
                sample_id=accession,
                source_sample_alias=accession,
                title=title,
                organism=organisms[index] if index < len(organisms) else "",
                platform_id=(
                    platforms[index] if index < len(platforms) and platforms[index] else None
                ),
                sample_group=group.sample_group,
                sample_group_raw=group.sample_group_raw,
                pairing_id=extract_pairing_id(char_map),
            )
        )
    warnings.extend(validate_pairings(samples))
    return samples, warnings


def parse_geo_series_matrix_samples(
    source_handle: TextIO,
) -> tuple[list[GeoSampleMetadata], list[str]]:
    metadata: dict[str, list[str]] = {}
    characteristics: list[dict[str, str]] = []
    reader = csv.reader(source_handle, delimiter="\t", quotechar='"')
    for values in reader:
        if not values:
            continue
        if values[0].startswith("!series_matrix_table_begin"):
            break
        if values[0].startswith("!Sample_"):
            key = values[0].removeprefix("!Sample_").strip()
            row_values = _split_metadata_values(values)
            if key == "characteristics_ch1":
                while len(characteristics) < len(row_values):
                    characteristics.append({})
                for index, value in enumerate(row_values):
                    if ":" in value:
                        raw_key, raw_value = value.split(":", 1)
                        characteristics[index][raw_key.strip()] = raw_value.strip()
            else:
                metadata[key] = row_values
    return _samples_from_columns(metadata, characteristics)


def parse_geo_soft_samples(
    source_handle: TextIO,
) -> tuple[list[GeoSampleMetadata], list[str]]:
    samples: list[GeoSampleMetadata] = []
    warnings: list[str] = []
    current: dict[str, object] | None = None

    def finish() -> None:
        if current is None:
            return
        characteristics = current.get("characteristics", {})
        assert isinstance(characteristics, dict)
        title = str(current.get("title", ""))
        group = extract_sample_group(characteristics, title)
        sample_id = str(current["sample_id"])
        warnings.extend(f"{sample_id}: {warning}" for warning in group.warnings)
        samples.append(
            GeoSampleMetadata(
                sample_id=sample_id,
                source_sample_alias=(
                    str(current["source_sample_alias"])
                    if current.get("source_sample_alias")
                    else None
                ),
                title=title,
                organism=str(current.get("organism", "")),
                platform_id=(
                    str(current["platform_id"])
                    if current.get("platform_id")
                    else None
                ),
                sample_group=group.sample_group,
                sample_group_raw=group.sample_group_raw,
                pairing_id=extract_pairing_id(characteristics),
            )
        )

    for raw_line in source_handle:
        line = raw_line.rstrip("\r\n")
        if line.startswith("^SAMPLE = "):
            finish()
            current = {
                "sample_id": line.split("=", 1)[1].strip(),
                "characteristics": {},
            }
        elif current is None:
            continue
        elif line.startswith("!Sample_description = Sample "):
            current["source_sample_alias"] = line.rsplit(" ", 1)[-1].strip()
        elif line.startswith("!Sample_title = "):
            current["title"] = line.split("=", 1)[1].strip()
        elif line.startswith("!Sample_organism_ch1 = "):
            current["organism"] = line.split("=", 1)[1].strip()
        elif line.startswith("!Sample_platform_id = "):
            current["platform_id"] = line.split("=", 1)[1].strip()
        elif line.startswith("!Sample_characteristics_ch1 = "):
            value = line.split("=", 1)[1].strip()
            if ":" in value:
                key, item = value.split(":", 1)
                characteristics = current["characteristics"]
                assert isinstance(characteristics, dict)
                characteristics[key.strip()] = item.strip()
    finish()
    warnings.extend(validate_pairings(samples))
    return samples, warnings


def write_sample_metadata(path: Path, samples: list[GeoSampleMetadata]) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=SAMPLE_METADATA_COLUMNS)
        writer.writeheader()
        for sample in samples:
            writer.writerow(
                {
                    "sample_id": sample.sample_id,
                    "source_sample_alias": sample.source_sample_alias or "",
                    "title": sample.title,
                    "organism": sample.organism,
                    "platform_id": sample.platform_id or "",
                    "sample_group": sample.sample_group,
                    "sample_group_raw": sample.sample_group_raw,
                    "pairing_id": sample.pairing_id or "",
                    "group_rule_id": sample.group_rule_id,
                }
            )
    return path
