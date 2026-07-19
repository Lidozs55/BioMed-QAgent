"""本地缓存存储层 — 可查询的逻辑数据缓存。

与 ``content_cache.py``（字节级去重缓存）不同，本模块存储**已清洗的逻辑数据**，
供后续 Agent 任务通过 ``local_cache`` acquisition skill 查询复用。

目录结构（D1 决策）::

    data/cache/
    ├── records/
    │   └── <source_namespace>/          # 如 "user_import"、"pubmed"
    │       └── <dataset_id>/            # 如 "user_import_20260719_abc123"
    │           ├── main_data.csv        # 22 列长格式（与 Pipeline 产物同 schema）
    │           └── manifest.json        # 数据集元数据（来源/行数/创建时间/描述）
    └── index.sqlite3                    # 全局索引（搜索/枚举）

设计要点：
  - 复用 ``main_data.csv`` 的 22 列长格式，避免引入第二套 schema（D1）
  - 原子写入：先写 ``.tmp`` 再 ``os.replace``，失败不留半成品（D3）
  - manifest 更新与 main_data 写入视为一个事务，任一失败回滚
  - index.sqlite3 仅作搜索索引，权威数据在 records/ 文件中
"""

from __future__ import annotations

import contextlib
import csv
import json
import logging
import os
import re
import sqlite3
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

#: main_data.csv 的 22 列固定 schema（与 Pipeline 产物一致）。
CACHE_MAIN_DATA_COLUMNS: tuple[str, ...] = (
    "record_id",
    "dataset_id",
    "source_id",
    "asset_id",
    "gene_id_raw",
    "gene_id",
    "gene_id_namespace",
    "gene_id_version",
    "sample_id",
    "source_sample_alias",
    "measurement_type",
    "value_semantics",
    "value_scale",
    "is_normalized",
    "is_integer_expected",
    "expression_value",
    "expression_unit",
    "source_logical_file",
    "source_line_number",
    "source_column_index",
    "source_column_name",
    "source_raw_value",
)

#: source_namespace 必须匹配此正则，防止路径穿越。
_NAMESPACE_RE = re.compile(r"^[a-z][a-z0-9_]*$")
_DATASET_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]*$")

DEFAULT_CACHE_DIR = Path("data/cache")


@dataclass(frozen=True)
class CacheDatasetManifest:
    """单个缓存数据集的元数据，与 main_data.csv 同目录存放。"""

    dataset_id: str
    source_namespace: str
    topic: str
    description: str
    row_count: int
    column_count: int
    created_at: str  # ISO 8601 UTC
    created_by_task_id: str
    source_files: list[str]  # 原始上传文件名列表
    extra: dict[str, Any]  # 任意附加元数据


class CacheStore:
    """本地缓存的存储、查询、索引管理。

    所有写入操作（``commit_dataset``）都是原子的：先写 ``.tmp`` 文件，
    再 ``os.replace`` 重命名为最终名。若任一步失败，已写入的 ``.tmp``
    文件会被清理，不会污染缓存目录。
    """

    def __init__(self, cache_dir: Path | str | None = None) -> None:
        self._root = Path(cache_dir) if cache_dir else DEFAULT_CACHE_DIR
        self._records = self._root / "records"
        self._index_path = self._root / "index.sqlite3"
        self._records.mkdir(parents=True, exist_ok=True)
        self._init_index()

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    @property
    def root(self) -> Path:
        return self._root

    def commit_dataset(
        self,
        *,
        dataset_id: str,
        source_namespace: str,
        topic: str,
        description: str,
        csv_rows: list[dict[str, str]],
        created_by_task_id: str,
        source_files: list[str] | None = None,
        extra: dict[str, Any] | None = None,
    ) -> CacheDatasetManifest:
        """原子地写入一个数据集到缓存并更新索引。

        Args:
            dataset_id: 数据集 ID（``^[a-z0-9][a-z0-9_-]*$``）。
            source_namespace: 来源命名空间（如 ``user_import``）。
            topic: 主题/标题（供搜索）。
            description: 人类可读描述。
            csv_rows: 22 列长格式数据行，每行是 dict（key 必须是
                ``CACHE_MAIN_DATA_COLUMNS`` 的子集，缺失列填空字符串）。
            created_by_task_id: 创建此数据集的任务 ID（provenance）。
            source_files: 原始上传文件名列表。
            extra: 任意附加元数据。

        Returns:
            写入的 ``CacheDatasetManifest``。

        Raises:
            ValueError: namespace/dataset_id 格式非法，或 csv_rows 列名不在
                22 列 schema 中。
        """
        self._validate_namespace(source_namespace)
        self._validate_dataset_id(dataset_id)

        dataset_dir = self._records / source_namespace / dataset_id
        dataset_dir.mkdir(parents=True, exist_ok=True)

        main_data_path = dataset_dir / "main_data.csv"
        manifest_path = dataset_dir / "manifest.json"

        # 1. 写 main_data.csv 到 .tmp
        main_data_tmp = main_data_path.with_suffix(".csv.tmp")
        try:
            self._write_main_data(main_data_tmp, csv_rows)
            # 2. 写 manifest.json 到 .tmp
            manifest = CacheDatasetManifest(
                dataset_id=dataset_id,
                source_namespace=source_namespace,
                topic=topic.strip(),
                description=description.strip(),
                row_count=len(csv_rows),
                column_count=len(CACHE_MAIN_DATA_COLUMNS),
                created_at=datetime.now(UTC).isoformat(),
                created_by_task_id=created_by_task_id,
                source_files=list(source_files or []),
                extra=dict(extra or {}),
            )
            manifest_tmp = manifest_path.with_suffix(".json.tmp")
            manifest_tmp.write_text(
                json.dumps(manifest.__dict__, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
            # 3. 原子重命名（manifest 先，main_data 后；索引最后更新）
            os.replace(manifest_tmp, manifest_path)
            os.replace(main_data_tmp, main_data_path)
            # 4. 更新索引
            self._upsert_index(manifest)
        except BaseException:
            # 清理 .tmp 残留
            for tmp in (main_data_tmp, manifest_path.with_suffix(".json.tmp")):
                if tmp.exists():
                    with contextlib.suppress(OSError):
                        tmp.unlink()
            raise

        logger.info(
            "CacheStore.commit_dataset: namespace=%s dataset=%s rows=%d",
            source_namespace,
            dataset_id,
            len(csv_rows),
        )
        return manifest

    def list_datasets(
        self,
        *,
        source_namespace: str | None = None,
        limit: int = 50,
    ) -> list[CacheDatasetManifest]:
        """列出缓存中的数据集（可选按 namespace 过滤）。"""
        conn = self._open_index()
        try:
            if source_namespace is not None:
                self._validate_namespace(source_namespace)
                cur = conn.execute(
                    "SELECT manifest_path FROM datasets "
                    "WHERE source_namespace = ? "
                    "ORDER BY created_at DESC LIMIT ?",
                    (source_namespace, limit),
                )
            else:
                cur = conn.execute(
                    "SELECT manifest_path FROM datasets "
                    "ORDER BY created_at DESC LIMIT ?",
                    (limit,),
                )
            return [self._load_manifest(Path(row[0])) for row in cur.fetchall()]
        finally:
            conn.close()

    def search_datasets(
        self,
        query: str,
        *,
        limit: int = 20,
    ) -> list[CacheDatasetManifest]:
        """按主题/描述关键词搜索数据集。"""
        conn = self._open_index()
        try:
            # 简单 LIKE 搜索；FTS 留作后续优化
            pattern = f"%{query.strip()}%"
            cur = conn.execute(
                "SELECT manifest_path FROM datasets "
                "WHERE topic LIKE ? OR description LIKE ? "
                "ORDER BY created_at DESC LIMIT ?",
                (pattern, pattern, limit),
            )
            return [self._load_manifest(Path(row[0])) for row in cur.fetchall()]
        finally:
            conn.close()

    def get_dataset(
        self,
        source_namespace: str,
        dataset_id: str,
    ) -> tuple[CacheDatasetManifest, list[dict[str, str]]] | None:
        """读取一个缓存数据集的 manifest 和 main_data.csv 行。"""
        self._validate_namespace(source_namespace)
        self._validate_dataset_id(dataset_id)
        dataset_dir = self._records / source_namespace / dataset_id
        main_data_path = dataset_dir / "main_data.csv"
        manifest_path = dataset_dir / "manifest.json"
        if not main_data_path.is_file() or not manifest_path.is_file():
            return None
        manifest = self._load_manifest(manifest_path)
        with main_data_path.open("r", encoding="utf-8-sig", newline="") as f:
            reader = csv.DictReader(f)
            rows = list(reader)
        return manifest, rows

    def describe_dataset(
        self,
        source_namespace: str,
        dataset_id: str,
    ) -> CacheDatasetManifest | None:
        """仅读取 manifest（不读 main_data.csv）。"""
        self._validate_namespace(source_namespace)
        self._validate_dataset_id(dataset_id)
        manifest_path = (
            self._records / source_namespace / dataset_id / "manifest.json"
        )
        if not manifest_path.is_file():
            return None
        return self._load_manifest(manifest_path)

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _validate_namespace(namespace: str) -> None:
        if not _NAMESPACE_RE.fullmatch(namespace):
            raise ValueError(
                f"Invalid source_namespace {namespace!r}. Must match "
                f"^[a-z][a-z0-9_]*$."
            )

    @staticmethod
    def _validate_dataset_id(dataset_id: str) -> None:
        if not _DATASET_ID_RE.fullmatch(dataset_id):
            raise ValueError(
                f"Invalid dataset_id {dataset_id!r}. Must match "
                f"^[a-z0-9][a-z0-9_-]*$."
            )

    @staticmethod
    def _write_main_data(path: Path, rows: list[dict[str, str]]) -> None:
        """将 rows 写为 22 列 CSV。缺失列填空字符串。"""
        if not rows:
            raise ValueError("csv_rows must not be empty")
        # 校验所有 key 都在 schema 中
        valid_cols = set(CACHE_MAIN_DATA_COLUMNS)
        for i, row in enumerate(rows):
            extra_keys = set(row.keys()) - valid_cols
            if extra_keys:
                raise ValueError(
                    f"csv_rows[{i}] contains columns not in schema: "
                    f"{sorted(extra_keys)}"
                )
        with path.open("w", encoding="utf-8-sig", newline="") as f:
            writer = csv.DictWriter(
                f,
                fieldnames=list(CACHE_MAIN_DATA_COLUMNS),
                extrasaction="raise",
            )
            writer.writeheader()
            for row in rows:
                # 用 dict.get 填充缺失列为空字符串
                writer.writerow({col: row.get(col, "") for col in CACHE_MAIN_DATA_COLUMNS})

    def _load_manifest(self, path: Path) -> CacheDatasetManifest:
        data = json.loads(path.read_text(encoding="utf-8"))
        return CacheDatasetManifest(**data)

    def _init_index(self) -> None:
        conn = self._open_index()
        try:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS datasets (
                    dataset_id TEXT NOT NULL,
                    source_namespace TEXT NOT NULL,
                    topic TEXT NOT NULL,
                    description TEXT NOT NULL,
                    row_count INTEGER NOT NULL,
                    created_at TEXT NOT NULL,
                    created_by_task_id TEXT NOT NULL,
                    manifest_path TEXT NOT NULL,
                    PRIMARY KEY (source_namespace, dataset_id)
                )
                """,
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_datasets_namespace "
                "ON datasets(source_namespace)"
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_datasets_topic "
                "ON datasets(topic)"
            )
            conn.commit()
        finally:
            conn.close()

    def _open_index(self) -> sqlite3.Connection:
        return sqlite3.connect(self._index_path)

    def _upsert_index(self, manifest: CacheDatasetManifest) -> None:
        manifest_path = (
            self._records
            / manifest.source_namespace
            / manifest.dataset_id
            / "manifest.json"
        )
        conn = self._open_index()
        try:
            conn.execute(
                """
                INSERT INTO datasets
                    (dataset_id, source_namespace, topic, description,
                     row_count, created_at, created_by_task_id, manifest_path)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(source_namespace, dataset_id) DO UPDATE SET
                    topic = excluded.topic,
                    description = excluded.description,
                    row_count = excluded.row_count,
                    created_at = excluded.created_at,
                    created_by_task_id = excluded.created_by_task_id,
                    manifest_path = excluded.manifest_path
                """,
                (
                    manifest.dataset_id,
                    manifest.source_namespace,
                    manifest.topic,
                    manifest.description,
                    manifest.row_count,
                    manifest.created_at,
                    manifest.created_by_task_id,
                    str(manifest_path),
                ),
            )
            conn.commit()
        finally:
            conn.close()


# ---------------------------------------------------------------------------
# 模块级单例 — 由 lifespan 在应用启动时初始化
# ---------------------------------------------------------------------------

_global_store: CacheStore | None = None


def get_cache_store() -> CacheStore:
    """返回全局 CacheStore 实例（由 lifespan 初始化）。"""
    if _global_store is None:
        raise RuntimeError(
            "CacheStore is not initialized; "
            "call init_cache_store() during application lifespan"
        )
    return _global_store


def init_cache_store(cache_dir: Path | str | None = None) -> CacheStore:
    """初始化全局 CacheStore 单例。"""
    global _global_store
    _global_store = CacheStore(cache_dir=cache_dir)
    return _global_store
