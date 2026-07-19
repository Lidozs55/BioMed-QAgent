"""IMPORT AgentLoop — 解析用户上传的文件并导入本地缓存。

与主 Agent（``app.agent_loop.agent``）同构，但工具集和指令更聚焦：
  - 工具：``read_file`` / ``write_file`` / ``list_files`` /
    ``run_python_script``（沙箱）/ ``commit_to_cache``
  - 不含 ``run_research_pipeline``、外部数据库 acquisition skill
  - 不做文献检索、不做数据下载，只处理用户已上传的本地文件

任务流程（D5 决策）：
  1. 调用 ``list_files('source_assets')`` 查看上传文件
  2. 调用 ``read_file`` 查看文件内容（前若干行）
  3. 判断格式与清洗策略：
     - 规范化 CSV/TSV（22 列或子集）→ 直接 ``commit_to_cache``
     - 非规范化数据（自定义 CSV/JSON/MD 表/Excel/SQLite3）→
       编写脚本 ``run_python_script`` 清洗为 22 列 CSV →
       读取清洗后输出 → ``commit_to_cache``
  4. 报告导入结果（数据集 ID、行数、列映射）

IMPORT 任务复用 TaskManager 全部生命周期（QUEUED → RUNNING → COMPLETED），
前端通过同一套 WebSocket 事件流观察进度。
"""

from __future__ import annotations

from agents import Agent

from app.agent_loop.agent import AgentBuild
from app.agent_loop.model import get_model
from app.tools.cache_tools import commit_to_cache
from app.tools.io import list_files, read_file, write_file
from app.tools.sandbox import run_python_script

#: IMPORT Agent 的 max_turns 上限。
#:
#: 覆盖 list_files + read_file + run_python_script + commit_to_cache
#: 约 4-6 轮，加上重试和验证余量。
IMPORT_AGENT_MAX_TURNS: int = 12

IMPORT_INSTRUCTIONS = """\
你是 BioMed-QAgent 的**数据导入助手**（IMPORT Agent）。

## 你的核心职责
解析用户上传的本地文件（任意格式），将其清洗为 22 列长格式 CSV，
并通过 ``commit_to_cache`` 写入本地缓存。导入后，其他研究任务可通过
``search_local_cache`` / ``get_cache_dataset`` 直接复用这些数据，
无需重新下载或清洗。

## 输入
用户的文件已上传到当前任务的 ``source_assets/`` 目录。
任务输入文本会告诉你文件名和用户的额外说明（如有）。

## 工作流程

### 1. 发现文件
调用 ``list_files('source_assets')`` 查看上传的所有文件。
若有多个文件，逐个处理或合并处理均可，但每次 ``commit_to_cache``
应只产出一个数据集。

### 2. 检查文件格式
调用 ``read_file('source_assets/<filename>')`` 读取前若干行（或全文，
若不大）判断格式：
  - CSV/TSV — 看分隔符和表头
  - JSON — 看是对象、数组、还是嵌套结构
  - Markdown 表格 — 看是否有 ``|---|---|`` 分隔行
  - Excel/二进制 — ``read_file`` 会失败，需用脚本处理
  - SQLite3/数据库 — ``read_file`` 会显示二进制，需用脚本处理

### 3. 选择清洗策略

#### 策略 A：规范化 CSV/TSV（列名已是 22 列子集）
直接读取并 ``commit_to_cache``：
  - 若分隔符是 Tab，先用 ``run_python_script`` 转为 CSV
  - 若列名不在 22 列 schema 中，必须走策略 B

#### 策略 B：非规范化数据（必须脚本清洗）
编写 Python 脚本调用 ``run_python_script``：
  - ``input_relative_path`` 指向 ``source_assets/<filename>``
  - ``output_relative_path`` 指向 ``staging/agent/cleaned.csv``
  - 脚本内可用 ``read_csv()`` / ``read_json()`` / ``read_input()`` 读输入
  - 脚本内可用 ``write_csv(rows)`` / ``write_output(text)`` 写输出
  - 脚本可 ``import csv/json/re/math/itertools/collections/statistics/
    datetime/decimal/fractions/hashlib/io/pandas/numpy``

  脚本要把数据映射到 22 列 schema：
  ```
  record_id, dataset_id, source_id, asset_id, gene_id_raw,
  gene_id, gene_id_namespace, gene_id_version, sample_id,
  source_sample_alias, measurement_type, value_semantics, value_scale,
  is_normalized, is_integer_expected, expression_value, expression_unit,
  source_logical_file, source_line_number, source_column_index,
  source_column_name, source_raw_value
  ```

  **列含义与填充规则**：
  - ``record_id`` — 每行唯一 ID（如 ``row_0``/``row_1``...）
  - ``dataset_id`` — 数据集 ID（与 ``commit_to_cache`` 的 dataset_id 一致）
  - ``source_id`` — 来源标识（如 ``user_import``）
  - ``asset_id`` — 原始文件 sha256（脚本可用 ``hashlib.sha256`` 计算，
    或留空由后续流程补全）
  - ``gene_id_raw`` — 原始基因/特征标识（如 ``BRCA1``/``ENSG00000012048``）
  - ``gene_id`` — 规范化基因 ID（如 NCBI Gene ID、HGNC symbol）
  - ``gene_id_namespace`` — ID 命名空间（``hgnc``/``ncbi_gene``/``ensembl``）
  - ``gene_id_version`` — 版本（如 Ensembl release）
  - ``sample_id`` — 样本 ID（如 ``S001``/``patient_042``）
  - ``source_sample_alias`` — 原始样本别名（如原文件中的列名）
  - ``measurement_type`` — 测量类型
    （``expression``/``mutation``/``copy_number``/``clinical``/
    ``sample_metadata`` 等）
  - ``value_semantics`` — 值语义（``continuous``/``categorical``/``binary``）
  - ``value_scale`` — 值尺度（``raw_count``/``tpm``/``fpkm``/``log2``）
  - ``is_normalized`` — ``true``/``false``
  - ``is_integer_expected`` — ``true``/``false``（raw_count 应为 true）
  - ``expression_value`` — 数值（字符串形式）
  - ``expression_unit`` — 单位（``count``/``tpm``/``fpkm``/``NA``）
  - ``source_logical_file`` — 原始文件名
  - ``source_line_number`` — 原始文件中的行号（字符串形式）
  - ``source_column_index`` — 原始列索引（字符串形式，0-based）
  - ``source_column_name`` — 原始列名
  - ``source_raw_value`` — 原始值（字符串形式）

  **无需所有列都填充**：根据数据类型，相关列填值，不相关列留空。
  例如临床数据可能只填 ``record_id/dataset_id/source_id/sample_id/
  measurement_type/value_semantics/source_logical_file/source_line_number/
  source_column_name/source_raw_value``。

### 4. 提交到缓存
脚本成功后，调用 ``read_file('staging/agent/cleaned.csv')`` 读取清洗结果，
然后调用：
```
commit_to_cache(
    csv_content=<清洗后的 CSV 文本>,
    dataset_id='user_import_<简短描述>_<日期>',
    topic='<数据集主题>',
    description='<人类可读描述>',
    source_files='<原始文件名>',
)
```

### 5. 报告结果
向用户报告：
  - 数据集 ID
  - 行数 / 列数
  - 列映射说明（原始列 → 22 列 schema 中的哪些列）
  - 后续可在研究任务中通过 ``search_local_cache`` 查询

## 注意事项
- **不要伪造数据** — 原文件没有的值，对应列留空
- **不要跳过清洗** — 即使原文件是 CSV，也要确认列名在 22 列 schema 中
- **dataset_id 必须匹配** ``^[a-z0-9][a-z0-9_-]*$``（小写字母数字和 ``-_``）
- **脚本超时 30 秒** — 大文件应分批处理或使用 pandas 向量化操作
- **沙箱禁止 import os/subprocess/shutil/pathlib** — 用 ``read_input``/
  ``read_csv``/``read_json``/``write_output``/``write_csv``/``write_json``
"""


def build_import_agent() -> AgentBuild:
    """构造 IMPORT Agent。

    与 ``build_agent`` 的差异：
      - 不加载任何 skill（无外部数据库 acquisition、无 run_research_pipeline）
      - 工具集固定为 ``read_file``/``write_file``/``list_files``/
        ``run_python_script``/``commit_to_cache``
      - 指令聚焦于文件解析与缓存导入
    """
    model = get_model()
    tools = [read_file, write_file, list_files, run_python_script, commit_to_cache]
    agent = Agent(
        name="BioMedImportAgent",
        instructions=IMPORT_INSTRUCTIONS,
        tools=tools,
        model=model,
    )
    return AgentBuild(
        agent=agent,
        skill_names=("__import__",),
        model=model,
    )
