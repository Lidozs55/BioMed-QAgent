"""E2E 冒烟测试 — 任务生命周期端点可达性验证。

由 data/run_test.py 改造而来。原脚本对运行中的服务器执行完整 E2E
（创建任务→启动→轮询→检查输出），但启动任务会触发真实 LLM 调用与网络爬取，
不适合在单测环境中运行。本测试简化为端点可达性测试：动态创建任务后验证
各生命周期端点（详情/状态/数据/文件/溯源）返回 200 且结构正确。

研究目标参数化以覆盖不同领域提示。
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


RESEARCH_GOALS = [
    pytest.param(
        "分析健脾散结方对胰腺癌肝转移的影响", "tcm_oncology", id="tcm_oncology"),
    pytest.param("分析TP53在胰腺癌中的作用", "oncology", id="oncology"),
    pytest.param(
        "检索二甲双胍与AMPK通路的相关文献", "pharmacology", id="pharmacology"),
]


@pytest.mark.parametrize("research_goal,domain_hint", RESEARCH_GOALS)
def test_task_lifecycle_endpoints_reachable(client, research_goal, domain_hint):
    """验证任务生命周期端点可达：创建→详情→状态→数据→文件→溯源→列表→删除。

    覆盖原 run_test.py 的核心 E2E 流程（创建任务→轮询状态→检查溯源与输出文件），
    但跳过 /start（需真实 LLM/网络执行），改为直接验证端点可达性与响应结构。
    """
    # 1. 创建任务（对应 run_test.py 第 3-19 行）
    create_resp = client.post(
        "/api/v1/tasks",
        json={
            "research_goal": research_goal,
            "domain_hint": domain_hint,
            "max_sources": 10,
            "enable_analysis": True,
        },
    )
    assert create_resp.status_code == 200, create_resp.text
    task = create_resp.json()
    task_id = task["task_id"]
    assert task["research_goal"] == research_goal

    try:
        # 2. 获取任务详情（对应 run_test.py 轮询阶段）
        detail_resp = client.get(f"/api/v1/tasks/{task_id}")
        assert detail_resp.status_code == 200
        detail_body = detail_resp.json()
        assert detail_body["task_id"] == task_id

        # 3. 校验任务状态字段（原 /status 端点已并入 get_task，验证 stages 与 is_running）
        assert "stages" in detail_body
        assert "is_running" in detail_body

        # 4. 检查溯源（对应 run_test.py 第 48-54 行）
        lineage_resp = client.get(f"/api/v1/tasks/{task_id}/lineage")
        assert lineage_resp.status_code == 200
        lineage = lineage_resp.json()
        assert "nodes" in lineage
        assert "edges" in lineage

        # 5. 检查输出文件（对应 run_test.py 第 56-60 行）
        files_resp = client.get(f"/api/v1/tasks/{task_id}/files")
        assert files_resp.status_code == 200
        assert "files" in files_resp.json()

        # 6. 查询数据记录（复用 verify_api.py 的 data 端点验证）
        data_resp = client.get(f"/api/v1/tasks/{task_id}/data?limit=3")
        assert data_resp.status_code == 200
        data_body = data_resp.json()
        assert data_body["task_id"] == task_id
        assert "total" in data_body
        assert "records" in data_body
    finally:
        # 7. 清理任务
        client.delete(f"/api/v1/tasks/{task_id}")


def test_list_tasks_endpoint(client):
    """验证 GET /api/v1/tasks 列表端点可达。"""
    resp = client.get("/api/v1/tasks")
    assert resp.status_code == 200
    body = resp.json()
    assert "tasks" in body
    assert "total" in body
    assert isinstance(body["tasks"], list)


def test_get_nonexistent_task_returns_404(client):
    """验证不存在任务返回 404。"""
    resp = client.get("/api/v1/tasks/T_nonexistent_xyz")
    assert resp.status_code == 404
