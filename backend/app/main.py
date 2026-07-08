"""FastAPI 应用入口。

挂载所有 API 路由，配置 CORS、异常处理、生命周期。
强制使用阿里云百炼 DashScope 平台。
"""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.api import api_router
from app.config import (
    CORS_ORIGINS,
    DASHSCOPE_API_KEY,
    HOST,
    PORT,
    is_api_key_configured,
)
from app.skills import register_all_skills
from app.tools.registry import get_registry

# 日志配置
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用生命周期：启动时初始化资源，关闭时清理。"""
    # 预热工具注册表
    registry = get_registry()
    tools = registry.list_tools()
    total = sum(len(v) for v in tools.values())
    logger.info("已注册 %d 个工具", total)

    # 注册所有技能到 SkillRegistry
    n_skills = register_all_skills()
    logger.info("已注册 %d 个技能", n_skills)

    if is_api_key_configured():
        logger.info("DashScope API Key 已配置（%s...）", DASHSCOPE_API_KEY[:8])
    else:
        logger.warning("DASHSCOPE_API_KEY 未设置！LLM 功能将不可用")

    logger.info("BioMed QAgent 后端启动完成")
    yield
    logger.info("BioMed QAgent 后端关闭")


app = FastAPI(
    title="BioMed QAgent API",
    description=(
        "面向生物医学研究的 AI 多智能体系统。\n\n"
        "输入自然语言研究目标（如「分析健脾散结方对胰腺癌肝转移的影响」），"
        "系统自动完成 数据查找 → 解析 → 清洗 → 分析 → 审查 → 报告 全流程。\n\n"
        "**强制使用阿里云百炼 DashScope 平台**（qwen-plus/qwen-max/qwen-vl-max/qwen-long）。\n\n"
        "**不生成 PPT/DOC**，结果通过 HTML 报告或前端页面呈现。"
    ),
    version="1.0.0",
    lifespan=lifespan,
)

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 挂载 API 路由
app.include_router(api_router)


# ===== 基础端点 =====
@app.get("/", tags=["root"])
async def root():
    """根路径 — 返回 API 概览。"""
    return {
        "name": "BioMed QAgent API",
        "version": "1.0.0",
        "docs": "/docs",
        "redoc": "/redoc",
        "endpoints": {
            "create_task": "POST /api/v1/tasks",
            "list_tasks": "GET /api/v1/tasks",
            "get_task": "GET /api/v1/tasks/{task_id}",
            "start_task": "POST /api/v1/tasks/{task_id}/start",
            "task_data": "GET /api/v1/tasks/{task_id}/data",
            "export_csv": "GET /api/v1/tasks/{task_id}/export/csv",
            "export_json": "GET /api/v1/tasks/{task_id}/export/json",
            "task_report": "GET /api/v1/tasks/{task_id}/report",
            "lineage": "GET /api/v1/tasks/{task_id}/lineage",
            "websocket": "WS /api/v1/ws/tasks/{task_id}",
            "tools": "GET /api/v1/tools",
            "health": "GET /api/v1/health",
        },
    }


# ===== 全局异常处理 =====
@app.exception_handler(Exception)
async def global_exception_handler(request, exc):
    logger.exception("未处理异常: %s %s -> %s",
                     request.method, request.url.path, exc)
    return JSONResponse(
        status_code=500,
        content={"detail": str(exc), "type": type(exc).__name__},
    )


def main():
    """直接运行入口（python -m app.main）。"""
    import uvicorn
    uvicorn.run(
        "app.main:app",
        host=HOST,
        port=PORT,
        reload=False,
        log_level="info",
    )


if __name__ == "__main__":
    main()
