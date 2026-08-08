"""GEO platform annotation: probe → gene mapping with content-addressed cache.

GEO platform annotation tables (SOFT ``!platform_table_begin`` /
``!platform_table_end`` blocks) map probe IDs to gene identifiers. They are
stored per-platform under
``https://ftp.ncbi.nlm.nih.gov/geo/platforms/GPL{prefix}nnn/{gpl}/suppl/*.txt.gz``
(Agilent-style) or ``.../annot/{gpl}.annot.gz`` (Affymetrix-style). Both
layouts use the same SOFT table syntax, so one parser handles both.

Many platforms (e.g. Agilent-052909 / GPL19072) ship tables whose gene
columns are all empty. The parser reports ``unmapped`` rather than silently
producing a probe-level artifact that cannot be queried by gene symbol — the
artifact builder turns that into a user-visible warning.
"""

from __future__ import annotations

import gzip
import hashlib
import logging
import re

import httpx

from app.tools.content_cache import ContentCache, canonical_request_hash

logger = logging.getLogger(__name__)

# Status values recorded in processing_parameters["probe_gene_mapping"].
MAPPED = "mapped"
UNMAPPED = "unmapped"
NO_GENE_ANNOTATION = "no_gene_annotation"
ANNOTATION_UNAVAILABLE = "annotation_unavailable"
NOT_ATTEMPTED = "not_attempted"

# Gene-identifier columns in SOFT platform tables, best first. The parser
# picks the first column (in this order) that carries at least one value.
_GENE_COLUMN_PRIORITY = (
    "GENE_SYMBOL",
    "GENE_NAME",
    "REFSEQ",
    "GB_ACC",
    "ENSEMBL_ID",
    "UNIGENE_ID",
    "LOCUSLINK_ID",
    "TIGR_ID",
    "ENTREZ_GENE_ID",
)

_FTP_ROOT = "https://ftp.ncbi.nlm.nih.gov/geo/platforms"
_MISSING_SENTINELS = {"", "---", "null", "NA", "NaN"}


def geo_platform_dir(gpl: str) -> str:
    """Return the NCBI GEO platform directory prefix for a GPL accession.

    NCBI stores platforms under ``geo/platforms/GPL{prefix}nnn/`` where the
    numeric prefix is the accession with its last three digits replaced by
    ``nnn`` (GPL19072 → GPL19nnn, GPL4133 → GPL4nnn, GPL570 → GPLnnn).
    """
    digits = gpl[3:]
    prefix = "nnn" if len(digits) <= 3 else f"{digits[:-3]}nnn"
    return f"GPL{prefix}"


def _listing_url(gpl: str, subdir: str) -> str:
    return f"{_FTP_ROOT}/{geo_platform_dir(gpl)}/{gpl}/{subdir}/"


def _file_url(gpl: str, subdir: str, filename: str) -> str:
    return f"{_FTP_ROOT}/{geo_platform_dir(gpl)}/{gpl}/{subdir}/{filename}"


def _list_directory(client: httpx.Client, url: str) -> list[str]:
    """Return filenames from an NCBI FTP HTML directory listing."""
    try:
        response = client.get(url)
    except httpx.HTTPError as exc:
        logger.warning("geo annotation: directory listing failed for %s: %s", url, exc)
        return []
    if response.status_code != 200:
        logger.debug("geo annotation: directory %s returned HTTP %s", url, response.status_code)
        return []
    names = re.findall(r'href="([^"]+)"', response.text)
    return [name for name in names if not name.startswith("/") and name != "Parent Directory"]


def discover_annotation_file(
    client: httpx.Client, gpl: str
) -> tuple[str, str] | None:
    """Locate the platform annotation file, returning ``(subdir, filename)``.

    Checks the two layouts used by GEO: ``suppl/{gpl}_*.txt.gz``
    (Agilent-style) and ``annot/{gpl}.annot.gz`` (Affymetrix-style). Returns
    ``None`` when neither exists (some platforms ship no downloadable
    annotation table).
    """
    for subdir, pattern in (
        ("suppl", re.compile(rf"{gpl}_[^/]*\.txt\.gz", re.IGNORECASE)),
        ("annot", re.compile(rf"{gpl}\.annot\.gz", re.IGNORECASE)),
    ):
        for name in _list_directory(client, _listing_url(gpl, subdir)):
            if pattern.fullmatch(name):
                return subdir, name
    return None


def parse_platform_annotation(compressed: bytes) -> tuple[dict[str, str], str]:
    """Parse a SOFT platform table into ``(probe → gene, status)``.

    The first data column is the probe ID; the gene value comes from the
    highest-priority gene column that has at least one non-empty value.
    Status is one of :data:`MAPPED`, :data:`UNMAPPED` (gene columns exist
    but carry no values), or :data:`NO_GENE_ANNOTATION` (no recognized gene
    column / no table block).
    """
    try:
        text = gzip.decompress(compressed).decode("utf-8", errors="replace")
    except (gzip.BadGzipFile, OSError) as exc:
        logger.warning("geo annotation: cannot decompress platform table: %s", exc)
        return {}, NO_GENE_ANNOTATION

    lines = text.splitlines()
    begin: int | None = None
    end: int | None = None
    for index, line in enumerate(lines):
        marker = line.strip().casefold()
        if marker == "!platform_table_begin":
            begin = index
        elif marker == "!platform_table_end" and begin is not None:
            end = index
            break
    if begin is None or end is None or end <= begin + 1:
        logger.warning("geo annotation: platform table markers not found")
        return {}, NO_GENE_ANNOTATION

    header = [part.strip().strip('"') for part in lines[begin + 1].split("\t")]
    gene_index: int | None = None
    for candidate in _GENE_COLUMN_PRIORITY:
        if candidate in header:
            gene_index = header.index(candidate)
            break
    if gene_index is None:
        return {}, NO_GENE_ANNOTATION

    mapping: dict[str, str] = {}
    for line in lines[begin + 2 : end]:
        values = [part.strip().strip('"') for part in line.split("\t")]
        if len(values) <= gene_index:
            continue
        probe = values[0]
        gene = values[gene_index]
        if probe and gene not in _MISSING_SENTINELS:
            mapping[probe] = gene
    if not mapping:
        return {}, UNMAPPED
    return mapping, MAPPED


def platform_table_columns(compressed: bytes) -> tuple[str | None, str | None]:
    """Return ``(probe_column, gene_column)`` for a SOFT platform table.

    Uses the same table-marker scan and gene-column priority as
    :func:`parse_platform_annotation`, so a MAPPED parse always has a
    non-None gene column. Returns ``(None, None)`` for malformed tables.
    """
    try:
        text = gzip.decompress(compressed).decode("utf-8", errors="replace")
    except (gzip.BadGzipFile, OSError):
        return None, None

    lines = text.splitlines()
    begin: int | None = None
    end: int | None = None
    for index, line in enumerate(lines):
        marker = line.strip().casefold()
        if marker == "!platform_table_begin":
            begin = index
        elif marker == "!platform_table_end" and begin is not None:
            end = index
            break
    if begin is None or end is None or end <= begin + 1:
        return None, None

    header = [part.strip().strip('"') for part in lines[begin + 1].split("\t")]
    if not header:
        return None, None
    probe_column = header[0]
    gene_column: str | None = None
    for candidate in _GENE_COLUMN_PRIORITY:
        if candidate in header:
            gene_column = candidate
            break
    return probe_column, gene_column


def fetch_platform_annotation(
    gpl: str,
    cache: ContentCache,
    client: httpx.Client | None = None,
) -> tuple[dict[str, str], str]:
    """Download (with content cache) and parse the annotation for *gpl*.

    Returns ``(probe → gene map, status)``. The bytes are cached by request
    identity ``(database="geo", accession=gpl, url)`` so repeat runs skip the
    network. Network or discovery failures degrade to
    :data:`ANNOTATION_UNAVAILABLE` rather than raising — the pipeline treats
    a missing probe→gene map as a data-quality warning, not a hard error.
    """
    owns_client = client is None
    if client is None:
        client = httpx.Client(
            follow_redirects=True,
            timeout=httpx.Timeout(connect=10.0, read=60.0, write=30.0, pool=10.0),
            headers={"User-Agent": "Mozilla/5.0 (BioMedQAgent pipeline)"},
        )
    try:
        # Platform-level cache key: deterministic from the accession alone, so
        # a cache hit skips both the directory listing and the file download.
        request_hash = canonical_request_hash(
            "geo", gpl, f"{_FTP_ROOT}/{geo_platform_dir(gpl)}/{gpl}/"
        )
        cached = cache.read_metadata(request_hash)
        if cached is not None:
            blob = cache.blob_path(cached["sha256"])
            if blob.is_file():
                logger.info("geo annotation: cache hit for %s", gpl)
                return parse_platform_annotation(blob.read_bytes())

        located = discover_annotation_file(client, gpl)
        if located is None:
            logger.warning("geo annotation: no annotation file for %s", gpl)
            return {}, ANNOTATION_UNAVAILABLE
        subdir, filename = located
        url = _file_url(gpl, subdir, filename)

        try:
            response = client.get(url)
            response.raise_for_status()
            data = response.content
        except httpx.HTTPError as exc:
            logger.warning("geo annotation: download failed for %s: %s", url, exc)
            return {}, ANNOTATION_UNAVAILABLE

        checksum = hashlib.sha256(data).hexdigest()
        blob = cache.blob_path(checksum)
        blob.write_bytes(data)
        cache.write_metadata(
            request_hash,
            {"sha256": checksum, "filename": filename, "media_type": "application/gzip"},
        )
        logger.info("geo annotation: cached %s bytes for %s (%s)", len(data), gpl, filename)
        return parse_platform_annotation(data)
    finally:
        if owns_client:
            client.close()


# Re-exported for callers that only need the status vocabulary.
__all__: list[str] = [
    "ANNOTATION_UNAVAILABLE",
    "MAPPED",
    "NO_GENE_ANNOTATION",
    "NOT_ATTEMPTED",
    "UNMAPPED",
    "discover_annotation_file",
    "fetch_platform_annotation",
    "geo_platform_dir",
    "parse_platform_annotation",
    "platform_table_columns",
]
