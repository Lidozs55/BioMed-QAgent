# 数据源目录（Datasource Catalog）

本目录列出 `biomed-data-agent` skill 支持的全部数据源，含官方 URL、API 端点、限速策略、返回数据类型、对应客户端脚本及常见查询示例。

所有客户端位于 `scripts/datasources/`，继承 `BaseDataSource`，默认限速 1 req/sec（由 `RateLimiter` 强制）。每条返回记录均为符合 `schemas/data_record.schema.json` 的 `DataRecord`，并携带 `source_ref`（见 `schemas/source_reference.schema.json`）。

> 失败策略：某数据源返回错误或空结果时，记录日志并继续其他源，不中止整条流水线（见 `SKILL.md` → Failure Handling）。

---

## 1. PubMed（NCBI E-utilities）

| 项 | 值 |
|---|---|
| 数据源名称 | `pubmed` |
| 官方 URL | https://pubmed.ncbi.nlm.nih.gov/ |
| API 文档 URL | https://www.ncbi.nlm.nih.gov/books/NBK25501/ |
| API 端点 | `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi`（检索 PMID）<br>`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi`（获取详情 XML） |
| 限速策略 | 1 req/sec（NCBI 无 key 允许 3 req/sec，有 key 允许 10 req/sec；保守取 1） |
| 返回数据类型 | 文献元数据：pmid、title、abstract、authors、journal、pub_date、doi |
| 客户端脚本 | `scripts/datasources/pubmed_client.py` |
| 是否需要 API key | 否（建议配置 `NCBI_API_KEY` 环境变量以提升至 10 req/sec） |
| source_type | `database` |

### 常见查询示例

```bash
# 检索胰腺癌肝转移文献，最多 50 条
python scripts/datasources/pubmed_client.py \
    --query "pancreatic cancer liver metastasis" \
    --max 50 --out results/pubmed.json

# 检索健脾散结方相关文献
python scripts/datasources/pubmed_client.py \
    --query "Jianpi Sanjie formula pancreatic cancer" \
    --max 20 --out results/pubmed_tcm.json
```

---

## 2. NCBI Gene（NCBI E-utilities）

| 项 | 值 |
|---|---|
| 数据源名称 | `ncbi_gene`（db=gene）/ `ncbi_protein`（db=protein） |
| 官方 URL | https://www.ncbi.nlm.nih.gov/gene/ |
| API 文档 URL | https://www.ncbi.nlm.nih.gov/books/NBK25501/ |
| API 端点 | `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi`（检索 UID）<br>`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi`（获取摘要 JSON） |
| 限速策略 | 1 req/sec |
| 返回数据类型 | 基因：gene_id、symbol、name、organism、aliases、summary、chromosome<br>蛋白：protein_id、definition、organism、length |
| 客户端脚本 | `scripts/datasources/ncbi_client.py` |
| 是否需要 API key | 否（建议配置 `NCBI_API_KEY`） |
| source_type | `database` |

### 常见查询示例

```bash
# 检索 TP53 基因信息
python scripts/datasources/ncbi_client.py \
    --query "TP53" --db gene --max 20 --out results/ncbi_gene.json

# 检索 AKT1 蛋白信息
python scripts/datasources/ncbi_client.py \
    --query "AKT1" --db protein --max 10 --out results/ncbi_protein.json
```

---

## 3. GEO（NCBI Gene Expression Omnibus）

| 项 | 值 |
|---|---|
| 数据源名称 | `geo` |
| 官方 URL | https://www.ncbi.nlm.nih.gov/geo/ |
| API 文档 URL | https://www.ncbi.nlm.nih.gov/books/NBK25501/（E-utilities）<br>https://www.ncbi.nlm.nih.gov/geo/info/geo_pdat.html |
| API 端点 | `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=gds`（检索 GDS UID）<br>`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=gds`（获取数据集摘要） |
| 限速策略 | 1 req/sec |
| 返回数据类型 | 数据集元数据：geo_id（如 GSE12345）、title、summary、organism、sample_count、platform、pub_date、entry_type |
| 客户端脚本 | `scripts/datasources/geo_client.py` |
| 是否需要 API key | 否（建议配置 `NCBI_API_KEY`） |
| source_type | `database` |

### 常见查询示例

```bash
# 检索胰腺癌相关数据集
python scripts/datasources/geo_client.py \
    --query "pancreatic cancer" --max 20 --out results/geo.json

# 检索乳腺癌 TP53 表达数据
python scripts/datasources/geo_client.py \
    --query "breast cancer TP53 expression" --max 20 --out results/geo_tp53.json
```

### 补充说明

GEO SOFT 全量表达矩阵需通过 `scripts/parsers/geo_soft_parser.py` 解析（下载 SOFT 文件后本地解析，不通过 E-utilities）。检索客户端仅返回数据集元数据。

```bash
python scripts/parsers/geo_soft_parser.py \
    --input GSE12345.family.soft.gz --out results/geo_expr.json
```

---

## 4. STRING（蛋白质互作网络）

| 项 | 值 |
|---|---|
| 数据源名称 | `string` |
| 官方 URL | https://string-db.org/ |
| API 文档 URL | https://string-db.org/cgi/help.pl?subpage=api |
| API 端点 | `https://string-db.org/api/json/network`（互作边）<br>`https://string-db.org/api/json/interaction_partners`（单蛋白互作伙伴）<br>`https://string-db.org/api/tsv/resolve`（名称解析） |
| 限速策略 | 1 req/sec |
| 返回数据类型 | 互作边：protein_a、protein_b、score、evidence（experimental/database/textmining/coexpression）、species |
| 客户端脚本 | `scripts/datasources/string_client.py` |
| 是否需要 API key | 否 |
| source_type | `database` |

### 常见查询示例

```bash
# 检索 TP53 互作网络（人，物种 9606）
python scripts/datasources/string_client.py \
    --query "TP53" --species 9606 --max 50 --out results/string_tp53.json

# 检索 AKT1 互作网络
python scripts/datasources/string_client.py \
    --query "AKT1" --species 9606 --max 100 --out results/string_akt1.json
```

### 置信度阈值建议

- `score >= 0.4`：medium confidence（默认）
- `score >= 0.7`：high confidence（适合机制研究）
- `score >= 0.9`：highest confidence（适合核心 hub 基因筛选）

---

## 5. KEGG（京都基因与基因组百科全书）

| 项 | 值 |
|---|---|
| 数据源名称 | `kegg` |
| 官方 URL | https://www.kegg.jp/ |
| API 文档 URL | https://www.kegg.jp/kegg/rest/keggapi.html |
| API 端点 | `https://rest.kegg.jp/find/pathway/<query>`（检索通路）<br>`https://rest.kegg.jp/get/<pathway_id>`（获取通路详情，flat 格式）<br>`https://rest.kegg.jp/get/<pathway_id>/kgml`（KGML 网络图） |
| 限速策略 | 1 req/sec（KEGG 建议 3 req/sec，保守取 1） |
| 返回数据类型 | 通路：pathway_id（如 hsa04151）、title、description、genes、compounds、class |
| 客户端脚本 | `scripts/datasources/kegg_client.py` |
| 是否需要 API key | 否（学术免费；商用需 KEGG FTP 订阅） |
| source_type | `database` |

### 常见查询示例

```bash
# 检索细胞周期相关通路（人，物种代码 hsa）
python scripts/datasources/kegg_client.py \
    --query "cell cycle" --species hsa --out results/kegg_cellcycle.json

# 检索 PI3K-Akt 信号通路
python scripts/datasources/kegg_client.py \
    --query "PI3K-Akt" --species hsa --out results/kegg_pi3k.json
```

### 常用物种代码

- `hsa` — Homo sapiens（人，默认）
- `mmu` — Mus musculus（小鼠）
- `rno` — Rattus norvegicus（大鼠）

---

## 6. PDB（RCSB 蛋白质结构数据库）

| 项 | 值 |
|---|---|
| 数据源名称 | `pdb` |
| 官方 URL | https://www.rcsb.org/ |
| API 文档 URL | https://data.rcsb.org/ <br>https://search.rcsb.org/index.html |
| API 端点 | `https://search.rcsb.org/rcsbsearch/v2/query`（检索，POST JSON）<br>`https://data.rcsb.org/rest/v1/core/entry/<pdb_id>`（结构详情）<br>`https://data.rcsb.org/rest/v1/core/entity/<pdb_id>/<entity_id>`（实体详情，含物种） |
| 限速策略 | 1 req/sec |
| 返回数据类型 | 结构：pdb_id（如 1AKI）、title、organism、resolution、method、deposition_date、ligands |
| 客户端脚本 | `scripts/datasources/pdb_client.py` |
| 是否需要 API key | 否 |
| source_type | `database` |

### 常见查询示例

```bash
# 检索胰岛素相关结构
python scripts/datasources/pdb_client.py \
    --query "insulin" --max 20 --out results/pdb_insulin.json

# 检索 AKT1 与抑制剂共晶结构
python scripts/datasources/pdb_client.py \
    --query "AKT1 inhibitor" --max 20 --out results/pdb_akt1.json
```

### 补充说明

PDB 结构文件（.pdb / .cif）的解析由 `scripts/parsers/pdb_parser.py` 完成，FASTA 序列由 `scripts/parsers/fasta_parser.py` 解析。

---

## 7. TCMSP（中药系统药理学数据库）

| 项 | 值 |
|---|---|
| 数据源名称 | `tcmsp` |
| 官方 URL | https://tcmspw.com/ |
| API 文档 URL | 无官方 API 文档（TCMSP 无公开 API，本客户端调用其内部 JSON 接口） |
| API 端点 | `https://tcmspw.com/tcmspsearch.php`（内部 POST 接口，参数 `herbName` 或 `compoundName`） |
| 限速策略 | 1 req/sec（保守；网站无明文限制） |
| 返回数据类型 | 化合物：compound_name、mw（分子量）、ob（口服生物利用度）、dl（类药性）、targets（靶点，需另查） |
| 客户端脚本 | `scripts/datasources/tcmsp_client.py` |
| 是否需要 API key | 否 |
| source_type | `database` |

### 常见查询示例

```bash
# 检索三七的活性成分
python scripts/datasources/tcmsp_client.py \
    --herb "三七" --out results/tcmsp_sanmarino.json

# 检索槲皮素信息
python scripts/datasources/tcmsp_client.py \
    --compound "quercetin" --out results/tcmsp_quercetin.json
```

### 重要说明：接口不可用回退

TCMSP 无官方 API，`tcmspsearch.php` 为内部接口，可能因反爬或网站改版失效。当接口不可用时，客户端输出 `requires_crawl` 信号并退出：

```json
{
  "status": "requires_crawl",
  "reason": "TCMSP API blocked or unavailable, use agent-browser to crawl"
}
```

此时由 Stage 2（Acquire）接管，优先使用调度器 `WebFetch` 抓取静态页，或调用 `agent-browser` skill 渲染动态页。提取的记录 `extraction_confidence` 降为 0.5，并标记 `quality_flags: ["needs_review"]`。

### 筛选阈值建议

- 口服生物利用度（OB）≥ 30%
- 类药性（DL）≥ 0.18

这两个阈值是 TCM 网络药理学研究的常用筛选标准，可在 `domain_templates/tcm.yaml` 中配置。

---

## 速查表

| 数据源 | source_name | 客户端脚本 | API key | 默认限速 |
|---|---|---|---|---|
| PubMed | `pubmed` | `pubmed_client.py` | 可选 | 1 req/sec |
| NCBI Gene/Protein | `ncbi_gene` / `ncbi_protein` | `ncbi_client.py` | 可选 | 1 req/sec |
| GEO | `geo` | `geo_client.py` | 可选 | 1 req/sec |
| STRING | `string` | `string_client.py` | 否 | 1 req/sec |
| KEGG | `kegg` | `kegg_client.py` | 否 | 1 req/sec |
| PDB | `pdb` | `pdb_client.py` | 否 | 1 req/sec |
| TCMSP | `tcmsp` | `tcmsp_client.py` | 否 | 1 req/sec |

## API Key 配置

NCBI 系（PubMed / NCBI Gene / GEO）建议配置 `NCBI_API_KEY` 环境变量，可将限速提升至 10 req/sec。获取地址：https://www.ncbi.nlm.nih.gov/account/settings/

```bash
export NCBI_API_KEY="your_api_key_here"
```

> 当前客户端实现尚未读取该环境变量（默认 1 req/sec 已足够安全）。如需启用高速模式，修改 `scripts/datasources/_base.py` 中 `RateLimiter` 的初始化间隔。
