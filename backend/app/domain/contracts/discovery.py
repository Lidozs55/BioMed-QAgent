"""Typed records produced by literature and dataset discovery."""

from __future__ import annotations

import re
from datetime import date

from pydantic import Field, field_validator, model_validator

from app.domain.contracts.base import ContractModel
from app.domain.contracts.enums import DataLevel


class LiteratureRecord(ContractModel):
    pmid: str = Field(pattern=r"^\d+$")
    pmcid: str | None = Field(default=None, pattern=r"^PMC\d+$")
    doi: str | None = None
    title: str = Field(min_length=1)
    authors: list[str] = Field(default_factory=list)
    journal: str = ""
    published_at: date | None = None
    abstract: str = ""
    source_url: str = Field(min_length=1)


class NcbiSearchPage(ContractModel):
    count: int = Field(ge=0)
    retmax: int = Field(ge=0)
    retstart: int = Field(ge=0)
    ids: list[str] = Field(default_factory=list)
    query_translation: str = ""

    @field_validator("ids")
    @classmethod
    def validate_numeric_ids(cls, values: list[str]) -> list[str]:
        if any(not value.isdigit() for value in values):
            raise ValueError("NCBI search IDs must be numeric UIDs")
        return values


class GeoSampleRecord(ContractModel):
    accession: str
    title: str = ""

    @field_validator("accession")
    @classmethod
    def validate_accession(cls, value: str) -> str:
        accession = value.strip().upper()
        if not re.fullmatch(r"GSM\d+", accession):
            raise ValueError("GEO sample accession must match GSM followed by digits")
        return accession


class GeoSeriesRecord(ContractModel):
    uid: str = Field(pattern=r"^\d+$")
    accession: str
    title: str = ""
    summary: str = ""
    organism: str = ""
    experiment_type: str = ""
    sample_count: int = Field(ge=0)
    samples: list[GeoSampleRecord] = Field(default_factory=list)
    platform_ids: list[str] = Field(default_factory=list)
    pubmed_ids: list[str] = Field(default_factory=list)
    bioproject: str | None = None
    ftp_root: str = ""

    @field_validator("accession")
    @classmethod
    def validate_accession(cls, value: str) -> str:
        accession = value.strip().upper()
        if not re.fullmatch(r"GSE\d+", accession):
            raise ValueError("GEO series accession must match GSE followed by digits")
        return accession

    @field_validator("platform_ids")
    @classmethod
    def validate_platform_ids(cls, values: list[str]) -> list[str]:
        normalized = [value.strip().upper() for value in values if value.strip()]
        if any(not re.fullmatch(r"GPL\d+", value) for value in normalized):
            raise ValueError("GEO platform IDs must match GPL followed by digits")
        return normalized

    @field_validator("pubmed_ids")
    @classmethod
    def validate_pubmed_ids(cls, values: list[str]) -> list[str]:
        if any(not value.isdigit() for value in values):
            raise ValueError("PubMed IDs must be numeric")
        return values

    @model_validator(mode="after")
    def validate_samples(self) -> "GeoSeriesRecord":
        accessions = [sample.accession for sample in self.samples]
        if self.sample_count != len(accessions):
            raise ValueError("sample_count must equal the number of samples")
        if len(accessions) != len(set(accessions)):
            raise ValueError("sample accessions must be unique")
        return self


class GeoAssetCandidate(ContractModel):
    filename: str = Field(min_length=1)
    url: str = Field(min_length=1)
    media_type: str = Field(min_length=1)
    data_level: DataLevel
