"""数据清洗工具 — 缺失值、重复值、类型检查和格式规范化。

对应 TODO.md Section 8.3：
- 缺失值统计
- 精确重复检测
- 字符串和日期格式规范化
- 字段类型检查
- 异常格式标记
- 清洗规则记录影响行数
- 不静默删除或覆盖原始记录
"""
from __future__ import annotations

import re
from datetime import datetime

from app.domain.processing import CleaningReport, ParsedDataset


def count_missing(dataset: ParsedDataset) -> dict[str, int]:
    """统计每个字段的缺失值数量。

    缺失值定义：None、空字符串、纯空白字符串。
    """
    stats: dict[str, int] = {}
    for field in dataset.field_names:
        count = 0
        for row in dataset.rows:
            val = row.get(field)
            if val is None or (isinstance(val, str) and not val.strip()):
                count += 1
        stats[field] = count
    return stats


def detect_duplicates(dataset: ParsedDataset) -> int:
    """检测精确重复行数（所有字段值完全相同）。

    返回重复行数（不含首次出现的行）。
    """
    seen: set[str] = set()
    dup_count = 0
    for row in dataset.rows:
        # 用字段值的元组作为指纹
        fingerprint = tuple(
            str(row.get(f, "")).strip() for f in dataset.field_names
        )
        key = repr(fingerprint)
        if key in seen:
            dup_count += 1
        else:
            seen.add(key)
    return dup_count


def check_field_types(dataset: ParsedDataset) -> dict[str, int]:
    """检查字段类型一致性。

    返回每个字段中与推断类型不匹配的值数量。
    """
    from app.tools.processing import _infer_type

    issues: dict[str, int] = {}
    for field in dataset.field_names:
        expected_type = dataset.field_types.get(field, "string")
        count = 0
        for row in dataset.rows:
            val = row.get(field)
            if val is None or (isinstance(val, str) and not val.strip()):
                continue  # 缺失值不算类型错误
            actual_type = _infer_type(str(val))
            if actual_type == "null":
                continue
            # int 和 float 兼容
            if expected_type == "float" and actual_type == "int":
                continue
            if expected_type == "int" and actual_type == "float":
                continue
            if actual_type != expected_type:
                count += 1
        issues[field] = count
    return issues


_DATE_PATTERNS = [
    (r"^\d{4}-\d{2}-\d{2}$", "%Y-%m-%d"),
    (r"^\d{4}/\d{2}/\d{2}$", "%Y/%m/%d"),
    (r"^\d{2}-\d{2}-\d{4}$", "%d-%m-%Y"),
    (r"^\d{2}/\d{2}/\d{4}$", "%m/%d/%Y"),
]


def normalize_date(value: str) -> str | None:
    """尝试将日期字符串规范化为 YYYY-MM-DD 格式。

    无法识别时返回 None。
    """
    for pattern, fmt in _DATE_PATTERNS:
        if re.match(pattern, value):
            try:
                dt = datetime.strptime(value, fmt)
                return dt.strftime("%Y-%m-%d")
            except ValueError:
                continue
    return None


def normalize_strings(dataset: ParsedDataset) -> dict[str, int]:
    """规范化字符串字段：strip 首尾空白。

    返回每个字段被修正的行数。
    """
    corrections: dict[str, int] = {}
    for field in dataset.field_names:
        count = 0
        for row in dataset.rows:
            val = row.get(field)
            if isinstance(val, str) and val != val.strip():
                row[field] = val.strip()
                count += 1
        corrections[field] = count
    return corrections


def clean_dataset(dataset: ParsedDataset) -> CleaningReport:
    """执行完整清洗流程，返回清洗报告。

    不静默删除或覆盖原始记录 — 只标记和统计，不删除行。
    """
    report = CleaningReport()

    # 1. 缺失值统计
    report.missing_stats = count_missing(dataset)
    missing_total = sum(report.missing_stats.values())
    if missing_total > 0:
        report.add_rule("missing_value_count", missing_total)

    # 2. 精确重复检测
    report.duplicate_count = detect_duplicates(dataset)
    if report.duplicate_count > 0:
        report.add_rule("duplicate_detection", report.duplicate_count)

    # 3. 字符串规范化
    report.format_corrections = normalize_strings(dataset)
    format_total = sum(report.format_corrections.values())
    if format_total > 0:
        report.add_rule("string_normalization", format_total)

    # 4. 字段类型检查
    report.type_issues = check_field_types(dataset)
    type_issue_total = sum(report.type_issues.values())
    if type_issue_total > 0:
        report.add_rule("type_check", type_issue_total)
        for field, count in report.type_issues.items():
            if count > 0:
                report.anomaly_flags.append(
                    f"字段 '{field}' 有 {count} 个类型不匹配值"
                )

    return report
