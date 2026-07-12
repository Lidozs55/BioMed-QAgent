"""FastAPI 入口 — 最小化路由，仅 WebSocket + 健康检查。"""
from __future__ import annotations

import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import router as routes_router
from app.api.ws import router as ws_router

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(name)s] %(levelname)s: %(message)s")

app = FastAPI(title="BioMed QAgent v1", version="1.0.0")

# CORS — 允许前端 Vite dev server
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 路由
app.include_router(routes_router)
app.include_router(ws_router)


@app.get("/api/v1/health")
async def health() -> dict:
    return {"status": "ok", "version": "1.0.0", "arch": "agent_loop"}
