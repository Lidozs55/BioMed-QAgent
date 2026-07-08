"""浏览器自动化爬虫 — JS 重站点采集核心（TASK-012 MVP）。

对齐 docs/agent_browser_integration.md Method B：
- 使用 Playwright（Chromium）渲染 JS 重站点
- 输出 raw crawl record（raw_type=screenshot 或 html）
- 截图供 ParserAgent 调用 Qwen-VL extract_chart_data 提取图表数据
- 同步接口，由 AcquireAgent 通过 _to_thread 调用

设计：
- 懒加载 Playwright（首次调用时启动浏览器，避免启动时开销）
- 单浏览器实例复用（进程级单例）
- 超时 30s，失败返回空列表（不阻塞流水线）
"""
from __future__ import annotations

import base64
import logging
import time
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

# 浏览器单例（进程级复用）
_browser: Any = None
_playwright: Any = None

# 截图保存目录（由调用方传入 task_id 构造路径）
_DEFAULT_TIMEOUT = 30_000  # 30s


def _ensure_browser():
    """懒加载 Playwright 浏览器（单例）。"""
    global _browser, _playwright
    if _browser is not None:
        return _browser
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        logger.warning("playwright 未安装，浏览器爬虫不可用")
        return None
    try:
        _playwright = sync_playwright().start()
        _browser = _playwright.chromium.launch(headless=True)
        logger.info("Playwright Chromium 浏览器已启动")
        return _browser
    except Exception as e:
        logger.warning("Playwright 启动失败: %s", e)
        _playwright = None
        return None


def _shutdown_browser():
    """关闭浏览器（进程退出时调用）。"""
    global _browser, _playwright
    if _browser:
        try:
            _browser.close()
        except Exception:
            pass
    if _playwright:
        try:
            _playwright.stop()
        except Exception:
            pass
    _browser = None
    _playwright = None


def crawl_with_browser(url: str, query: str = "", task_id: str = "default",
                        screenshot_dir: Path | None = None,
                        take_screenshot: bool = True) -> list[dict]:
    """使用浏览器自动化爬取 JS 重站点。

    Args:
        url: 目标 URL
        query: 检索词（用于溯源）
        task_id: 任务 ID
        screenshot_dir: 截图保存目录（None 时不保存文件，仅 base64）
        take_screenshot: 是否截图（True 输出 screenshot，False 仅输出 html）

    Returns:
        raw crawl record 列表（长度 0 或 1）；失败时返回空列表
    """
    browser = _ensure_browser()
    if browser is None:
        return []

    try:
        page = browser.new_page()
        page.set_default_timeout(_DEFAULT_TIMEOUT)
        page.goto(url, wait_until="domcontentloaded")

        # 等待页面渲染（给 JS 执行时间）
        page.wait_for_timeout(2000)

        # 获取渲染后的 HTML
        html = page.content()

        # 清洗 HTML（复用 web_crawler 的清洗逻辑）
        raw_content, _ = _clean_html(html)

        record: dict = {
            "crawl_source": "browser",
            "raw_type": "html",
            "raw_content": raw_content[:50000] if raw_content else "",
            "url": url,
            "query": query,
            "crawled_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "task_id": task_id,
            "schema_hint": {},
        }

        # 截图（供 Qwen-VL 提取图表数据）
        if take_screenshot:
            screenshot_bytes = page.screenshot(full_page=False)
            if screenshot_dir:
                screenshot_dir.mkdir(parents=True, exist_ok=True)
                img_file = screenshot_dir / f"browser_{int(time.time())}.png"
                img_file.write_bytes(screenshot_bytes)
                record["screenshot_path"] = str(img_file)
            # 同时保存 base64（供无文件场景使用）
            record["screenshot_b64"] = base64.b64encode(
                screenshot_bytes).decode("ascii")
            record["raw_type"] = "screenshot"

        page.close()
        logger.info("browser_crawler: 成功爬取 %s（%d 字符，screenshot=%s）",
                    url, len(raw_content), take_screenshot)
        return [record]

    except Exception as e:
        logger.warning("browser_crawler 爬取失败 %s: %s", url, e)
        return []


def _clean_html(html: str) -> tuple[str, str]:
    """清洗 HTML（复用 web_crawler 的逻辑）。"""
    try:
        from bs4 import BeautifulSoup
    except ImportError:
        return html[:50000], "text"

    soup = BeautifulSoup(html, "lxml")
    for tag in soup(["script", "style", "noscript", "iframe"]):
        tag.decompose()

    tables = soup.find_all("table")
    if tables:
        content = "\n".join(str(t) for t in tables[:10])
        text = soup.get_text(separator="\n", strip=True)
        if text:
            content += "\n\n" + text[:5000]
        return content[:50000], "html"

    text = soup.get_text(separator="\n", strip=True)
    return text[:50000], "text"


# JS 重站点列表（需浏览器渲染的数据源）
JS_HEAVY_SOURCES: frozenset = frozenset({
    "cnki", "wanfang", "chembl", "opentargets",
})


def is_js_heavy_source(source: str) -> bool:
    """判断数据源是否为 JS 重站点（需浏览器渲染）。"""
    return source.lower() in JS_HEAVY_SOURCES
