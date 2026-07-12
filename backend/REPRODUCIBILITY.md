# Reproducibility Guide — BioMed-QAgent

This document describes how to set up and reproduce the BioMed-QAgent
pipeline from scratch. Follow these steps to ensure consistent results
across different machines and environments.

---

## 1. Environment Setup

### Required Software

| Component | Version | Notes |
|---|---|---|
| Python | **3.12+** | Required for `openai-agents` SDK |
| [uv](https://docs.astral.sh/uv/) | latest | Python package manager |
| [pnpm](https://pnpm.io/) | latest | Frontend package manager (**do not use npm**) |
| Node.js | **20+** | Required for Vite / React 19 |
| Git | any recent | Version control |

### Verify Installation

```bash
python --version   # → Python 3.12.x (or later)
uv --version       # → uv 0.x.x
pnpm --version     # → 8.x or later
node --version     # → v20.x or later
```

---

## 2. Required Credentials

Create a `.env` file in `backend/` by copying the example template:

```bash
cd backend
cp .env.example .env  # if .env.example exists; otherwise create manually
```

Agent 对话模式需要以下变量；离线 fixture Pipeline、默认测试和浏览器验收不需要
模型 Key：

| Variable | Value | Where to obtain |
|---|---|---|
| `DASHSCOPE_API_KEY` | *(your key)* | [DashScope console](https://dashscope.console.aliyun.com/) |
| `DASHSCOPE_BASE_URL` | `https://dashscope.aliyuncs.com/compatible-mode/v1` | (default, no change needed) |
| `MODEL_NAME` | `qwen-plus` | (default) |
| `NCBI_EMAIL` | `your-email@example.com` | Required by NCBI Entrez API for PubMed/GEO |

> **Note:** The NCBI Entrez API works without `NCBI_EMAIL` for light usage,
> but setting it avoids rate-limiting warnings.

---

## 3. Quick Start

### Backend

```bash
cd backend
uv sync                           # install Python dependencies
uv run uvicorn app.main:app --reload
# → API docs at http://127.0.0.1:8000/docs
```

### Frontend

```bash
cd frontend
pnpm install                      # install JS dependencies
pnpm dev                          # → dev server at http://localhost:5173
```

---

## 4. Validated Fixture Pipeline

Start the backend, then create the approved deterministic task explicitly:

```bash
curl -X POST http://127.0.0.1:8000/api/v1/tasks \
  -H "Content-Type: application/json" \
  -d '{"topic":"breast cancer gene expression","databases":["pubmed","geo"],"mode":"fixture"}'
```

The response contains `task_id`. Output is written to
`data/output/tasks/<task_id>/artifacts/` and includes:

| File | Description |
|---|---|
| `main_data.csv` | Merged and cleaned data records |
| `literature.csv` | PubMed literature metadata |
| `dataset_catalog.csv` | GEO dataset metadata |
| `sample_metadata.csv` | Twelve GSM samples and normalized labels |
| `source_list.csv` | Source provenance manifest |
| `source_assets.csv` | Immutable source asset and checksum |
| `field_descriptions.csv` | Column names, types, descriptions, units |
| `field_mapping.csv` | Source-to-canonical field mapping |
| `source_relations.csv` | PMID-to-GSE evidence relation |
| `download_log.csv` | Acquisition attempt and byte count |
| `processing_log.csv` | Step-by-step processing history |
| `warnings.csv` | Issues encountered during the pipeline |
| `quality_report.csv` | Validation checks and failure counts |
| `run_manifest.json` | Typed task, validation and Artifact manifest |

---

## 5. Expected Output

For the approved fixture, the system:

1. **Search PubMed** — find relevant papers with titles, abstracts,
   authors, DOIs, and PMIDs.
2. **Identify GEO datasets** — search NCBI GEO for matching gene
   expression datasets (GSE accessions).
3. **Download raw data** — retrieve GEO series matrix files or
   supplementary data.
4. **Parse and clean** — extract structured tables, normalize field
   names, and align data types.
5. **Export validated outputs** — produce the structured files listed above in the
   `artifacts/` directory.

Expected validated summary:

```
Sources:           2  (PubMed, GEO)
Datasets:          1  (GSE178352)
Samples:           12
Rows:              48 (4 genes x 12 samples)
Artifacts:         14
Validation:        valid
Lineage failures:  0
```

Run verification from `backend/`:

```bash
uv run pytest -q
RUN_NCBI_LIVE=1 uv run pytest -m live tests/live/test_gse178352_live.py -q
```

On PowerShell, set the live flag with
`$env:RUN_NCBI_LIVE='1'` before the second command.

---

## 6. Known Issues

### API Rate Limits

- **NCBI Entrez**: Maximum 3 requests/second without an API key and 10/second
  with `NCBI_API_KEY`. The client enforces this limit globally and retries
  bounded 429/5xx responses.
- **NCBI Entrez** also enforces a daily limit (typically ~3000
  requests). The pipeline respects `max_results` to control volume.

### Large GEO Datasets

- GEO series matrix files for large studies (100+ samples) can be
  50–500 MB. Downloads use an explicit `max_size_mb` guard; increase it only
  after reviewing the expected source file.
- Acquisition stores compressed source assets without parsing them. Processing
  consumes only successfully verified `SourceAsset` records.

### DashScope API

- `qwen-plus` is the default model. If the API returns errors, verify
  your `DASHSCOPE_API_KEY` is active in the DashScope console.
- Rate limits apply; heavy usage may be throttled.

### Network Issues

- PubMed, GEO, and PDB tools all require internet access. Some
  institution networks block FTP or NCBI endpoints. Use a VPN if
  needed.
- GEO FTP downloads use `https://ftp.ncbi.nlm.nih.gov/geo/` —
  ensure this URL is reachable.

### File Encoding

- Raw files from GEO may use mixed encodings (ASCII, UTF-8, Latin-1).
  The parser defaults to `utf-8-sig` and handles common BOM markers.
  If parsing fails, manually inspect the raw file with a hex editor.

---

## 7. Troubleshooting

| Symptom | Likely Cause | Fix |
|---|---|---|
| `uv sync` fails | Wrong Python version | Ensure Python 3.12+ is active: `python --version` |
| `ImportError: No module named 'app'` | Not running from `backend/` | Run scripts from `backend/` directory |
| PubMed returns 0 results | Invalid query syntax | Use simple keywords, avoid special characters |
| GEO download 404 | Accession doesn't exist | Verify accession on [NCBI GEO](https://www.ncbi.nlm.nih.gov/geo/) |
| `DASHSCOPE_API_KEY` not set | Missing `.env` file | Create `backend/.env` following section 2 |
| `pnpm` not found | Not installed | `npm install -g pnpm` or follow [pnpm installation](https://pnpm.io/installation) |
