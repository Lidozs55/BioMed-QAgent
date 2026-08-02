from __future__ import annotations

import asyncio
from collections.abc import Callable
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import app.tools.browser_pool as browser_pool_module
import pytest
from app.domain.contracts import DataLevel
from app.subagents.staging import SubagentStagingWorkspace
from app.tools.browser_pool import BrowserPool


def _allow_request(_url: str, *, resource_type: str) -> object:
    del resource_type
    return object()


class FakeRequest:
    def __init__(
        self,
        url: str,
        *,
        resource_type: str,
        main_frame: bool = False,
    ) -> None:
        self.url = url
        self.resource_type = resource_type
        self.frame = SimpleNamespace(parent_frame=None if main_frame else object())
        self._main_frame = main_frame

    def is_navigation_request(self) -> bool:
        return self._main_frame


class FakeRoute:
    def __init__(self, request: FakeRequest) -> None:
        self.request = request
        self.continued = False
        self.aborted = False

    async def continue_(self) -> None:
        self.continued = True

    async def abort(self) -> None:
        self.aborted = True


class FakeResponse:
    status = 200
    headers = {"content-type": "text/html"}


class FakePage:
    def __init__(self, context: FakeContext) -> None:
        self._context = context
        self.closed = False

    async def goto(self, url: str, **_kwargs: object) -> FakeResponse:
        requests = [
            FakeRequest(url, resource_type="document", main_frame=True),
            FakeRequest(
                url.replace("/page", "/redirected"),
                resource_type="document",
                main_frame=True,
            ),
            FakeRequest(
                "https://cdn.example.org/app.js",
                resource_type="script",
            ),
        ]
        for request in requests:
            route = FakeRoute(request)
            self._context.routes.append(route)
            assert self._context.route_handler is not None
            try:
                await self._context.route_handler(route)
            except BaseException:
                if not self._context.tracker.swallow_route_errors:
                    raise
        if self._context.tracker.block_operations:
            self._context.tracker.operations_started += 1
            self._context.tracker.operation_started.set()
            await self._context.tracker.release_operations.wait()
        return FakeResponse()

    async def content(self) -> str:
        self._context.tracker.content_calls += 1
        return self._context.tracker.content

    async def evaluate(
        self,
        expression: str,
        argument: object | None = None,
    ) -> object:
        if "TextEncoder" in expression:
            content = self._context.tracker.content
            size_bytes = len(content.encode("utf-8"))
            if self._context.tracker.content_after_measurement is not None:
                self._context.tracker.content = (
                    self._context.tracker.content_after_measurement
                )
            if isinstance(argument, int):
                return {
                    "over_limit": size_bytes > argument,
                    "size_bytes": size_bytes,
                    **({"content": content} if size_bytes <= argument else {}),
                }
            return size_bytes
        return self._context.tracker.document_size

    def locator(self, selector: str) -> FakeLocator:
        return FakeLocator(self._context.tracker, selector)

    async def wait_for_selector(
        self,
        selector: str,
        **_kwargs: object,
    ) -> None:
        self._context.tracker.actions.append(("wait_for", selector, None))

    async def screenshot(
        self,
        *,
        path: str | None = None,
        **_kwargs: object,
    ) -> bytes:
        if path is not None:
            Path(path).write_bytes(b"png")
        return self._context.tracker.screenshot

    async def close(self) -> None:
        self.closed = True
        self._context.tracker.closed_pages += 1


class FakeLocator:
    def __init__(self, tracker: FakePlaywright, selector: str) -> None:
        self._tracker = tracker
        self._selector = selector

    async def click(self, **_kwargs: object) -> None:
        self._tracker.actions.append(("click", self._selector, None))

    async def fill(self, value: str, **_kwargs: object) -> None:
        self._tracker.actions.append(("fill", self._selector, value))

    async def select_option(self, value: str, **_kwargs: object) -> None:
        self._tracker.actions.append(("select", self._selector, value))

    async def inner_text(self, **_kwargs: object) -> str:
        self._tracker.inner_text_calls += 1
        self._tracker.actions.append(("extract", self._selector, None))
        return self._tracker.extract_text

    async def evaluate(
        self,
        expression: str,
        argument: object | None = None,
    ) -> object:
        assert "TextEncoder" in expression
        content = self._tracker.extract_text
        size_bytes = len(content.encode("utf-8"))
        if self._tracker.extract_text_after_measurement is not None:
            self._tracker.extract_text = self._tracker.extract_text_after_measurement
        if isinstance(argument, int):
            self._tracker.actions.append(("extract", self._selector, None))
            return {
                "over_limit": size_bytes > argument,
                "size_bytes": size_bytes,
                **({"content": content} if size_bytes <= argument else {}),
            }
        return size_bytes

    async def screenshot(self, **_kwargs: object) -> bytes:
        self._tracker.actions.append(("screenshot", self._selector, None))
        return self._tracker.screenshot

    async def bounding_box(self) -> dict[str, float]:
        return self._tracker.selector_box


class FakeContext:
    def __init__(self, tracker: FakePlaywright) -> None:
        self.tracker = tracker
        self.route_handler: Callable[[Any], Any] | None = None
        self.routes: list[FakeRoute] = []
        self.closed = False

    async def add_init_script(self, _script: str) -> None:
        return None

    async def route(self, _pattern: str, handler: Callable[[Any], Any]) -> None:
        self.route_handler = handler

    async def new_page(self) -> FakePage:
        return FakePage(self)

    async def close(self) -> None:
        if not self.closed:
            self.closed = True
            self.tracker.active_contexts -= 1
            self.tracker.closed_contexts += 1


class FakeBrowser:
    def __init__(self, tracker: FakePlaywright) -> None:
        self.tracker = tracker
        self.closed = False

    async def new_context(self, **kwargs: object) -> FakeContext:
        assert kwargs["accept_downloads"] is False
        self.tracker.context_options.append(kwargs)
        self.tracker.active_contexts += 1
        self.tracker.max_active_contexts = max(
            self.tracker.max_active_contexts,
            self.tracker.active_contexts,
        )
        context = FakeContext(self.tracker)
        self.tracker.contexts.append(context)
        return context

    async def close(self) -> None:
        self.closed = True


class FakeChromium:
    def __init__(self, tracker: FakePlaywright) -> None:
        self.tracker = tracker

    async def launch(self, **_kwargs: object) -> FakeBrowser:
        self.tracker.browser_launches += 1
        if self.tracker.launch_failures:
            self.tracker.launch_failures -= 1
            raise RuntimeError("chromium launch failed")
        self.tracker.browser = FakeBrowser(self.tracker)
        return self.tracker.browser


class FakeManager:
    def __init__(self, tracker: FakePlaywright) -> None:
        self.tracker = tracker

    async def start(self) -> FakePlaywright:
        self.tracker.manager_starts += 1
        return self.tracker


class FakePlaywright:
    def __init__(
        self,
        *,
        block_operations: bool = False,
        swallow_route_errors: bool = False,
    ) -> None:
        self.chromium = FakeChromium(self)
        self.browser: FakeBrowser | None = None
        self.browser_launches = 0
        self.launch_failures = 0
        self.manager_starts = 0
        self.manager_stops = 0
        self.active_contexts = 0
        self.max_active_contexts = 0
        self.closed_contexts = 0
        self.closed_pages = 0
        self.contexts: list[FakeContext] = []
        self.context_options: list[dict[str, object]] = []
        self.actions: list[tuple[str, str, str | None]] = []
        self.content = "<html>rendered</html>"
        self.content_after_measurement: str | None = None
        self.extract_text = "extracted data"
        self.extract_text_after_measurement: str | None = None
        self.content_calls = 0
        self.inner_text_calls = 0
        self.screenshot = b"png"
        self.document_size = {"width": 1920, "height": 1080}
        self.selector_box = {
            "x": 0.0,
            "y": 0.0,
            "width": 640.0,
            "height": 480.0,
        }
        self.swallow_route_errors = swallow_route_errors
        self.block_operations = block_operations
        self.operations_started = 0
        self.operation_started = asyncio.Event()
        self.release_operations = asyncio.Event()

    def factory(self) -> FakeManager:
        return FakeManager(self)

    async def stop(self) -> None:
        self.manager_stops += 1


@pytest.mark.asyncio
async def test_pool_uses_one_browser_and_at_most_four_contexts() -> None:
    fake = FakePlaywright(block_operations=True)
    pool = BrowserPool(max_contexts=4, playwright_factory=fake.factory)
    await pool.start()

    tasks = [
        asyncio.create_task(
            pool.fetch(
                f"https://example.org/page?index={index}",
                authorize_request=_allow_request,
            )
        )
        for index in range(8)
    ]
    await fake.operation_started.wait()
    while fake.operations_started < 4:
        await asyncio.sleep(0)

    assert fake.browser_launches == 1
    assert fake.max_active_contexts == 4

    fake.release_operations.set()
    results = await asyncio.gather(*tasks)
    assert all(result.status_code == 200 for result in results)
    await pool.close()
    assert fake.manager_stops == 1
    assert fake.browser is not None and fake.browser.closed


@pytest.mark.asyncio
async def test_route_authorizes_main_frames_redirects_and_subresources_before_transport() -> None:
    fake = FakePlaywright()
    pool = BrowserPool(playwright_factory=fake.factory)
    authorized: list[tuple[str, str]] = []

    def authorize(url: str, *, resource_type: str) -> object:
        authorized.append((url, resource_type))
        return object()

    await pool.start()
    result = await pool.fetch(
        "https://example.org/page",
        authorize_request=authorize,
    )
    await pool.close()

    assert result.content == "<html>rendered</html>"
    assert authorized == [
        ("https://example.org/page", "main_frame"),
        ("https://example.org/redirected", "main_frame"),
        ("https://cdn.example.org/app.js", "script"),
    ]
    assert all(route.continued for route in fake.contexts[0].routes)
    assert fake.context_options[0]["service_workers"] == "block"
    proxy = fake.context_options[0]["proxy"]
    assert isinstance(proxy, dict)
    assert proxy["server"].startswith("http://127.0.0.1:")
    assert proxy["username"]
    assert proxy["password"]


@pytest.mark.asyncio
async def test_route_aborts_denied_subresource_without_failing_page() -> None:
    fake = FakePlaywright()
    pool = BrowserPool(playwright_factory=fake.factory)

    def authorize(url: str, *, resource_type: str) -> object:
        del resource_type
        if "cdn.example.org" in url:
            raise ValueError("denied subresource")
        return object()

    await pool.start()
    result = await pool.fetch(
        "https://example.org/page",
        authorize_request=authorize,
    )
    await pool.close()

    assert result.status_code > 0
    denied = fake.contexts[0].routes[-1]
    assert denied.aborted
    assert not denied.continued


@pytest.mark.asyncio
async def test_route_denial_of_main_document_still_fails_fetch() -> None:
    fake = FakePlaywright()
    pool = BrowserPool(playwright_factory=fake.factory)

    def authorize(url: str, *, resource_type: str) -> object:
        if "example.org" in url and resource_type == "main_frame":
            raise ValueError("denied main document")
        return object()

    await pool.start()
    with pytest.raises(ValueError, match="denied main document"):
        await pool.fetch(
            "https://example.org/page",
            authorize_request=authorize,
        )
    await pool.close()




@pytest.mark.asyncio
async def test_cancellation_closes_page_and_context() -> None:
    fake = FakePlaywright(block_operations=True)
    pool = BrowserPool(playwright_factory=fake.factory)
    await pool.start()
    task = asyncio.create_task(
        pool.fetch(
            "https://example.org/page",
            authorize_request=_allow_request,
        )
    )
    await fake.operation_started.wait()

    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    assert fake.active_contexts == 0
    assert fake.closed_contexts == 1
    assert fake.closed_pages == 1
    await pool.close()


@pytest.mark.asyncio
async def test_screenshot_is_atomically_staged_as_source_asset(
    tmp_path: Path,
) -> None:
    fake = FakePlaywright()
    pool = BrowserPool(playwright_factory=fake.factory)
    workspace = SubagentStagingWorkspace(tmp_path / "task", "sub_1")
    await pool.start()

    result = await pool.screenshot(
        "https://example.org/page",
        workspace=workspace,
        filename="capture.png",
        source_id="source_1",
        successful_attempt_id="attempt_1",
        data_level=DataLevel.METADATA,
        authorize_request=_allow_request,
    )
    assert result.path == workspace.staged_path(result.source_asset)
    assert result.path.read_bytes() == b"png"
    await pool.close()


@pytest.mark.asyncio
async def test_browser_outputs_enforce_exact_byte_limits(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake = FakePlaywright()
    fake.content = "12345678"
    fake.screenshot = b"12345678"
    pool = BrowserPool(playwright_factory=fake.factory)
    workspace = SubagentStagingWorkspace(tmp_path / "task", "sub_1")
    monkeypatch.setattr(browser_pool_module, "MAX_BROWSER_CONTENT_BYTES", 8)
    monkeypatch.setattr(browser_pool_module, "MAX_BROWSER_SCREENSHOT_BYTES", 8)
    await pool.start()

    assert (
        await pool.fetch(
            "https://example.org/page",
            authorize_request=_allow_request,
        )
    ).content == "12345678"
    screenshot = await pool.screenshot(
        "https://example.org/page",
        workspace=workspace,
        filename="exact.png",
        source_id="source_1",
        successful_attempt_id="attempt_1",
        data_level=DataLevel.METADATA,
        authorize_request=_allow_request,
    )
    assert screenshot.path.read_bytes() == b"12345678"

    fake.content = "123456789"
    fake.screenshot = b"123456789"
    with pytest.raises(ValueError, match="browser content exceeded 8 byte limit"):
        await pool.fetch(
            "https://example.org/page",
            authorize_request=_allow_request,
        )
    with pytest.raises(ValueError, match="browser screenshot exceeded 8 byte limit"):
        await pool.screenshot(
            "https://example.org/page",
            workspace=workspace,
            filename="oversized.png",
            source_id="source_2",
            successful_attempt_id="attempt_2",
            data_level=DataLevel.METADATA,
            authorize_request=_allow_request,
        )
    assert not (workspace.root / "source_assets" / "oversized.png").exists()
    await pool.close()


@pytest.mark.asyncio
async def test_fetch_rejects_oversized_dom_before_materializing_content(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake = FakePlaywright()
    fake.content = "12345"
    pool = BrowserPool(playwright_factory=fake.factory)
    monkeypatch.setattr(browser_pool_module, "MAX_BROWSER_CONTENT_BYTES", 4)
    await pool.start()

    with pytest.raises(ValueError, match="browser content exceeded 4 byte limit"):
        await pool.fetch(
            "https://example.org/page",
            authorize_request=_allow_request,
        )

    assert fake.content_calls == 0
    await pool.close()


@pytest.mark.asyncio
async def test_fetch_serializes_before_dom_expands_without_second_materialization(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake = FakePlaywright()
    fake.content = "1234"
    fake.content_after_measurement = "12345"
    pool = BrowserPool(playwright_factory=fake.factory)
    monkeypatch.setattr(browser_pool_module, "MAX_BROWSER_CONTENT_BYTES", 4)
    await pool.start()

    result = await pool.fetch(
        "https://example.org/page",
        authorize_request=_allow_request,
    )

    assert result.content == "1234"
    assert fake.content == "12345"
    assert fake.content_calls == 0
    await pool.close()


@pytest.mark.asyncio
async def test_full_page_screenshot_rejects_unbounded_document_before_capture(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake = FakePlaywright()
    fake.document_size = {"width": 10_000, "height": 10_000}
    pool = BrowserPool(playwright_factory=fake.factory)
    workspace = SubagentStagingWorkspace(tmp_path / "task", "sub_1")
    monkeypatch.setattr(browser_pool_module, "MAX_BROWSER_SCREENSHOT_PIXELS", 1_000)
    await pool.start()

    with pytest.raises(ValueError, match="screenshot exceeded 1000 pixel limit"):
        await pool.screenshot(
            "https://example.org/page",
            workspace=workspace,
            filename="oversized.png",
            source_id="source_1",
            successful_attempt_id="attempt_1",
            data_level=DataLevel.METADATA,
            authorize_request=_allow_request,
        )

    assert fake.screenshot == b"png"
    assert not (workspace.root / "source_assets").exists()
    await pool.close()


@pytest.mark.asyncio
async def test_screenshot_rejects_staging_symlink_escape(
    tmp_path: Path,
) -> None:
    fake = FakePlaywright()
    pool = BrowserPool(playwright_factory=fake.factory)
    workspace = SubagentStagingWorkspace(tmp_path / "task", "sub_1")
    outside = tmp_path / "outside"
    outside.mkdir()
    staging_assets = workspace.root / "source_assets"
    try:
        staging_assets.symlink_to(outside, target_is_directory=True)
    except OSError:
        pytest.skip("directory symlinks are unavailable on this platform")
    await pool.start()

    with pytest.raises(ValueError, match="symlink|reparse|trusted"):
        await pool.screenshot(
            "https://example.org/page",
            workspace=workspace,
            filename="capture.png",
            source_id="source_1",
            successful_attempt_id="attempt_1",
            data_level=DataLevel.METADATA,
            authorize_request=_allow_request,
        )

    assert not (outside / "capture.png").exists()
    await pool.close()


@pytest.mark.asyncio
async def test_browser_session_supports_all_declared_recipe_actions() -> None:
    fake = FakePlaywright()
    pool = BrowserPool(playwright_factory=fake.factory)
    await pool.start()
    session = await pool.open_session(authorize_request=_allow_request)

    await session.action(
        action="navigate",
        target=None,
        value="https://example.org/page",
        current_url="https://example.org/page",
        timeout_seconds=5,
    )
    await session.action(
        action="click",
        target="button.open",
        value=None,
        current_url="https://example.org/page",
        timeout_seconds=5,
    )
    await session.action(
        action="fill",
        target="input.query",
        value="GSE100",
        current_url="https://example.org/page",
        timeout_seconds=5,
    )
    await session.action(
        action="select",
        target="select.species",
        value="human",
        current_url="https://example.org/page",
        timeout_seconds=5,
    )
    await session.action(
        action="wait_for",
        target="#results",
        value=None,
        current_url="https://example.org/page",
        timeout_seconds=5,
    )
    extracted = await session.action(
        action="extract",
        target="#results",
        value=None,
        current_url="https://example.org/page",
        timeout_seconds=5,
    )

    assert extracted.content == b"extracted data"
    assert fake.actions == [
        ("click", "button.open", None),
        ("fill", "input.query", "GSE100"),
        ("select", "select.species", "human"),
        ("wait_for", "#results", None),
        ("extract", "#results", None),
    ]
    await session.close()
    assert fake.active_contexts == 0
    await pool.close()


@pytest.mark.asyncio
async def test_browser_session_rejects_oversized_extract(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake = FakePlaywright()
    pool = BrowserPool(playwright_factory=fake.factory)
    monkeypatch.setattr(browser_pool_module, "MAX_BROWSER_EXTRACT_BYTES", 4)
    await pool.start()
    session = await pool.open_session(authorize_request=_allow_request)

    with pytest.raises(ValueError, match="browser extract exceeded 4 byte limit"):
        await session.action(
            action="extract",
            target="#results",
            value=None,
            current_url="https://example.org/page",
            timeout_seconds=5,
        )

    assert fake.inner_text_calls == 0
    await session.close()
    await pool.close()


@pytest.mark.asyncio
async def test_extract_serializes_before_dom_expands_without_inner_text_call(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake = FakePlaywright()
    fake.extract_text = "1234"
    fake.extract_text_after_measurement = "12345"
    pool = BrowserPool(playwright_factory=fake.factory)
    monkeypatch.setattr(browser_pool_module, "MAX_BROWSER_EXTRACT_BYTES", 4)
    await pool.start()
    session = await pool.open_session(authorize_request=_allow_request)

    result = await session.action(
        action="extract",
        target="#results",
        value=None,
        current_url="https://example.org/page",
        timeout_seconds=5,
    )

    assert result.content == b"1234"
    assert fake.extract_text == "12345"
    assert fake.inner_text_calls == 0
    await session.close()
    await pool.close()


@pytest.mark.asyncio
async def test_failed_browser_launch_stops_manager_and_allows_clean_retry() -> None:
    fake = FakePlaywright()
    fake.launch_failures = 1
    pool = BrowserPool(playwright_factory=fake.factory)
    await pool.start()

    with pytest.raises(RuntimeError, match="chromium launch failed"):
        await pool.fetch(
            "https://example.org/page",
            authorize_request=_allow_request,
        )

    assert fake.manager_starts == 1
    assert fake.manager_stops == 1

    result = await pool.fetch(
        "https://example.org/page",
        authorize_request=_allow_request,
    )
    assert result.status_code == 200
    assert fake.manager_starts == 2
    assert fake.browser_launches == 2

    await pool.close()
    assert fake.manager_stops == 2
