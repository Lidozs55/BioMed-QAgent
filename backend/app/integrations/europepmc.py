"""Europe PMC PMCID → fullTextXML retrieval client.

Implements the third tier of the project_memory-mandated PDF fallback chain:
    pdf_url (direct) → Unpaywall (DOI, 5s quick failure) → EPMC fullTextXML

Europe PMC is the project_memory-mandated alternative paper acquisition
channel for domestic network stability (NCBI PMC is often unreachable from
mainland China; EPMC at ``www.ebi.ac.uk`` is reliably reachable).

API docs: https://europepmc.org/RestfulWebService
Endpoint: https://www.ebi.ac.uk/europepmc/webservices/rest/{pmcid}/fullTextXML

Returns the full-text XML of an open-access PMC article. The XML is saved
as a ``.xml`` asset (not a PDF), so downstream consumers must handle XML
parsing (the ``extract_chart_data_vlm`` skill already accepts PDF input;
this client is for the acquisition stage to register provenance).
"""
from __future__ import annotations

import httpx

_EPMC_BASE = "https://www.ebi.ac.uk/europepmc/webservices/rest"
#: EPMC is domestically reachable; allow a longer timeout than Unpaywall.
_EPMC_TIMEOUT = 30.0
_BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/120.0.0.0 Safari/537.36"
)


class EuropePmcError(RuntimeError):
    """Raised when Europe PMC fullTextXML retrieval fails."""


def _normalize_pmcid(pmcid: str) -> str:
    """Normalize a PMCID to the bare digits form (e.g., PMC7450705 → 7450705)."""
    clean = pmcid.strip()
    if clean.lower().startswith("pmc"):
        clean = clean[3:]
    if not clean.isdigit():
        raise EuropePmcError(f"invalid PMCID (expected PMC\\d+): {pmcid!r}")
    return clean


async def fetch_full_text_xml(
    pmcid: str,
    *,
    timeout: float = _EPMC_TIMEOUT,
) -> bytes:
    """Fetch the fullTextXML for an open-access PMC article.

    Args:
        pmcid: PMCID string (e.g., ``"PMC7450705"`` or ``"7450705"``).
        timeout: Network timeout in seconds (default 30.0; EPMC is
            domestically reachable so this is more generous than Unpaywall's
            5s).

    Returns:
        Raw XML bytes (UTF-8 encoded).

    Raises:
        EuropePmcError: PMCID invalid, article not found, not open access,
            network error, or EPMC returned an error response.
    """
    try:
        digits = _normalize_pmcid(pmcid)
    except EuropePmcError:
        raise

    url = f"{_EPMC_BASE}/PMC{digits}/fullTextXML"
    headers = {
        "User-Agent": _BROWSER_UA,
        "Accept": "application/xml, text/xml, */*",
    }

    try:
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
            response = await client.get(url, headers=headers)
    except httpx.HTTPError as exc:
        raise EuropePmcError(f"EPMC network error: {exc}") from exc

    if response.status_code == 404:
        raise EuropePmcError(
            f"PMCID PMC{digits} not found in Europe PMC (not OA or does not exist)"
        )
    if response.status_code != 200:
        raise EuropePmcError(
            f"EPMC returned HTTP {response.status_code} for PMC{digits}"
        )

    content = response.content
    if not content:
        raise EuropePmcError(f"EPMC returned empty body for PMC{digits}")

    # Sanity check: should be XML
    if not content.lstrip().startswith(b"<"):
        raise EuropePmcError(
            f"EPMC returned non-XML body for PMC{digits} (first 80 bytes: "
            f"{content[:80]!r})"
        )

    return content


async def fetch_full_text_xml_url(pmcid: str) -> str:
    """Return the canonical EPMC fullTextXML URL for a PMCID.

    Useful for registering provenance in ``SourceRecord.url`` before the
    actual download happens via ``acquire_source()``.
    """
    digits = _normalize_pmcid(pmcid)
    return f"{_EPMC_BASE}/PMC{digits}/fullTextXML"
