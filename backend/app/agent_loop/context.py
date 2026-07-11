"""RunContext — Agent loop 运行期间的共享状态。

所有工具可通过 context 访问/修改共享状态（记录、查询日志、产出物路径）。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from app.config import settings


@dataclass
class RunContext:
    """任务级共享状态，通过 Runner.run(..., context=ctx) 注入。"""

    # 任务 ID（用于产物目录隔离）
    task_id: str = "default"
    # 已采集的记录（DataRecord 列表，具体格式后续定义）
    records: list[dict] = field(default_factory=list)
    # 查询日志（记录每次检索的 query/source/status/records_count）
    query_log: list[dict] = field(default_factory=list)
    # 产出物文件路径（报告、图表等）
    artifacts: list[str] = field(default_factory=list)

    @property
    def output_dir(self) -> Path:
        d = Path(settings.output_dir) / self.task_id
        d.mkdir(parents=True, exist_ok=True)
        return d
