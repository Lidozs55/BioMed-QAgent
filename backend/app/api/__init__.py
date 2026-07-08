"""API 路由聚合 — 将所有路由器注册到统一前缀下。"""
from __future__ import annotations

from fastapi import APIRouter

from app.api.routes import feedback, lineage, skills, system, tasks, ws, data

api_router = APIRouter(prefix="/api/v1")
api_router.include_router(tasks.router)
api_router.include_router(data.router)
api_router.include_router(lineage.router)
api_router.include_router(feedback.router)
api_router.include_router(ws.router)
api_router.include_router(skills.router)
api_router.include_router(system.router)
