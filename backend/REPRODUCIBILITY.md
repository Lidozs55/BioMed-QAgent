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

Required environment variables:

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
uv run uvicorn app.server:app --reload
# → API docs at http://127.0.0.1:8000/docs
```

### Frontend

```bash
cd frontend
pnpm install                      # install JS dependencies
pnpm dev                          # → dev server at http://localhost:5173
```

---

## 4. Demo Pipeline

Run the end-to-end demo (no real API keys needed — uses mock data as
fallback):

```bash
cd backend
uv run python scripts/demo_workflow.py
```

Output is written to `data/demo_output/` and includes:

| File | Description |
|---|---|
| `main_data.csv` | Merged and cleaned data records |
| `source_list.csv` | Provenance manifest (source, accession, URL, local files) |
| `field_descriptions.csv` | Column names, types, descriptions, units |
| `processing_log.csv` | Step-by-step processing history |
| `warnings.csv` | Issues encountered during the pipeline |
| `metrics.json` | Per-stage metrics (time, downloads, rows, warnings) |

---

## 5. Expected Output

When running the full pipeline for a topic like *"breast cancer gene
expression"*, the system should:

1. **Search PubMed** — find relevant papers with titles, abstracts,
   authors, DOIs, and PMIDs.
2. **Identify GEO datasets** — search NCBI GEO for matching gene
   expression datasets (GSE accessions).
3. **Download raw data** — retrieve GEO series matrix files or
   supplementary data.
4. **Parse and clean** — extract structured tables, normalize field
   names, and align data types.
5. **Export CSV outputs** — produce the five CSVs listed above in the
   `artifacts/` directory.

Example output summary printed by the demo:

```
Sources found:     2  (pubmed, geo)
Files downloaded:  2
Rows processed:    84
Warnings:          1
Errors:            0
```

---

## 6. Known Issues

### API Rate Limits

- **NCBI Entrez**: Maximum 3 requests/second without an API key.
  Set `NCBI_EMAIL` in `.env` to increase to 10/sec. Use
  `time.sleep(0.34)` between calls as a safe default.
- **NCBI Entrez** also enforces a daily limit (typically ~3000
  requests). The pipeline respects `max_results` to control volume.

### Large GEO Datasets

- GEO series matrix files for large studies (100+ samples) can be
  50–500 MB. The download step uses a `max_size_mb` guard (default
  50 MB). Increase if needed.
- GEOparse may be slow for large SOFT files; prefer series matrix
  downloads when possible.

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
