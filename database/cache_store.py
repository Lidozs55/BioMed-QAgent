"""本地缓存存储层 — 可查询的逻辑数据缓存（schema-neutral）。

Phase 8: 从 ``backend/app/tools/cache_store.py`` 迁入并移除旧 Pipeline
22 列硬编码 schema。缓存记录不再依赖全局列常量；每个数据集由自己的
manifest 描述 schema（``columns`` 字段），物理格式仍是 CSV + manifest：

    data/cache/
    ├── records/
    │   └── <source_namespace>/          # 如 "user_import"、"pubmed"
    │       └── <dataset_id>/            # 如 "user_import_20260719_abc123"
    │           ├── main_data.csv        # 记录自身的列 schema（表头）
    │           └── manifest.json        # 数据集元数据（来源/行数/schema/创建时间）
    └── index.sqlite3                    # 全局索引（搜索/枚举）

数据兼容：旧记录（manifest 无 ``columns`` 字段）仍可读取，列 schema 在
读取时从 ``main_data.csv`` 表头推断；新写入一律带 ``columns``。

设计要点：
  - 原子写入：先写 ``.tmp`` 再 ``os.replace``，失败不留半成品
  - commit 是两文件事务：发布前先把既有 manifest/main_data 原子重命名为
    ``.bak`` 快照，任一步失败则回滚快照并清理 ``.tmp``；
  - 崩溃恢复：下次 commit 时发现遗留 ``.bak`` 会保守恢复（发布未完成则还原，
    已完成则清理）；单写者模型下崩溃窗口可能短暂留下“新 CSV + 旧 manifest”
    组合，由下一次 commit 恢复（无 journal，不做跨文件崩溃原子性承诺）
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
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

#: source_namespace 必须匹配此正则，防止路径穿越。
_NAMESPACE_RE = re.compile(r"^[a-z][a-z0-9_]*$")
_DATASET_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]*$")
#: 列名安全约束：非空、无 CR/LF（防止 CSV 注入与畸形表头）。
_COLUMN_RE = re.compile(r"^[^\r\n,]+$")

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
    keywords: list[str] | None = None  # LLM 自由提取的关键实体标签
    #: 数据集自身的列 schema（表头顺序）。旧记录（Phase 8 之前写入）没有该
    #: 字段，读取时从 main_data.csv 表头推断，保持兼容。
    columns: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "dataset_id": self.dataset_id,
            "source_namespace": self.source_namespace,
            "topic": self.topic,
            "description": self.description,
            "row_count": self.row_count,
            "column_count": self.column_count,
            "created_at": self.created_at,
            "created_by_task_id": self.created_by_task_id,
            "source_files": list(self.source_files),
            "extra": dict(self.extra),
            "keywords": list(self.keywords) if self.keywords is not None else None,
            "columns": list(self.columns),
        }


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
        keywords: list[str] | None = None,
        columns: list[str] | None = None,
    ) -> CacheDatasetManifest:
        """原子地写入一个数据集到缓存并更新索引。

        Schema-neutral：列 schema 来自 ``csv_rows`` 首行的键（或显式
        ``columns``），不再依赖任何全局列常量。

        Args:
            dataset_id: 数据集 ID（``^[a-z0-9][a-z0-9_-]*$``）。
            source_namespace: 来源命名空间（如 ``user_import``）。
            topic: 主题/标题（供搜索）。
            description: 人类可读描述。
            csv_rows: 数据行，每行是 dict（列键必须是字符串，行间列键一致）。
            created_by_task_id: 创建此数据集的任务 ID（provenance）。
            source_files: 原始上传文件名列表。
            extra: 任意附加元数据。
            keywords: LLM 自由提取的关键实体标签，由 FTS5 索引供检索。
            columns: 显式列 schema；缺省时从 ``csv_rows`` 首行键推断。

        Returns:
            写入的 ``CacheDatasetManifest``。

        Raises:
            ValueError: namespace/dataset_id 格式非法、csv_rows 为空、
                列名非法或行间列键不一致。
        """
        self._validate_namespace(source_namespace)
        self._validate_dataset_id(dataset_id)

        resolved_columns = self._resolve_columns(csv_rows, columns)

        dataset_dir = self._records / source_namespace / dataset_id
        dataset_dir.mkdir(parents=True, exist_ok=True)

        main_data_path = dataset_dir / "main_data.csv"
        manifest_path = dataset_dir / "manifest.json"
        main_data_tmp = main_data_path.with_suffix(".csv.tmp")
        manifest_tmp = manifest_path.with_suffix(".json.tmp")
        # 快照名：发布前的既有最终文件会被原子重命名为 .bak，失败时回滚。
        csv_bak = main_data_path.with_suffix(".csv.bak")
        json_bak = manifest_path.with_suffix(".json.bak")

        published_csv = False
        published_manifest = False
        kw_list = [k.strip() for k in (keywords or []) if k and k.strip()]
        try:
            # 0. 恢复上次崩溃可能遗留的 .bak（幂等）
            self._recover_leftover_backups(
                main_data_path, csv_bak, manifest_path, json_bak
            )
            # 1. 写 main_data.csv 到 .tmp
            self._write_main_data(main_data_tmp, csv_rows, resolved_columns)
            # 2. 写 manifest.json 到 .tmp
            manifest = CacheDatasetManifest(
                dataset_id=dataset_id,
                source_namespace=source_namespace,
                topic=topic.strip(),
                description=description.strip(),
                row_count=len(csv_rows),
                column_count=len(resolved_columns),
                created_at=datetime.now(UTC).isoformat(),
                created_by_task_id=created_by_task_id,
                source_files=list(source_files or []),
                extra=dict(extra or {}),
                keywords=kw_list,
                columns=resolved_columns,
            )
            manifest_tmp.write_text(
                json.dumps(manifest.to_dict(), ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
            # 3. 快照既有最终文件（原子重命名；新数据集无既有文件则跳过）
            if main_data_path.exists():
                os.replace(main_data_path, csv_bak)
            if manifest_path.exists():
                os.replace(manifest_path, json_bak)
            # 4. 发布新文件（manifest 最后发布 = commit point）
            os.replace(main_data_tmp, main_data_path)
            published_csv = True
            os.replace(manifest_tmp, manifest_path)
            published_manifest = True
            # 5. 更新索引
            self._upsert_index(manifest)
        except BaseException:
            # 回滚：已快照（.bak）的文件一律还原（无论是否已发布）；新数据集
            # 已发布的最终文件无快照则删除；清理 .tmp。
            for tmp in (main_data_tmp, manifest_tmp):
                with contextlib.suppress(OSError):
                    tmp.unlink()
            for final, bak, published in (
                (main_data_path, csv_bak, published_csv),
                (manifest_path, json_bak, published_manifest),
            ):
                if bak.exists():
                    with contextlib.suppress(OSError):
                        os.replace(bak, final)
                elif published:
                    with contextlib.suppress(OSError):
                        final.unlink()
            raise

        # 成功：清理快照
        with contextlib.suppress(OSError):
            csv_bak.unlink()
        with contextlib.suppress(OSError):
            json_bak.unlink()

        logger.info(
            "CacheStore.commit_dataset: namespace=%s dataset=%s rows=%d columns=%d",
            source_namespace,
            dataset_id,
            len(csv_rows),
            len(resolved_columns),
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
        """按 FTS5 全文检索搜索数据集（匹配 topic/description/keywords）。

        查询串会被转义为 FTS5 phrase 查询；若 FTS5 不可用或查询语法
        无效，自动回退到 LIKE 搜索。
        """
        q = query.strip()
        if not q:
            return []
        conn = self._open_index()
        try:
            # FTS5 phrase query: wrap in double quotes to treat as phrase.
            # This avoids special chars (*, ^, :, etc.) being interpreted.
            fts_query = '"' + q.replace('"', '""') + '"'
            try:
                cur = conn.execute(
                    "SELECT manifest_path FROM datasets_fts "
                    "WHERE datasets_fts MATCH ? "
                    "ORDER BY created_at DESC LIMIT ?",
                    (fts_query, limit),
                )
                rows = cur.fetchall()
            except sqlite3.OperationalError:
                # FTS5 表不存在或查询语法错误 → 回退到 LIKE
                rows = self._search_like_fallback(conn, q, limit)
            if not rows:
                # FTS5 无匹配时也尝试 LIKE（FTS5 对子串匹配较弱）
                rows = self._search_like_fallback(conn, q, limit)
            return [self._load_manifest(Path(row[0])) for row in rows]
        finally:
            conn.close()

    @staticmethod
    def _search_like_fallback(
        conn: sqlite3.Connection,
        query: str,
        limit: int,
    ) -> list[tuple]:
        """LIKE 回退搜索（子串匹配 topic/description/keywords）。"""
        pattern = f"%{query}%"
        cur = conn.execute(
            "SELECT manifest_path FROM datasets "
            "WHERE topic LIKE ? OR description LIKE ? OR keywords LIKE ? "
            "ORDER BY created_at DESC LIMIT ?",
            (pattern, pattern, pattern, limit),
        )
        return cur.fetchall()

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
        # 旧记录 read-compatible：manifest 无 columns 时从 CSV 表头推断。
        if not manifest.columns and rows:
            manifest = CacheDatasetManifest(
                **{**manifest.__dict__, "columns": list(rows[0].keys())}
            )
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
        manifest = self._load_manifest(manifest_path)
        if not manifest.columns:
            # 旧记录兼容：从 main_data.csv 表头推断列 schema。
            main_data_path = (
                self._records / source_namespace / dataset_id / "main_data.csv"
            )
            if main_data_path.is_file():
                with main_data_path.open(
                    "r", encoding="utf-8-sig", newline="",
                ) as f:
                    header = f.readline().strip()
                columns = [
                    column for column in next(csv.reader([header]), [])
                    if column
                ]
                if columns:
                    manifest = CacheDatasetManifest(
                        **{**manifest.__dict__, "columns": columns}
                    )
        return manifest

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
    def _resolve_columns(
        rows: list[dict[str, str]],
        explicit: list[str] | None,
    ) -> list[str]:
        """确定数据集的列 schema（显式提供或从首行推断）。"""
        if not rows:
            raise ValueError("csv_rows must not be empty")
        if explicit is not None:
            columns = [str(column) for column in explicit]
        else:
            first = rows[0]
            columns = [str(key) for key in first]
        if not columns:
            raise ValueError("csv_rows must have at least one column")
        for column in columns:
            if _COLUMN_RE.fullmatch(column) is None:
                raise ValueError(
                    f"invalid column name {column!r}: must be non-empty and "
                    "contain no comma or line breaks"
                )
        if len(columns) != len(set(columns)):
            raise ValueError("column names must be unique")
        return columns

    @staticmethod
    def _write_main_data(
        path: Path,
        rows: list[dict[str, str]],
        columns: list[str],
    ) -> None:
        """将 rows 写为 CSV（表头为数据集的列 schema）。"""
        with path.open("w", encoding="utf-8-sig", newline="") as f:
            writer = csv.DictWriter(
                f,
                fieldnames=columns,
                extrasaction="raise",
            )
            writer.writeheader()
            for row in rows:
                # 用 dict.get 填充缺失列为空字符串；多余列由 extrasaction 拒绝
                writer.writerow({col: row.get(col, "") for col in columns})

    def _recover_leftover_backups(
        self,
        main_data_path: Path,
        csv_bak: Path,
        manifest_path: Path,
        json_bak: Path,
    ) -> None:
        """恢复上次 commit 崩溃可能遗留的 .bak 快照（幂等）。

        发布顺序约定：快照(CSV→manifest) → 发布 CSV → 发布 manifest（commit
        point）→ 清理快照（先 CSV 后 manifest）。因此：

        - ``json_bak`` 存在且 manifest 最终文件已存在 → 已越过 commit point，
          清理全部遗留快照；
        - ``json_bak`` 存在但 manifest 最终文件不存在 → 发布未完成，还原
          CSV 与 manifest 快照（或删除已发布的新文件）；
        - 仅 ``csv_bak`` 存在 → 崩溃发生在两次快照重命名之间（CSV 已快照、
          manifest 尚未快照，其最终文件仍是旧版本）：快照未完成，还原
          CSV 快照，旧状态完整。
        """
        if json_bak.exists():
            if not manifest_path.exists():
                # 崩溃发生在 manifest 发布之前：回退到发布前状态。
                if csv_bak.exists():
                    with contextlib.suppress(OSError):
                        os.replace(csv_bak, main_data_path)
                elif main_data_path.exists():
                    with contextlib.suppress(OSError):
                        main_data_path.unlink()
                with contextlib.suppress(OSError):
                    os.replace(json_bak, manifest_path)
            else:
                # 已越过 commit point：清理全部快照。
                for bak in (csv_bak, json_bak):
                    if bak.exists():
                        with contextlib.suppress(OSError):
                            bak.unlink()
            return
        if csv_bak.exists():
            # 仅 CSV 快照存在 → 崩溃于两次快照重命名之间。发布协议保证
            # 清理顺序也是先 CSV 后 manifest，因此该状态不可能来自清理
            # 阶段；它是快照未完成、旧 CSV 唯一副本，还原而非删除。
            with contextlib.suppress(OSError):
                os.replace(csv_bak, main_data_path)
            return
        # 无任何遗留。

    def _load_manifest(self, path: Path) -> CacheDatasetManifest:
        data = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            raise ValueError("cache manifest must be an object")
        # 旧记录（无 columns 字段）read-compatible。
        data.setdefault("columns", [])
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
                    keywords TEXT NOT NULL DEFAULT '',
                    row_count INTEGER NOT NULL,
                    created_at TEXT NOT NULL,
                    created_by_task_id TEXT NOT NULL,
                    manifest_path TEXT NOT NULL,
                    PRIMARY KEY (source_namespace, dataset_id)
                )
                """,
            )
            # Migration: add keywords column to pre-existing databases
            with contextlib.suppress(sqlite3.OperationalError):
                conn.execute(
                    "ALTER TABLE datasets "
                    "ADD COLUMN keywords TEXT NOT NULL DEFAULT ''"
                )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_datasets_namespace "
                "ON datasets(source_namespace)"
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_datasets_topic "
                "ON datasets(topic)"
            )
            # FTS5 全文索引 — 索引 topic/description/keywords
            conn.execute(
                """
                CREATE VIRTUAL TABLE IF NOT EXISTS datasets_fts USING fts5(
                    source_namespace UNINDEXED,
                    dataset_id UNINDEXED,
                    topic,
                    description,
                    keywords,
                    manifest_path UNINDEXED,
                    created_at UNINDEXED,
                    tokenize = 'unicode61'
                )
                """,
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
        keywords_str = " ".join(manifest.keywords or [])
        conn = self._open_index()
        try:
            conn.execute(
                """
                INSERT INTO datasets
                    (dataset_id, source_namespace, topic, description,
                     keywords, row_count, created_at, created_by_task_id,
                     manifest_path)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(source_namespace, dataset_id) DO UPDATE SET
                    topic = excluded.topic,
                    description = excluded.description,
                    keywords = excluded.keywords,
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
                    keywords_str,
                    manifest.row_count,
                    manifest.created_at,
                    manifest.created_by_task_id,
                    str(manifest_path),
                ),
            )
            # FTS5: 先删旧条目再插入（FTS5 不支持 ON CONFLICT）
            conn.execute(
                "DELETE FROM datasets_fts "
                "WHERE source_namespace = ? AND dataset_id = ?",
                (manifest.source_namespace, manifest.dataset_id),
            )
            conn.execute(
                """
                INSERT INTO datasets_fts
                    (source_namespace, dataset_id, topic, description,
                     keywords, manifest_path, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    manifest.source_namespace,
                    manifest.dataset_id,
                    manifest.topic,
                    manifest.description,
                    keywords_str,
                    str(manifest_path),
                    manifest.created_at,
                ),
            )
            conn.commit()
        finally:
            conn.close()
