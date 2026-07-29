"""Controlled transport facade for declarative WorkflowRecipe execution."""

from __future__ import annotations

import asyncio
import json
import weakref
from collections.abc import AsyncIterator, Callable, Mapping
from contextlib import asynccontextmanager
from contextvars import ContextVar
from typing import Any

import httpx
from bs4 import BeautifulSoup
from soupsieve import SelectorSyntaxError

from app.integrations.acquisition import ValidatedRecipeTarget
from app.recipes.executor import (
    BrowserRequestAuthorizer,
    RecipeStepResponse,
)
from app.tools.browser_pool import BrowserPool, BrowserSession

_DEFAULT_MEDIA_TYPE = "application/octet-stream"
MAX_RECIPE_RESPONSE_BYTES = 100 * 1024 * 1024
RecipeTransportFactory = Callable[[str], httpx.AsyncBaseTransport]


class ControlledRecipeClient:
    """Execute only address-pinned, no-follow Recipe HTTP requests."""

    def __init__(
        self,
        *,
        transport_factory: RecipeTransportFactory | None = None,
        browser_pool: BrowserPool | None = None,
    ) -> None:
        self._transport_factory = transport_factory
        self._browser_pool = browser_pool
        self._active_clients: set[httpx.AsyncClient] = set()
        self._issued_transports: weakref.WeakValueDictionary[int, httpx.AsyncBaseTransport] = (
            weakref.WeakValueDictionary()
        )
        self._condition = asyncio.Condition()
        self._browser_session_lock = asyncio.Lock()
        self._browser_sessions: dict[asyncio.Task[Any], BrowserSession] = {}
        self._active_browser_operations = 0
        self._browser_authorizer: ContextVar[BrowserRequestAuthorizer | None] = ContextVar(
            f"recipe_browser_authorizer_{id(self)}",
            default=None,
        )
        self._closed = False

    @property
    def is_closed(self) -> bool:
        return self._closed

    async def aclose(self) -> None:
        async with self._condition:
            self._closed = True
            await self._condition.wait_for(
                lambda: not self._active_clients and self._active_browser_operations == 0
            )
        await self._close_all_browser_sessions()

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
        token = self._browser_authorizer.set(authorize_request)
        try:
            yield
        finally:
            try:
                await self._close_current_browser_session()
            finally:
                self._browser_authorizer.reset(token)

    async def browser_action(
        self,
        *,
        action: str,
        target: str | None,
        value: str | None,
        current_url: str,
        timeout_seconds: float,
    ) -> RecipeStepResponse:
        if self._browser_pool is None:
            raise RuntimeError("browser Recipe execution is unavailable")
        authorizer = self._browser_authorizer.get()
        if authorizer is None:
            raise RuntimeError("browser Recipe action used outside authorization scope")
        task = asyncio.current_task()
        if task is None:  # pragma: no cover - asyncio always owns awaited work
            raise RuntimeError("browser Recipe action requires an asyncio task")
        await self._begin_browser_operation()
        try:
            session = await self._browser_session(
                task=task,
                authorize_request=authorizer,
            )
            try:
                result = await session.action(
                    action=action,
                    target=target,
                    value=value,
                    current_url=current_url,
                    timeout_seconds=timeout_seconds,
                )
            except BaseException:
                await self._close_browser_session(task)
                raise
        finally:
            await self._end_browser_operation()
        return RecipeStepResponse(
            content=result.content,
            status_code=result.status_code,
            media_type=result.media_type,
        )

    async def _begin_browser_operation(self) -> None:
        async with self._condition:
            if self._closed:
                raise RuntimeError("controlled Recipe client is closed")
            self._active_browser_operations += 1

    async def _end_browser_operation(self) -> None:
        async with self._condition:
            self._active_browser_operations -= 1
            self._condition.notify_all()

    async def _browser_session(
        self,
        *,
        task: asyncio.Task[Any],
        authorize_request: BrowserRequestAuthorizer,
    ) -> BrowserSession:
        async with self._browser_session_lock:
            existing = self._browser_sessions.get(task)
            if existing is not None:
                return existing
            assert self._browser_pool is not None
            session = await self._browser_pool.open_session(
                authorize_request=authorize_request,
            )
            self._browser_sessions[task] = session
            return session

    async def _close_current_browser_session(self) -> None:
        task = asyncio.current_task()
        if task is not None:
            await self._close_browser_session(task)

    async def _close_browser_session(
        self,
        task: asyncio.Task[Any],
    ) -> None:
        async with self._browser_session_lock:
            session = self._browser_sessions.pop(task, None)
        if session is not None:
            await session.close()

    async def _close_all_browser_sessions(self) -> None:
        async with self._browser_session_lock:
            sessions = tuple(self._browser_sessions.values())
            self._browser_sessions.clear()
        await asyncio.gather(
            *(session.close() for session in sessions),
            return_exceptions=True,
        )

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
        http = await self._open_client(partition)
        request_headers = {name: value for name, value in headers.items() if name.lower() != "host"}
        request_headers["Host"] = pinned.host_header
        response: httpx.Response | None = None
        try:
            request = http.build_request(
                method,
                pinned.connect_url,
                headers=request_headers,
                params=query_params,
                timeout=timeout_seconds,
                extensions={"sni_hostname": pinned.sni_hostname},
            )
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
            try:
                if response is not None:
                    await response.aclose()
            finally:
                await self._release_client(http)

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

    async def _open_client(self, partition: str) -> httpx.AsyncClient:
        async with self._condition:
            if self._closed:
                raise RuntimeError("controlled Recipe client is closed")
            transport = (
                self._transport_factory(partition) if self._transport_factory is not None else None
            )
            if transport is not None:
                transport_id = id(transport)
                if self._issued_transports.get(transport_id) is transport:
                    raise ValueError(
                        "Recipe transport factory must return a fresh transport for every request"
                    )
                self._issued_transports[transport_id] = transport
            client = httpx.AsyncClient(
                timeout=30.0,
                follow_redirects=False,
                trust_env=False,
                transport=transport,
            )
            self._active_clients.add(client)
            return client

    async def _release_client(self, client: httpx.AsyncClient) -> None:
        try:
            await client.aclose()
        finally:
            async with self._condition:
                self._active_clients.discard(client)
                self._condition.notify_all()
