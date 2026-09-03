"""GUI orchestration: server first, then the desktop window (browser fallback).

Failure policy, per the packaging requirement: the pywebview window is the
default way the UI opens; if the desktop window cannot come up at all (missing
WebView2 runtime, .NET problems, …) the launcher automatically opens the
default browser instead and keeps the service running until the user confirms
the fallback dialog.
"""

from __future__ import annotations

import logging
import os
import sys
import time
import webbrowser
from collections.abc import Callable
from pathlib import Path

from . import config
from .server import DEFAULT_STARTUP_TIMEOUT, ManagedServer, build_child_env, server_command

logger = logging.getLogger(__name__)

WINDOW_WIDTH = 1440
WINDOW_HEIGHT = 900
MIN_WINDOW_SIZE = (1024, 640)
FALSEY_STRINGS = {"", "0", "false"}


def truthy(value: str | None) -> bool:
    return value is not None and value.strip().lower() not in FALSEY_STRINGS


def fallback_dialog_text(url: str) -> str:
    return (
        "桌面窗口启动失败，已自动改用系统浏览器打开：\n"
        f"{url}\n\n"
        "服务正在后台运行；点击「确定」将停止服务并退出。"
    )


def startup_failure_text(log_path: Path) -> str:
    return (
        "BioMed-QAgent 服务启动失败。\n\n"
        f"详细日志：{log_path}\n"
        "常见原因：端口被占用、安全软件拦截内嵌运行时、解压不完整。"
    )


def already_running_failure_text(expected_url: str) -> str:
    return (
        "检测到已有 BioMed-QAgent 实例，但健康检查未通过。\n"
        f"预期地址：{expected_url}\n"
        "请先处理已有实例（或查看其日志）后重试。"
    )


def show_info_dialog(text: str) -> None:
    _message_box(text, 0x40)  # MB_ICONINFORMATION


def show_error_dialog(text: str) -> None:
    _message_box(text, 0x10)  # MB_ICONERROR


def _message_box(text: str, flags: int) -> None:
    if os.name != "nt":
        logger.info("dialog suppressed on this platform: %s", text)
        return
    import ctypes

    ctypes.windll.user32.MessageBoxW(None, text, config.WINDOW_TITLE, flags)


def open_user_interface(
    url: str,
    force_browser: bool | None = None,
    info_dialog: Callable[[str], None] = show_info_dialog,
) -> str:
    """Open the desktop window (default), falling back to the default browser.

    Returns the mode used: ``"webview"`` or ``"browser"``.
    """
    if force_browser is None:
        force_browser = truthy(os.environ.get(config.FORCE_BROWSER_ENV))
    if not force_browser:
        try:
            _run_webview(url)
            return "webview"
        except Exception:
            logger.exception("desktop window failed; falling back to browser")
    webbrowser.open(url)
    # Blocks until OK: the only visible stop affordance when there is no window.
    info_dialog(fallback_dialog_text(url))
    return "browser"


def _run_webview(url: str) -> None:
    # Imported lazily: unit tests (and the browser fallback) need no pywebview.
    import webview

    # Dataset artifacts must stay downloadable from the UI, and UI preferences
    # in localStorage must survive restarts — both default off in pywebview.
    webview.settings["ALLOW_DOWNLOADS"] = True
    window = webview.create_window(
        config.WINDOW_TITLE,
        url,
        width=WINDOW_WIDTH,
        height=WINDOW_HEIGHT,
        min_size=MIN_WINDOW_SIZE,
    )
    _attach_window_icon(window)
    # Blocks until the user closes the window.
    webview.start(private_mode=False)


def _attach_window_icon(window: object) -> None:
    """Best-effort taskbar/window icon; the exe icon itself is set at build time."""
    icon = config.resource_path(config.ICON_RESOURCE_NAME)
    if icon is None:
        return

    def apply() -> None:
        try:
            import clr  # pythonnet ships with pywebview on Windows

            clr.AddReference("System.Drawing")
            from System.Drawing import Icon

            native = getattr(window, "native", None)
            if native is not None:
                native.Icon = Icon(str(icon))
        except Exception:
            logger.debug("window icon not applied", exc_info=True)

    for event_name in ("loaded", "shown"):
        events = getattr(getattr(window, "events", None), event_name, None)
        if events is not None:
            events += apply


def run(bundle: Path | None = None, startup_timeout: float = DEFAULT_STARTUP_TIMEOUT) -> int:
    """Launcher entrypoint; returns the process exit code."""
    root = (bundle or config.bundle_root()).resolve()
    config.setup_logging(root / config.LOG_FILE_NAME)
    logger.info(
        "launcher start (frozen=%s, bundle=%s, python=%s)",
        config.is_frozen(),
        root,
        sys.version.split()[0],
    )

    env_file = config.load_env_file(root)
    host = config.resolve_host(os.environ, env_file)
    port = config.resolve_port(os.environ, env_file)
    expected_url = f"http://{host}:{port}"
    server = ManagedServer(root, server_command(root), build_child_env(root, env_file))
    try:
        server.start()
        base_url = server.wait_ready(expected_url, time.monotonic() + startup_timeout)
        if base_url is None:
            if server.already_running:
                show_error_dialog(already_running_failure_text(expected_url))
            else:
                show_error_dialog(startup_failure_text(root / config.LOG_FILE_NAME))
            return 1
        logger.info("opening UI at %s", base_url)
        open_user_interface(base_url)
        return 0
    except Exception:
        logger.exception("launcher crashed")
        show_error_dialog(startup_failure_text(root / config.LOG_FILE_NAME))
        return 1
    finally:
        # No-op when the child already exited (including the "already running"
        # path, where the instance serving the UI is not ours to stop).
        server.stop()
