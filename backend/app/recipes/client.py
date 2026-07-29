"""Controlled transport facade for declarative WorkflowRecipe execution."""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Callable, Mapping
from contextlib import asynccontextmanager

import httpx
from bs4 import BeautifulSoup
from soupsieve import SelectorSyntaxError

from app.integrations.acquisition import ValidatedRecipeTarget
from app.recipes.executor import (
    BrowserRequestAuthorizer,
    RecipeStepResponse,
)

_DEFAULT_MEDIA_TYPE = "application/octet-stream"
MAX_RECIPE_RESPONSE_BYTES = 100 * 1024 * 1024
RecipeTransportFactory = Callable[[str], httpx.AsyncBaseTransport]


class ControlledRecipeClient:
    """Execute only address-pinned, no-follow Recipe HTTP requests."""

    def __init__(
        self,
        *,
        transport_factory: RecipeTransportFactory | None = None,
    ) -> None:
        self._transport_factory = transport_factory
        self._clients: dict[str, httpx.AsyncClient] = {}
        self._transport_ids: set[int] = set()
        self._lock = asyncio.Lock()
        self._closed = False

    @property
    def is_closed(self) -> bool:
        return self._closed

    async def aclose(self) -> None:
        async with self._lock:
            if self._closed:
                return
            self._closed = True
            clients = tuple(self._clients.values())
            self._clients.clear()
        await asyncio.gather(*(client.aclose() for client in clients))

    async def api_request(
        self,
        *,
        method: str,
        target: ValidatedRecipeTarget,
        headers: Mapping[str, str],
        query_params: Mapping[str, str],
        timeout_seconds: float,
    ) -> RecipeStepResponse:
        return await self._request(
            method=method,
            target=target,
            headers=headers,
            query_params=query_params,
            timeout_seconds=timeout_seconds,
        )

    async def html_extract(
        self,
        *,
        target: ValidatedRecipeTarget,
        selectors: Mapping[str, str],
        timeout_seconds: float,
    ) -> RecipeStepResponse:
        response = await self._request(
            method="GET",
            target=target,
            headers={},
            query_params={},
            timeout_seconds=timeout_seconds,
        )
        if not response.transport_ok:
            return response

        document = BeautifulSoup(response.content, "html.parser")
        extracted: dict[str, list[str]] = {}
        for name, selector in sorted(selectors.items()):
            try:
                values = [
                    text
                    for element in document.select(selector)
                    if (text := element.get_text(" ", strip=True))
                ]
            except SelectorSyntaxError:
                return RecipeStepResponse(
                    content=b"",
                    status_code=response.status_code,
                    media_type="application/json",
                    error=f"HTML selector is invalid: {name}",
                )
            if not values:
                return RecipeStepResponse(
                    content=b"",
                    status_code=response.status_code,
                    media_type="application/json",
                    error=f"HTML selector produced no content: {name}",
                )
            extracted[name] = values

        return RecipeStepResponse(
            content=json.dumps(
                extracted,
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            ).encode("utf-8"),
            status_code=response.status_code,
            media_type="application/json",
        )

    @asynccontextmanager
    async def browser_authorization(
        self,
        *,
        authorize_request: BrowserRequestAuthorizer,
    ) -> AsyncIterator[None]:
        del authorize_request
        yield

    async def browser_action(
        self,
        *,
        action: str,
        target: str | None,
        value: str | None,
        current_url: str,
        timeout_seconds: float,
    ) -> RecipeStepResponse:
        del action, target, value, current_url, timeout_seconds
        raise RuntimeError("browser Recipe execution is unavailable")

    async def _request(
        self,
        *,
        method: str,
        target: ValidatedRecipeTarget,
        headers: Mapping[str, str],
        query_params: Mapping[str, str],
        timeout_seconds: float,
    ) -> RecipeStepResponse:
        pinned = target.public_target
        partition = target.host.strip().lower().rstrip(".")
        sni_hostname = pinned.sni_hostname.strip().lower().rstrip(".")
        if not partition or partition != sni_hostname:
            raise ValueError("validated Recipe target host and SNI must match")
        http = await self._client_for(partition)
        request_headers = {name: value for name, value in headers.items() if name.lower() != "host"}
        request_headers["Host"] = pinned.host_header
        request = http.build_request(
            method,
            pinned.connect_url,
            headers=request_headers,
            params=query_params,
            timeout=timeout_seconds,
            extensions={"sni_hostname": pinned.sni_hostname},
        )
        response: httpx.Response | None = None
        try:
            response = await http.send(
                request,
                follow_redirects=False,
                stream=True,
            )
            media_type = (
                response.headers.get("content-type", _DEFAULT_MEDIA_TYPE).split(";", 1)[0].strip()
                or _DEFAULT_MEDIA_TYPE
            )
            if 300 <= response.status_code < 400:
                redirect_url = response.headers.get("location")
                return RecipeStepResponse(
                    content=b"",
                    status_code=response.status_code,
                    media_type=media_type,
                    redirect_url=redirect_url,
                    error=(None if redirect_url else "redirect response missing Location header"),
                )

            declared_length = response.headers.get("content-length", "").strip()
            if declared_length.isdigit() and (int(declared_length) > MAX_RECIPE_RESPONSE_BYTES):
                return self._oversized_response(response.status_code, media_type)

            chunks: list[bytes] = []
            received = 0
            async for chunk in response.aiter_bytes():
                received += len(chunk)
                if received > MAX_RECIPE_RESPONSE_BYTES:
                    return self._oversized_response(response.status_code, media_type)
                chunks.append(chunk)
            return RecipeStepResponse(
                content=b"".join(chunks),
                status_code=response.status_code,
                media_type=media_type,
            )
        except httpx.HTTPError as error:
            return RecipeStepResponse(
                content=b"",
                status_code=0,
                media_type=_DEFAULT_MEDIA_TYPE,
                error=f"{type(error).__name__}: {error}",
            )
        finally:
            if response is not None:
                await response.aclose()

    @staticmethod
    def _oversized_response(
        status_code: int,
        media_type: str,
    ) -> RecipeStepResponse:
        return RecipeStepResponse(
            content=b"",
            status_code=status_code,
            media_type=media_type,
            error=(f"Recipe response exceeded {MAX_RECIPE_RESPONSE_BYTES} byte limit"),
        )

    async def _client_for(self, partition: str) -> httpx.AsyncClient:
        async with self._lock:
            if self._closed:
                raise RuntimeError("controlled Recipe client is closed")
            existing = self._clients.get(partition)
            if existing is not None:
                return existing
            transport = (
                self._transport_factory(partition) if self._transport_factory is not None else None
            )
            if transport is not None:
                transport_id = id(transport)
                if transport_id in self._transport_ids:
                    raise ValueError(
                        "Recipe transport factory must return a distinct "
                        "transport for each SNI partition"
                    )
                self._transport_ids.add(transport_id)
            client = httpx.AsyncClient(
                timeout=30.0,
                follow_redirects=False,
                trust_env=False,
                transport=transport,
            )
            self._clients[partition] = client
            return client
