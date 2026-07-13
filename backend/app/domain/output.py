"""输出领域模型 — 结构化数据记录、来源追踪和处理记录。

对应 TODO.md Section 11：
- 主数据 CSV（每条记录关联原始数据源和 raw 文件）
- 字段说明
- 来源清单
- 下载记录
- 处理记录（Tool、参数、影响记录数）
- warnings 和未解决问题
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime


@dataclass
class SourceRecord:
    """数据来源记录 — 描述一个原始数据文件的下载信息。

    对应 ARCHITECTURE.md §6.1 下载输出约定。
    """

    source: str  # 数据源标识（geo, pubmed, pdb...）
    accession: str  # 访问号（GSE123, PMID123...）
    source_url: str
    local_files: list[str]  # raw 目录下的本地文件路径
    checksum: str | None = None
    mime_type: str | None = None
    format_hint: str | None = None  # 帮助 Agent 选择解析 Skill
    retrieved_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    warnings: list[str] = field(default_factory=list)


@dataclass
class DataRecord:
    """单条数据记录 — 每条至少关联原始数据源和 raw 文件。

    论文提取的数据还应记录 DOI/PMID 和原始位置。
    """

    source: str  # 数据源标识
    accession: str  # 访问号
    source_url: str
    raw_file: str  # raw 目录下的本地文件路径
    # 论文数据特有字段
    doi: str | None = None
    pmid: str | None = None
    pmcid: str | None = None
    page: str | None = None  # 论文页码
    table_number: str | None = None  # 表格号
    supplementary_file: str | None = None  # 补充材料文件名
    # 数据内容
    fields: dict[str, str | int | float | None] = field(default_factory=dict)


@dataclass
class ProcessingStep:
    """处理记录 — 记录每个转换步骤。

    对应 Section 11：每个转换记录 Tool、参数和影响记录数。
    """

    step: int  # 步骤序号
    tool: str  # Tool 名称
    params: dict  # 调用参数
    affected_count: int  # 影响记录数
    description: str = ""  # 操作描述
    timestamp: datetime = field(default_factory=lambda: datetime.now(UTC))


@dataclass
class FieldDescription:
    """字段说明 — 描述输出 CSV 中的每个字段。"""

    name: str  # 字段名
    dtype: str  # 数据类型（string/int/float/date）
    description: str  # 字段含义
    unit: str | None = None  # 单位
    source: str | None = None  # 来源字段名（字段对齐前的原名）
    example: str | None = None  # 示例值


@dataclass
class WarningEntry:
    """警告条目 — 异常和未解决问题。"""

    severity: str  # info / warning / error
    message: str
    source: str | None = None  # 数据源或 Tool 名
    context: str | None = None  # 上下文信息


@dataclass
class OutputBundle:
    """输出包 — 聚合所有 MVP 输出产物。

    对应 Section 11 的全部输出项：
    - records → 主数据 CSV
    - field_descriptions → 字段说明 CSV
    - sources → 来源清单 CSV
    - processing_steps → 处理记录 CSV
    - warnings → warnings CSV
    """

    records: list[DataRecord] = field(default_factory=list)
    sources: list[SourceRecord] = field(default_factory=list)
    processing_steps: list[ProcessingStep] = field(default_factory=list)
    field_descriptions: list[FieldDescription] = field(default_factory=list)
    warnings: list[WarningEntry] = field(default_factory=list)

    def add_warning(
        self, severity: str, message: str,
        source: str | None = None, context: str | None = None,
    ) -> None:
        """添加一条警告。"""
        self.warnings.append(WarningEntry(
            severity=severity, message=message, source=source, context=context,
        ))

    def add_processing_step(
        self, tool: str, params: dict, affected_count: int, description: str = "",
    ) -> None:
        """添加一条处理记录，自动递增步骤序号。"""
        step_num = len(self.processing_steps) + 1
        self.processing_steps.append(ProcessingStep(
            step=step_num, tool=tool, params=params,
            affected_count=affected_count, description=description,
        ))
