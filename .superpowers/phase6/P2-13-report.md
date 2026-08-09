# Phase 6 — P2-1 + P2-3: `extract_tables` CJK / OCR-fallback diagnostics + real pdfplumber path tests

**Status:** DONE (TDD: red → fix → green)
**Branch:** `feat/phase6-P2-13-extract-tables-cjk` (base `main @ eceacda`)
**Commit:** `5345b67`
**Gates:** pytest 2648 passed / 2 skipped / 28 deselected (baseline 2641 → +7 new tests) · `ruff check app/ tests/ launcher.py` clean · `python -c "import app.main"` OK · uvicorn boot + `/api/v1/health` OK

## Scope

| Item | TODO | Work |
| ---- | ---- | ---- |
| P2-1a | §2.7.3 | CJK/中文 support in the regex fallback: UTF-16BE hex-string PDF strings (`<hex> Tj` / inside `TJ` arrays) are decoded; UTF-8 CJK literals inside `(...)` are recovered. ASCII behavior untouched (existing tests green). |
| P2-1b | §2.7.3 | Scanned/image-only PDF diagnostics: pdfplumber path detects zero text + zero tables + image objects and returns a warning directing the Agent to the Qwen-VL `extract_chart_data_vlm` channel. **No OCR introduced** — pytesseract was rejected (pyproject.toml:33-35, TODO §5.2 replaced CV with Qwen-VL). |
| P2-3 | §2.7.5 | Real pdfplumber path tests with committed minimal PDF fixtures: `extract_pdf_tables` returns tables end-to-end (no mocks); `extract_pdf_metadata` works on the real fixture. |

## Files touched (5, all backend)

- `backend/app/skills/builtin/processing/extract_tables.py` — regex fallback decoding + scanned-PDF warning + stream-decompression guard fix
- `backend/tests/test_skill_extract_tables.py` — +7 tests
- `backend/tests/fixtures/pdf/minimal_table.pdf` — new fixture (ruled 2-col table + text block)
- `backend/tests/fixtures/pdf/scanned_image.pdf` — new fixture (image XObject, no text layer)
- `backend/tests/fixtures/pdf/generate_fixtures.py` — new self-contained regenerator for the fixtures (no external PDF lib)

Frontend untouched. No other source file modified.

## Implementation details

### P2-1a — regex fallback CJK support (`_extract_text_via_regex`)

1. **Hex strings:** new shared operand pattern `_PDF_STRING_PART = (?:\\(([^)]*(?:\\.[^)]*)*)\\)|<([0-9a-fA-F\\s]+)>)`; `_PDF_TJ_CALL_RE` = part + `\s*Tj` handles single show-ops, and TJ arrays now extract literal *and* hex parts in document order.
2. **Decoding heuristic** (`_decode_pdf_bytes`, ordered): UTF-16 BOM → UTF-16; interleaved NULs → UTF-16BE; valid UTF-8 → UTF-8; ≥ half of 16-bit pairs in CJK Unified Ideographs U+4E00–U+9FFF → UTF-16BE (no-BOM pure-CJK case); else latin-1. ASCII hex strings (`<48656C6C6F>`) decode via the UTF-8 branch — unchanged output.
3. **CJK literals** (`_recover_utf8_literal`): the raw file is latin-1-decoded to preserve operator bytes; non-ASCII literal strings are re-encoded latin-1 → bytes → UTF-8 decode. ASCII short-circuits (`str.isascii()`), so ASCII behavior is byte-for-byte unchanged.
4. **Pre-existing bug fixed (in scope, same file):** `_decompress_pdf_streams`'s guard checked `b"/Filter" in stream_block`, but `_PDF_STREAM_RE` started matching at the `stream` keyword, so the filter dict was never in the match → FlateDecode decompression was a silent no-op (the "decompressed content streams" feature never fired; the old CJK probe only worked because zlib's deflate output embeds incompressible literal bytes). Regex now `(?:<<[^>]*>>\s*)?stream\r?\n(.*?)\r?\nendstream`. Nothing else in the repo depends on the old behavior (verified by grep). This was required for the CJK tests to be meaningful — otherwise they'd pass on a deflate-literal fluke.

### P2-1b — scanned-PDF VLM-channel warning (`_extract_via_pdfplumber`)

- Tracks `total_text_len` (sum of `page.extract_text()` strip lengths) and `has_images` (`page.images` non-empty) across pages.
- If `not tables and total_text_len == 0 and has_images` → returns the existing "no tables" shape plus `warning` string naming `extract_chart_data_vlm` (Qwen-VL) and noting OCR is not in the stack. `extract_pdf_tables` already propagates `warning` into the response dict, so no signature/contract change.
- Red test asserts `"extract_chart_data_vlm" in data["warning"]` on the `scanned_image.pdf` fixture through the real pdfplumber path.

### P2-3 — real pdfplumber path

- `minimal_table.pdf`: hand-authored single-page PDF (exact xref offsets), title/authors/Abstract/DOI text + ruled 2-column table (Gene×FC, 2 data rows) drawn with `m/l/S` operators (pdfminer emits LTLine; rects alone did not produce vertical column splits — verified empirically).
- `scanned_image.pdf`: 2×2 DeviceGray image XObject, no text layer.
- Both verified parseable by the installed pdfplumber 0.11.10 before committing; `generate_fixtures.py` reproduces them byte-for-byte.
- Tests: `extract_pdf_tables` on the real fixture → 1 table, header `["Gene","FC"]`, 2 rows, CSV contains BRCA1/TP53, no warning; `extract_pdf_metadata` → title/authors/DOI/abstract/page-count heuristics all hit.

## Test matrix (new, in `test_skill_extract_tables.py`)

| Test | Path exercised |
| ---- | -------------- |
| `test_regex_fallback_decodes_utf16be_hex_strings` | `_extract_text_via_regex` on hex-only FlateDecode blob |
| `test_regex_fallback_recovers_cjk_literals` | `_extract_text_via_regex` on literal-only FlateDecode blob |
| `test_regex_fallback_keeps_ascii_behavior` | mixed blob, `"Gene"` still extracted |
| `test_extract_tables_regex_fallback_cjk_via_tool` | public tool with `_resolve_pdf_backend` patched to `(None, None)`; CSV contains 基因表达分析 |
| `test_extract_tables_scanned_pdf_warns_vlm_channel` | real pdfplumber path on `scanned_image.pdf`; warning mentions `extract_chart_data_vlm` |
| `test_extract_tables_real_pdfplumber_path` | real pdfplumber path on `minimal_table.pdf` (no mocks) |
| `test_extract_metadata_real_pdfplumber_path` | real pdfplumber text path for metadata (no mocks) |

The first two tests were initially false-green (hex/literal paths shared a blob); each now uses a single-path blob so the assertion cannot pass via the sibling path.

## Notes / follow-ups

- TODO §2.7.3 / §2.7.5 checkboxes in `docs/TODO.md` and the Commonly board are **not** edited by this subagent (task constraint: touch only the deliverable files) — ready to be marked done by the orchestrator.
- Known fallback limits (unchanged, documented in code): CIDFont Identity-H encodings (character-code → glyph, no unicode mapping) and WinAnsi multi-byte look-alikes are out of regex scope; the pdfplumber primary path handles real PDFs.
- Worktree note: the task statement described `/mnt/d/code-linux/BioMed-QAgent` as the "isolated worktree"; `git worktree list` shows it is actually the main repo at `eceacda` (the harness's detached worktree is `/tmp/pi-agent-beeaa67e-be44-4e5-949b66f4`). Committed on the dedicated branch per AGENTS.md §7.1 to keep `main` clean — orchestrator should merge per §7.2.
- `.pi-subagents/` untracked harness artifacts were deliberately excluded from the commit.
