"""Pure parsers for official PubMed and GEO response formats."""

from __future__ import annotations

import json
import re
import xml.etree.ElementTree as ET
from datetime import date
from html.parser import HTMLParser
from urllib.parse import urljoin, urlparse

from app.domain.contracts.discovery import (
    GeoAssetCandidate,
    GeoSampleRecord,
    GeoSeriesRecord,
    LiteratureRecord,
    NcbiSearchPage,
)
from app.domain.contracts.enums import DataLevel


_MONTHS = {
    "jan": 1,
    "feb": 2,
    "mar": 3,
    "apr": 4,
    "may": 5,
    "jun": 6,
    "jul": 7,
    "aug": 8,
    "sep": 9,
    "oct": 10,
    "nov": 11,
    "dec": 12,
}


def _element_text(element: ET.Element | None) -> str:
    if element is None:
        return ""
    return "".join(element.itertext()).strip()


def _publication_date(article: ET.Element) -> date | None:
    for element in (
        article.find("./MedlineCitation/Article/Journal/JournalIssue/PubDate"),
        article.find("./MedlineCitation/Article/ArticleDate"),
    ):
        if element is None:
            continue
        year_text = element.findtext("Year", "").strip()
        month_text = element.findtext("Month", "").strip()
        day_text = element.findtext("Day", "").strip()
        if not year_text or not month_text or not day_text:
            continue
        month = int(month_text) if month_text.isdigit() else _MONTHS.get(month_text[:3].lower())
        if month is not None:
            return date(int(year_text), month, int(day_text))
    return None


def _authors(article_data: ET.Element) -> list[str]:
    authors: list[str] = []
    for author in article_data.findall("./AuthorList/Author"):
        collective = _element_text(author.find("CollectiveName"))
        if collective:
            authors.append(collective)
            continue
        name = " ".join(
            part
            for part in (
                author.findtext("ForeName", "").strip(),
                author.findtext("LastName", "").strip(),
            )
            if part
        )
        if name:
            authors.append(name)
    return authors


def parse_pubmed_xml(xml: bytes) -> list[LiteratureRecord]:
    root = ET.fromstring(xml)
    records: list[LiteratureRecord] = []
    for article in root.findall("./PubmedArticle"):
        article_data = article.find("./MedlineCitation/Article")
        if article_data is None:
            continue
        pmid = article.findtext("./MedlineCitation/PMID", "").strip()
        identifiers: dict[str, str] = {}
        id_list = article.find("./PubmedData/ArticleIdList")
        if id_list is not None:
            for identifier in id_list.findall("ArticleId"):
                if identifier.text:
                    identifiers[identifier.get("IdType", "")] = identifier.text.strip()
        abstract_parts = [
            _element_text(part)
            for part in article_data.findall("./Abstract/AbstractText")
        ]
        records.append(LiteratureRecord(
            pmid=pmid,
            pmcid=identifiers.get("pmc"),
            doi=identifiers.get("doi"),
            title=_element_text(article_data.find("ArticleTitle")),
            authors=_authors(article_data),
            journal=_element_text(article_data.find("./Journal/Title")),
            published_at=_publication_date(article),
            abstract=" ".join(part for part in abstract_parts if part),
            source_url=f"https://pubmed.ncbi.nlm.nih.gov/{pmid}/",
        ))
    return records


def parse_ncbi_esearch(payload: bytes) -> NcbiSearchPage:
    result = json.loads(payload.decode("utf-8-sig"))["esearchresult"]
    return NcbiSearchPage(
        count=int(result.get("count", 0)),
        retmax=int(result.get("retmax", 0)),
        retstart=int(result.get("retstart", 0)),
        ids=list(result.get("idlist", [])),
        query_translation=result.get("querytranslation", ""),
    )


def parse_geo_esearch(payload: bytes) -> NcbiSearchPage:
    """Compatibility name documenting the GEO UID semantics."""

    return parse_ncbi_esearch(payload)


def parse_geo_esummary(payload: bytes) -> list[GeoSeriesRecord]:
    result = json.loads(payload.decode("utf-8-sig"))["result"]
    records: list[GeoSeriesRecord] = []
    for uid in result.get("uids", []):
        item = result.get(uid)
        if not isinstance(item, dict) or item.get("entrytype") != "GSE":
            continue
        gpl = str(item.get("gpl", "")).strip()
        platform_ids = [f"GPL{value}" for value in re.findall(r"\d+", gpl)]
        samples = [
            GeoSampleRecord(
                accession=sample.get("accession", ""),
                title=sample.get("title", ""),
            )
            for sample in item.get("samples", [])
        ]
        records.append(GeoSeriesRecord(
            uid=uid,
            accession=item.get("accession", ""),
            title=item.get("title", ""),
            summary=item.get("summary", ""),
            organism=item.get("taxon", ""),
            experiment_type=item.get("gdstype", ""),
            sample_count=int(item.get("n_samples", len(samples))),
            samples=samples,
            platform_ids=platform_ids,
            pubmed_ids=[str(value) for value in item.get("pubmedids", [])],
            bioproject=item.get("bioproject") or None,
            ftp_root=item.get("ftplink", ""),
        ))
    return records


class _ListingParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.hrefs: list[str] = []

    def handle_starttag(
        self, tag: str, attrs: list[tuple[str, str | None]]
    ) -> None:
        if tag != "a":
            return
        href = dict(attrs).get("href")
        if href:
            self.hrefs.append(href)


def resolve_geo_supplementary_assets(
    html: bytes, base_url: str
) -> list[GeoAssetCandidate]:
    parser = _ListingParser()
    parser.feed(html.decode("utf-8", errors="strict"))
    assets: list[GeoAssetCandidate] = []
    for href in parser.hrefs:
        filename = urlparse(href).path.rsplit("/", 1)[-1]
        if not re.fullmatch(r"GSE\d+_[A-Za-z0-9_.-]+\.gz", filename):
            continue
        assets.append(GeoAssetCandidate(
            filename=filename,
            url=urljoin(base_url, href),
            media_type="application/gzip",
            data_level=DataLevel.REPOSITORY_PROCESSED,
        ))
    return assets
