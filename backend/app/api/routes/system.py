"""系统级端点：健康检查、工具列表。"""
from __future__ import annotations

from fastapi import APIRouter

from app.config import is_api_key_configured
from app.tools.registry import get_registry

router = APIRouter(tags=["system"])


@router.get("/health", summary="健康检查")
async def health():
    """健康检查。"""
    return {
        "status": "ok",
        "dashscope_configured": is_api_key_configured(),
        "python_path_ok": True,
    }


@router.get("/tools", summary="列出可用工具")
async def list_tools():
    """列出所有可用的脚本工具。"""
    registry = get_registry()
    return registry.list_tools()
