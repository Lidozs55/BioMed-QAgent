"""Unpaywall DOI → OA PDF URL lookup client.

Implements the second tier of the project_memory-mandated PDF fallback chain:
    pdf_url (direct) → Unpaywall (DOI, 5s quick failure) → EPMC fullTextXML

Unpaywall API docs: https://unpaywall.org/products/api
Endpoint: https://api.unpaywall.org/v2/{doi}?email={email}

This client is intentionally minimal: it only resolves the DOI to a
best-oa-location pdf_url. The actual PDF download is handled by
``acquire_source()`` once the URL is known.
"""
from __future__ import annotations

import httpx

from app.config import settings

_UNPAYWALL_BASE = "https://api.unpaywall.org/v2"
#: 5-second quick failure per project_memory L1 hard constraint.
_UNPAYWALL_TIMEOUT = 5.0


class UnpaywallError(RuntimeError):
    """Raised when Unpaywall lookup fails or returns no OA PDF URL."""


async def lookup_pdf_url(
    doi: str,
    *,
    email: str | None = None,
    timeout: float = _UNPAYWALL_TIMEOUT,
) -> str:
    """Resolve a DOI to an open-access PDF URL via Unpaywall.

    Args:
        doi: DOI string (e.g., "10.1234/example"). Leading ``https://doi.org/``
            is stripped automatically.
        email: Unpaywall requires an email contact. Defaults to
            ``settings.ncbi_email`` (falls back to a placeholder).
        timeout: Quick-failure timeout in seconds (default 5.0 per
            project_memory L1).

    Returns:
        Best-oa-location PDF URL (``https://...``).

    Raises:
        UnpaywallError: DOI not found, no OA location, network error, or
            Unpaywall returned an error response.
    """
    clean_doi = doi.strip()
    # Strip DOI URL prefix if present
    for prefix in ("https://doi.org/", "http://doi.org/", "doi:"):
        if clean_doi.lower().startswith(prefix):
            clean_doi = clean_doi[len(prefix):]
            break
    if not clean_doi:
        raise UnpaywallError("empty DOI after normalization")

    contact_email = email or settings.ncbi_email or "biomed-qagent@example.com"
    url = f"{_UNPAYWALL_BASE}/{clean_doi}"
    params = {"email": contact_email}

    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.get(url, params=params)
    except httpx.HTTPError as exc:
        raise UnpaywallError(f"Unpaywall network error: {exc}") from exc

    if response.status_code == 404:
        raise UnpaywallError(f"DOI not found in Unpaywall: {clean_doi}")
    if response.status_code != 200:
        raise UnpaywallError(
            f"Unpaywall returned HTTP {response.status_code} for DOI {clean_doi}"
        )

    try:
        data = response.json()
    except ValueError as exc:
        raise UnpaywallError(f"Unpaywall returned non-JSON response: {exc}") from exc

    # is_oa flag is the authoritative OA status
    if not data.get("is_oa", False):
        raise UnpaywallError(f"DOI {clean_doi} has no open-access version")

    # best_oa_location is the preferred OA location (Unpaywall ranks them)
    best_oa = data.get("best_oa_location")
    if not best_oa:
        raise UnpaywallError(f"DOI {clean_doi} has no best_oa_location")

    pdf_url = best_oa.get("url_for_pdf")
    if not pdf_url:
        # Fall back to landing page if no direct PDF URL
        landing = best_oa.get("url")
        if not landing:
            raise UnpaywallError(f"DOI {clean_doi} best_oa_location has no url_for_pdf")
        raise UnpaywallError(
            f"DOI {clean_doi} has OA landing page but no direct PDF URL; "
            f"landing={landing}"
        )

    if not pdf_url.startswith("https://"):
        raise UnpaywallError(
            f"Unpaywall returned non-HTTPS PDF URL (rejected): {pdf_url}"
        )

    return pdf_url
