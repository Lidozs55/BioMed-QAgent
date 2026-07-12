"""Processing 领域模型 — ParsedDataset 和清洗结果。

对应 TODO.md Section 8.2：
- 数据集 ID
- 原始文件路径
- 表/Sheet/区块名称
- 字段名和推断类型
- 数据行
- 来源定位
- 解析器名称和版本
- warnings
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone


@dataclass
class ParsedDataset:
    """解析结果 — 从一个原始文件中解析出的结构化数据集。

    解析结果写入 task/parsed/，不覆盖 raw 文件。
    """

    dataset_id: str  # 数据集 ID（如 "GSE12345_matrix" 或文件名）
    source_file: str  # 原始文件路径（raw 目录下）
    table_name: str  # 表/Sheet/区块名称
    field_names: list[str]  # 字段名
    field_types: dict[str, str]  # 字段名 → 推断类型 (string/int/float/date/bool)
    rows: list[dict]  # 数据行（每行为字段名到值的映射）
    # 来源定位
    source_locator: str = ""  # 如 "sheet1!A1:D100" 或 "page 5, table 2"
    # 解析器元信息
    parser_name: str = ""
    parser_version: str = "0.1.0"
    parsed_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    warnings: list[str] = field(default_factory=list)

    @property
    def row_count(self) -> int:
        return len(self.rows)

    @property
    def col_count(self) -> int:
        return len(self.field_names)


@dataclass
class CleaningReport:
    """清洗报告 — 记录清洗规则和影响行数。

    对应 Section 8.3：清洗规则记录影响行数，不静默删除或覆盖原始记录。
    """

    missing_stats: dict[str, int] = field(default_factory=dict)  # 字段名 → 缺失数
    duplicate_count: int = 0  # 精确重复行数
    type_issues: dict[str, int] = field(default_factory=dict)  # 字段名 → 类型不匹配数
    format_corrections: dict[str, int] = field(default_factory=dict)  # 字段名 → 格式修正数
    anomaly_flags: list[str] = field(default_factory=list)  # 异常标记列表
    rules_applied: list[str] = field(default_factory=list)  # 应用的清洗规则
    total_affected: int = 0  # 总影响行数

    def add_rule(self, rule: str, affected: int) -> None:
        """记录一条清洗规则及其影响行数。"""
        self.rules_applied.append(rule)
        self.total_affected += affected
