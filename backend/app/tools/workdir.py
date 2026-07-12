"""任务工作目录工具 — 每个任务创建独立目录结构。

对应 TODO.md Section 4.3：
    data/tasks/<task_id>/
    ├── raw/          # 不修改的下载文件
    ├── parsed/       # 解析结果
    ├── normalized/   # 清洗、对齐后的数据
    ├── artifacts/    # CSV、来源清单、说明和可视化
    └── logs/         # Tool 调用、下载和 Skill 演化记录

raw/ 中的下载文件保持不变；解析、清洗和导出产物不得覆盖原始文件。
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from app.config import settings

# 工作目录子目录名
_SUBDIRS = ("raw", "parsed", "normalized", "artifacts", "logs")


@dataclass(frozen=True)
class TaskWorkDir:
    """任务工作目录路径集合。"""

    root: Path
    raw: Path
    parsed: Path
    normalized: Path
    artifacts: Path
    logs: Path

    def raw_file(self, filename: str) -> Path:
        """返回 raw 目录下的文件路径。"""
        return self.raw / filename

    def artifact_file(self, filename: str) -> Path:
        """返回 artifacts 目录下的文件路径。"""
        return self.artifacts / filename


def create_task_workdir(task_id: str, base_dir: str | None = None) -> TaskWorkDir:
    """为任务创建独立工作目录，包含 raw/parsed/normalized/artifacts/logs 子目录。

    Args:
        task_id: 任务 ID（必须已通过 TaskRecord 校验）。
        base_dir: 基目录。None 时使用 settings.output_dir/tasks。
    """
    base = Path(base_dir) if base_dir else Path(settings.output_dir) / "tasks"
    root = base / task_id

    paths = {}
    for sub in _SUBDIRS:
        d = root / sub
        d.mkdir(parents=True, exist_ok=True)
        paths[sub] = d

    return TaskWorkDir(
        root=root,
        raw=paths["raw"],
        parsed=paths["parsed"],
        normalized=paths["normalized"],
        artifacts=paths["artifacts"],
        logs=paths["logs"],
    )
