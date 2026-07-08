"""API 端点测试 — tasks/data/files/lineage 端点验证。

由 data/verify_api.py 改造而来。原脚本使用硬编码任务 ID（T65d3b6d1）验证端点，
本测试改为动态创建任务，去掉硬编码 ID，验证各端点可达性与响应结构。
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.skills import register_all_skills


@pytest.fixture
def client():
    """创建 TestClient，复用 test_skills_endpoints 的初始化模式。"""
    from app.main import app
    register_all_skills()
    return TestClient(app)


@pytest.fixture
def created_task_id(client):
    """动态创建任务，返回 task_id，测试结束后清理。

    替代原 verify_api.py 中硬编码的 T65d3b6d1。
    """
    resp = client.post(
        "/api/v1/tasks",
        json={
            "research_goal": "验证 API 端点可达性",
            "domain_hint": "oncology",
            "max_sources": 5,
            "enable_analysis": True,
        },
    )
    assert resp.status_code == 200, resp.text
    task_id = resp.json()["task_id"]
    yield task_id
    client.delete(f"/api/v1/tasks/{task_id}")


# ── GET /api/v1/tasks ────────────────────────────────────────────


def test_list_tasks(client):
    """GET /api/v1/tasks 返回任务列表（对应 verify_api.py 第 3-9 行）。"""
    resp = client.get("/api/v1/tasks")
    assert resp.status_code == 200
    data = resp.json()
    assert "total" in data
    assert "tasks" in data
    assert isinstance(data["tasks"], list)
    for t in data["tasks"]:
        assert "task_id" in t
        assert "status" in t


# ── GET /api/v1/tasks/{id}/data ─────────────────────────────────


def test_task_data_endpoint(client, created_task_id):
    """GET /api/v1/tasks/{id}/data 返回数据记录（对应 verify_api.py 第 11-18 行）。"""
    resp = client.get(f"/api/v1/tasks/{created_task_id}/data?limit=3")
    assert resp.status_code == 200
    data = resp.json()
    assert data["task_id"] == created_task_id
    assert "total" in data
    assert "sources" in data
    assert isinstance(data["records"], list)


# ── GET /api/v1/tasks/{id}/files ────────────────────────────────


def test_task_files_endpoint(client, created_task_id):
    """GET /api/v1/tasks/{id}/files 返回输出文件列表（对应 verify_api.py 第 20-25 行）。"""
    resp = client.get(f"/api/v1/tasks/{created_task_id}/files")
    assert resp.status_code == 200
    data = resp.json()
    assert data["task_id"] == created_task_id
    assert "files" in data
    assert isinstance(data["files"], list)


# ── GET /api/v1/tasks/{id}/lineage ──────────────────────────────


def test_task_lineage_endpoint(client, created_task_id):
    """GET /api/v1/tasks/{id}/lineage 返回溯源图（对应 verify_api.py 第 27-31 行）。"""
    resp = client.get(f"/api/v1/tasks/{created_task_id}/lineage")
    assert resp.status_code == 200
    data = resp.json()
    assert "nodes" in data
    assert "edges" in data


# ── 错误处理 ────────────────────────────────────────────────────


def test_data_endpoint_404_for_nonexistent_task(client):
    """不存在任务的数据端点返回 404。"""
    resp = client.get("/api/v1/tasks/T_nonexistent_xyz/data")
    assert resp.status_code == 404


def test_files_endpoint_for_nonexistent_task_returns_empty(client):
    """不存在任务的文件端点返回 200 与空列表（按 main.py 逻辑目录不存在返回空 files）。"""
    resp = client.get("/api/v1/tasks/T_nonexistent_xyz/files")
    assert resp.status_code == 200
    assert resp.json()["files"] == []


def test_lineage_endpoint_404_for_nonexistent_task(client):
    """不存在任务的溯源端点返回 404。"""
    resp = client.get("/api/v1/tasks/T_nonexistent_xyz/lineage")
    assert resp.status_code == 404
