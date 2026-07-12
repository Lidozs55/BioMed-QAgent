"""Construction and ownership boundary for NCBI integration services."""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path

import httpx

from app.config import settings
from app.integrations.ncbi.client import NcbiClientConfig, NcbiEutilsClient
from app.integrations.ncbi.discovery import NcbiDiscoveryClient
from app.tools.content_cache import ContentCache


@dataclass(frozen=True)
class NcbiServices:
    """Injectable services shared by thin NCBI-facing Skill adapters."""

    eutils: NcbiDiscoveryClient
    http: httpx.AsyncClient
    cache: ContentCache


def ncbi_client_config() -> NcbiClientConfig:
    return NcbiClientConfig(
        email=settings.ncbi_email,
        tool=settings.ncbi_tool,
        user_agent=settings.ncbi_user_agent,
        api_key=settings.ncbi_api_key or None,
    )


@asynccontextmanager
async def open_ncbi_services(
    *,
    http: httpx.AsyncClient | None = None,
    cache_root: Path | None = None,
    config: NcbiClientConfig | None = None,
) -> AsyncIterator[NcbiServices]:
    """Open production services, while allowing fixture-owned dependencies."""

    owned_http = http is None
    session = http or httpx.AsyncClient(
        timeout=httpx.Timeout(connect=10.0, read=60.0, write=30.0, pool=10.0)
    )
    try:
        yield NcbiServices(
            eutils=NcbiEutilsClient(
                http=session, config=config or ncbi_client_config()
            ),
            http=session,
            cache=ContentCache(
                cache_root or Path(settings.output_dir) / "cache" / "ncbi"
            ),
        )
    finally:
        if owned_http:
            await session.aclose()
