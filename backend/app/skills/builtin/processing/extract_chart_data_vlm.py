"""Extract structured chart data from paper figures using Qwen-VL.

This skill is the L1 (primary) tier of the chart-extraction chain described
in TODO §5.2. It accepts **any** paper artifact the Agent has already
acquired — a PNG screenshot from ``web_visual_capture``, a JPG figure, or a
PDF downloaded by ``download_supplementary`` — and extracts chart_type /
axes / data_points / legend as strict JSON, then writes two CSV artifacts:

- ``parsed/chart_data/chart_data.csv``         (one row per chart)
- ``parsed/chart_data/chart_data_points.csv``  (one row per data point)

Provenance: each extracted chart references its source image via
``source_asset_id`` (the image's sha256), so chart_data is traceable to the
exact PNG or PDF page that produced it.

Three-tier degradation chain (project_memory L1: no silent fallback):

- **L1 — Qwen-VL** (this skill): primary path. Requires DASHSCOPE_API_KEY.
- **L2 — pdfplumber tables**: only applies when source is a PDF. Extracts
  tabular data that may underlie a chart. NOT a substitute for VLM on
  raster charts, but recovers structured data from vector PDF tables.
- **L3 — caption text**: final fallback. Extracts "Figure N." / "Table N."
  captions from PDF text or (for images) records the file as
  ``chart_unextracted`` in warnings.

When ALL three tiers fail, ``ChartExtractionError`` is raised — never
return an empty success. Per project_memory L1, silent empty-data fallback
is forbidden.

Integration plan: docs/separateweb_capture_integration_plan.md §5
TODO: §5.2
"""
from __future__ import annotations

import csv
import hashlib
import json
import logging
import re
import shutil
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from agents import RunContextWrapper, function_tool

from app.agent_loop.context import RunContext
from app.agent_loop.vl_model import (
    VL_MODEL_NAME,
    ChartExtractionError,
    call_vl_model,
)
from app.domain.contracts import QueryStatus, StageName
from app.skills.registry import SkillCategory, SkillDef, skill_registry
from app.tools.workdir import TaskWorkDir

logger = logging.getLogger(__name__)

#: Maximum number of images to extract from a single PDF. Caps VLM cost
#: and prevents runaway extraction on dense PDFs (e.g., supplement with
#: 50+ figures). Extra images are logged as a warning.
_MAX_PDF_IMAGES_PER_FILE = 10

#: Supported image file extensions (lowercase, with dot).
_IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".gif"}

#: Supported PDF file extension.
_PDF_EXTENSION = ".pdf"

#: Strict JSON prompt for Qwen-VL. The model is instructed to return ONLY
#: a JSON object — no markdown fences, no prose. ``temperature=0.1``
#: further reduces format drift.
_VLM_PROMPT = """\
You are a biomedical chart data extraction assistant. Analyze the image and
extract structured chart data. Return ONLY a JSON object (no markdown fences,
no prose) with this exact schema:

{
  "chart_type": "bar" | "line" | "scatter" | "box" | "violin" | \
"heatmap" | "pie" | "histogram" | "other",
  "title": "<chart title or empty string>",
  "axes": {
    "x": {"label": "<label>", "unit": "<unit or empty>", "scale": \
"linear" | "log" | "other"},
    "y": {"label": "<label>", "unit": "<unit or empty>", "scale": \
"linear" | "log" | "other"}
  },
  "data_points": [
    {"x": "<x value as string>", "y": "<y value as string>", \
"series_label": "<series name>"}
  ],
  "legend": ["<series 1 name>", "<series 2 name>"]
}

Rules:
- If the image is not a chart (e.g., a photo, a diagram, pure text), return
  {"chart_type": "other", "title": "", "axes": {"x": {"label":"",\
"unit":"","scale":"linear"}, "y": {"label":"","unit":"","scale":"linear"}}, \
"data_points": [], "legend": []}
- Numeric x/y values must be stringified (e.g., "1.5", "100", "NA").
- For box/violin plots, each data_point.y may be a comma-separated list
  representing the quartiles/whiskers.
- Extract at most 100 data_points; for dense scatter plots, sample
  representative points.
- Do NOT wrap the JSON in markdown fences."""


# ---------------------------------------------------------------------------
# Path & sha helpers
# ---------------------------------------------------------------------------


def _sha256_file(path: Path) -> str:
    """Compute SHA-256 hex digest of a file (64 lowercase hex chars)."""
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _figures_dir(workdir: TaskWorkDir) -> Path:
    """Return (creating if needed) the source_assets/figures/ directory."""
    fig_dir = workdir.source_asset_file("figures/_placeholder").parent
    fig_dir.mkdir(parents=True, exist_ok=True)
    return fig_dir


def _chart_data_dir(workdir: TaskWorkDir) -> Path:
    """Return (creating if needed) the parsed/chart_data/ directory."""
    cd_dir = workdir.root / "parsed" / "chart_data"
    cd_dir.mkdir(parents=True, exist_ok=True)
    return cd_dir


def _ensure_image_in_figures(
    source_path: Path,
    workdir: TaskWorkDir,
) -> tuple[Path, str, bool]:
    """Ensure an image is under ``source_assets/figures/``.

    Returns ``(figures_path, sha256, was_copied)``. If the source is already
    in figures/, returns it as-is with ``was_copied=False``. Otherwise
    copies it to ``figures/fig_<sha256[:12]><ext>`` (content-addressed, no
    clobber if same sha already exists).

    This satisfies TODO §5.2 "原始图片数据保留到 source_assets/figures/"
    for images that originated outside web_visual_capture (e.g., a JPG
    downloaded by a future skill, or an image extracted from a PDF).
    """
    sha = _sha256_file(source_path)
    ext = source_path.suffix.lower()
    dest_name = f"fig_{sha[:12]}{ext}"
    dest_path = workdir.source_asset_file(f"figures/{dest_name}")

    # Already inside figures/? (e.g., web_visual_capture output)
    try:
        source_resolved = source_path.resolve()
        figures_root = _figures_dir(workdir).resolve()
        if source_resolved.parent == figures_root:
            return source_path, sha, False
    except OSError:
        pass

    if not dest_path.exists():
        dest_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source_path, dest_path)
        was_copied = True
    else:
        was_copied = False

    return dest_path, sha, was_copied


# ---------------------------------------------------------------------------
# PDF image extraction (L1 prep for PDFs)
# ---------------------------------------------------------------------------


def _extract_pdf_images(pdf_path: Path, dest_dir: Path) -> list[Path]:
    """Extract embedded raster images from a PDF using pdfplumber.

    Returns a list of image paths (PNG) under ``dest_dir``, named
    ``<pdf_stem>_p<page>_img<idx>.png``. At most ``_MAX_PDF_IMAGES_PER_FILE``
    images are returned; extra images are counted and logged as a warning.

    Raises ``ChartExtractionError`` if pdfplumber is unavailable or the PDF
    cannot be opened.
    """
    try:
        import pdfplumber
    except ImportError as exc:
        raise ChartExtractionError(
            f"pdfplumber/Pillow unavailable; cannot extract images from {pdf_path}"
        ) from exc

    dest_dir.mkdir(parents=True, exist_ok=True)
    stem = pdf_path.stem
    extracted: list[Path] = []
    skipped_extra = 0

    try:
        with pdfplumber.open(str(pdf_path)) as pdf:
            for page_idx, page in enumerate(pdf.pages, 1):
                if len(extracted) >= _MAX_PDF_IMAGES_PER_FILE:
                    skipped_extra += len(page.images)
                    continue
                for img_idx, img_meta in enumerate(page.images, 1):
                    if len(extracted) >= _MAX_PDF_IMAGES_PER_FILE:
                        skipped_extra += 1
                        continue
                    # page.images entries are dicts with stream/physical
                    # refs; use page.to_image() rasterization as the
                    # reliable path (works for vector + raster PDFs).
                    try:
                        im = page.to_image(resolution=150)
                        # Crop to image bbox (PDF points → pixels at 150dpi)
                        bbox = (
                            int(img_meta["x0"]),
                            int(img_meta["top"]),
                            int(img_meta["x1"]),
                            int(img_meta["bottom"]),
                        )
                        # pdfplumber's to_image returns a PageImage with
                        # ``original`` (PIL Image); crop using bbox scaled
                        # by resolution/72.
                        scale = im.resolution / 72.0 if hasattr(im, "resolution") else 150 / 72.0
                        scaled_bbox = tuple(int(c * scale) for c in bbox)
                        pil_img = im.original.crop(scaled_bbox)
                        out_path = dest_dir / f"{stem}_p{page_idx}_img{img_idx}.png"
                        pil_img.save(out_path, format="PNG")
                        extracted.append(out_path)
                    except Exception as exc:
                        logger.warning(
                            "failed to extract image p%d img%d from %s: %s",
                            page_idx, img_idx, pdf_path, exc,
                        )
    except Exception as exc:
        raise ChartExtractionError(
            f"pdfplumber failed to open {pdf_path}: {exc}"
        ) from exc

    if skipped_extra > 0:
        logger.warning(
            "PDF %s had %d additional images beyond the %d cap; skipped",
            pdf_path, skipped_extra, _MAX_PDF_IMAGES_PER_FILE,
        )

    return extracted


# ---------------------------------------------------------------------------
# VLM JSON parsing
# ---------------------------------------------------------------------------


#: Strip markdown fences if the model ignored instructions.
_MD_FENCE_RE = re.compile(r"^```(?:json)?\s*\n?(.*?)\n?```\s*$", re.DOTALL)


def _parse_vlm_json(raw: str, source_label: str) -> dict[str, Any]:
    """Parse the VLM response into a chart JSON dict.

    Tolerates markdown fences (despite the prompt forbidding them) and
    trailing prose. Raises ``ChartExtractionError`` if the response cannot
    be parsed as JSON or lacks the required top-level keys.
    """
    text = raw.strip()
    fence_match = _MD_FENCE_RE.fullmatch(text)
    if fence_match:
        text = fence_match.group(1).strip()

    # If there's trailing prose after the JSON object, trim at the last
    # closing brace that matches the first opening brace.
    if text.startswith("{"):
        depth = 0
        end_idx = -1
        for i, ch in enumerate(text):
            if ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    end_idx = i + 1
                    break
        if end_idx > 0:
            text = text[:end_idx]

    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ChartExtractionError(
            f"qwen-vl-max returned non-JSON for {source_label}: {exc}"
        ) from exc

    if not isinstance(data, dict):
        raise ChartExtractionError(
            f"qwen-vl-max returned non-object JSON for {source_label}: "
            f"{type(data).__name__}"
        )

    required = ("chart_type", "axes", "data_points")
    missing = [k for k in required if k not in data]
    if missing:
        raise ChartExtractionError(
            f"qwen-vl-max JSON missing required keys {missing} for "
            f"{source_label}"
        )

    return data


def _normalize_chart_json(
    data: dict[str, Any],
    source_asset_id: str,
    chart_idx: int,
    source_label: str,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Normalize VLM JSON into (chart_row, data_point_rows).

    ``chart_row`` matches ``chart_data.csv`` columns; each ``data_point_row``
    matches ``chart_data_points.csv`` columns.
    """
    chart_id = f"chart_{source_asset_id[:20]}_{chart_idx}"
    axes = data.get("axes") or {}
    x_axis = axes.get("x") or {}
    y_axis = axes.get("y") or {}
    data_points = data.get("data_points") or []
    legend = data.get("legend") or []

    chart_row = {
        "chart_id": chart_id,
        "source_asset_id": source_asset_id,
        "chart_type": str(data.get("chart_type", "other")),
        "title": str(data.get("title", "")),
        "x_label": str(x_axis.get("label", "")),
        "x_unit": str(x_axis.get("unit", "")),
        "x_scale": str(x_axis.get("scale", "linear")),
        "y_label": str(y_axis.get("label", "")),
        "y_unit": str(y_axis.get("unit", "")),
        "y_scale": str(y_axis.get("scale", "linear")),
        "data_point_count": len(data_points),
        "legend": "|".join(str(s) for s in legend) if legend else "",
        "extracted_at": datetime.now(UTC).isoformat(),
        "model_name": VL_MODEL_NAME,
        "source_label": source_label,
    }

    point_rows: list[dict[str, Any]] = []
    for pt_idx, pt in enumerate(data_points, 1):
        if not isinstance(pt, dict):
            continue
        point_rows.append({
            "point_id": f"{chart_id}_p{pt_idx}",
            "chart_id": chart_id,
            "x_value": str(pt.get("x", "")),
            "y_value": str(pt.get("y", "")),
            "series_label": str(pt.get("series_label", "")),
            "confidence": "",
        })

    return chart_row, point_rows


# ---------------------------------------------------------------------------
# CSV writers
# ---------------------------------------------------------------------------


_CHART_DATA_COLUMNS = [
    "chart_id", "source_asset_id", "chart_type", "title",
    "x_label", "x_unit", "x_scale",
    "y_label", "y_unit", "y_scale",
    "data_point_count", "legend",
    "extracted_at", "model_name", "source_label",
]

_CHART_DATA_POINTS_COLUMNS = [
    "point_id", "chart_id", "x_value", "y_value",
    "series_label", "confidence",
]


def _write_chart_csvs(
    chart_data_dir: Path,
    chart_rows: list[dict[str, Any]],
    point_rows: list[dict[str, Any]],
) -> tuple[Path, Path]:
    """Write (or append to) chart_data.csv and chart_data_points.csv.

    Returns ``(chart_csv_path, points_csv_path)``. Writes with UTF-8 BOM
    (``utf-8-sig``) for Excel compatibility (TODO §1.7).
    """
    chart_csv = chart_data_dir / "chart_data.csv"
    points_csv = chart_data_dir / "chart_data_points.csv"

    # Write chart_data.csv (overwrite — each tool call produces a fresh
    # snapshot for this source)
    with open(chart_csv, "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=_CHART_DATA_COLUMNS)
        writer.writeheader()
        writer.writerows(chart_rows)

    with open(points_csv, "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=_CHART_DATA_POINTS_COLUMNS)
        writer.writeheader()
        writer.writerows(point_rows)

    return chart_csv, points_csv


# ---------------------------------------------------------------------------
# L2 fallback: pdfplumber tables (only for PDF sources)
# ---------------------------------------------------------------------------


def _try_pdfplumber_tables(
    pdf_path: Path,
    source_asset_id: str,
    source_label: str,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]] | None:
    """L2 fallback: extract tables from a PDF using pdfplumber.

    Returns ``(chart_rows, point_rows)`` if at least one table was found,
    or ``None`` if no tables (caller should proceed to L3).

    Tables are recorded as chart_type="table" with each cell becoming a
    data_point (x=column index, y=cell value, series_label=row index).
    """
    try:
        import pdfplumber
    except ImportError:
        return None

    chart_rows: list[dict[str, Any]] = []
    point_rows: list[dict[str, Any]] = []

    try:
        with pdfplumber.open(str(pdf_path)) as pdf:
            for page_idx, page in enumerate(pdf.pages, 1):
                tables = page.extract_tables() or []
                for tbl_idx, table in enumerate(tables, 1):
                    if not table or len(table) < 2:
                        continue
                    header = table[0]
                    data_rows = table[1:]
                    chart_id = f"chart_{source_asset_id[:20]}_tbl_p{page_idx}_{tbl_idx}"
                    chart_rows.append({
                        "chart_id": chart_id,
                        "source_asset_id": source_asset_id,
                        "chart_type": "table",
                        "title": f"PDF table p{page_idx} #{tbl_idx}",
                        "x_label": "column",
                        "x_unit": "",
                        "x_scale": "linear",
                        "y_label": "value",
                        "y_unit": "",
                        "y_scale": "linear",
                        "data_point_count": sum(len(r) for r in data_rows),
                        "legend": "|".join(str(h) for h in header) if header else "",
                        "extracted_at": datetime.now(UTC).isoformat(),
                        "model_name": "pdfplumber",
                        "source_label": source_label,
                    })
                    for row_idx, row in enumerate(data_rows, 1):
                        for col_idx, cell in enumerate(row, 1):
                            point_rows.append({
                                "point_id": f"{chart_id}_r{row_idx}_c{col_idx}",
                                "chart_id": chart_id,
                                "x_value": str(col_idx),
                                "y_value": str(cell or ""),
                                "series_label": f"row_{row_idx}",
                                "confidence": "",
                            })
    except Exception as exc:
        logger.warning("pdfplumber table extraction failed for %s: %s", pdf_path, exc)
        return None

    return (chart_rows, point_rows) if chart_rows else None


# ---------------------------------------------------------------------------
# L3 fallback: caption text
# ---------------------------------------------------------------------------


_CAPTION_RE = re.compile(
    r"(Fig(?:ure)?|Table)\s*\d+[\.:]\s*([^\n]{1,500})",
    re.IGNORECASE,
)


def _extract_captions_pdf(pdf_path: Path) -> list[str]:
    """Extract figure/table captions from a PDF's text layer."""
    try:
        import pdfplumber
    except ImportError:
        return []

    captions: list[str] = []
    try:
        with pdfplumber.open(str(pdf_path)) as pdf:
            for page in pdf.pages:
                text = page.extract_text() or ""
                for match in _CAPTION_RE.finditer(text):
                    captions.append(match.group(0).strip())
    except Exception as exc:
        logger.warning("caption extraction failed for %s: %s", pdf_path, exc)

    return captions


# ---------------------------------------------------------------------------
# Core extraction pipeline
# ---------------------------------------------------------------------------


async def _extract_from_image(
    image_path: Path,
    run_ctx: RunContext,
    source_label: str,
    chart_idx_offset: int,
    *,
    prompt: str = _VLM_PROMPT,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, Any]]:
    """Extract chart data from a single image file via Qwen-VL (L1).

    Returns ``(chart_rows, point_rows, meta)``. ``meta`` includes the
    source_asset_id, sha256, and whether the image was copied into
    figures/.

    The ``prompt`` parameter allows the caller to inject a hint-augmented
    prompt; it defaults to the bare ``_VLM_PROMPT``.
    """
    # Ensure the image is preserved under source_assets/figures/
    figures_path, sha, was_copied = _ensure_image_in_figures(
        image_path, run_ctx.work_dir
    )
    source_asset_id = f"asset_{sha}"

    # Register raw_asset provenance (if newly copied)
    if was_copied:
        run_ctx.add_raw_asset(str(figures_path))

    raw_response = await call_vl_model(
        figures_path,
        prompt,
        model_settings=run_ctx.model_settings,
    )
    chart_json = _parse_vlm_json(raw_response, source_label)

    chart_row, point_rows = _normalize_chart_json(
        chart_json,
        source_asset_id=source_asset_id,
        chart_idx=chart_idx_offset,
        source_label=source_label,
    )

    meta = {
        "source_asset_id": source_asset_id,
        "sha256": sha,
        "figures_path": str(figures_path),
        "was_copied": was_copied,
        "raw_vlm_response": raw_response,
    }
    return [chart_row], point_rows, meta


async def _extract_from_pdf(
    pdf_path: Path,
    run_ctx: RunContext,
    source_label: str,
    *,
    prompt: str = _VLM_PROMPT,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    """Extract chart data from a PDF: L1 (per-image VLM) → L2 (tables) → L3 (captions).

    Returns ``(chart_rows, point_rows, metas)``. Raises
    ``ChartExtractionError`` only if ALL three tiers fail.

    The ``prompt`` parameter allows the caller to inject a hint-augmented
    prompt for L1 VLM calls.
    """
    # Use the PDF's own sha256 as the source_asset_id (the PDF is the
    # original asset; individual page-images get their own shas in meta).
    pdf_sha = _sha256_file(pdf_path)
    source_asset_id = f"asset_{pdf_sha}"

    # Register the PDF itself as a raw_asset if not already
    run_ctx.add_raw_asset(str(pdf_path))

    metas: list[dict[str, Any]] = []
    chart_rows: list[dict[str, Any]] = []
    point_rows: list[dict[str, Any]] = []

    # ---- L1: extract images, run VLM on each -----------------------------
    l1_failed = False
    try:
        images = _extract_pdf_images(pdf_path, run_ctx.work_dir.download_tmp)
    except ChartExtractionError as exc:
        logger.warning("L1 PDF image extraction failed for %s: %s", pdf_path, exc)
        images = []
        l1_failed = True

    if images:
        for idx, img_path in enumerate(images, 1):
            try:
                rows, pts, meta = await _extract_from_image(
                    img_path, run_ctx,
                    source_label=f"{source_label} (page image {idx})",
                    chart_idx_offset=idx,
                    prompt=prompt,
                )
                # Override source_asset_id to the PDF-level id so the
                # chart traces back to the PDF, not just the page image.
                for row in rows:
                    row["source_asset_id"] = source_asset_id
                chart_rows.extend(rows)
                point_rows.extend(pts)
                metas.append(meta)
            except ChartExtractionError as exc:
                logger.warning(
                    "L1 VLM failed for %s image %d: %s", pdf_path, idx, exc
                )
                run_ctx.add_warning(
                    severity="warning",
                    message=f"L1 VLM failed for {pdf_path.name} image {idx}: {exc}",
                    source="extract_chart_data_vlm",
                )

    if chart_rows:
        return chart_rows, point_rows, metas

    # ---- L2: pdfplumber tables -------------------------------------------
    l2_result = _try_pdfplumber_tables(pdf_path, source_asset_id, source_label)
    if l2_result is not None:
        l2_chart_rows, l2_point_rows = l2_result
        run_ctx.add_warning(
            severity="info",
            message=(
                f"L1 VLM produced no charts for {pdf_path.name}; "
                f"L2 pdfplumber recovered {len(l2_chart_rows)} table(s)"
            ),
            source="extract_chart_data_vlm",
        )
        return l2_chart_rows, l2_point_rows, [{
            "source_asset_id": source_asset_id,
            "sha256": pdf_sha,
            "tier": "L2_pdfplumber_tables",
        }]

    # ---- L3: caption text ------------------------------------------------
    captions = _extract_captions_pdf(pdf_path)
    if captions:
        run_ctx.add_warning(
            severity="warning",
            message=(
                f"L1+L2 failed for {pdf_path.name}; L3 recovered "
                f"{len(captions)} caption(s): " + " | ".join(captions[:3])
            ),
            source="extract_chart_data_vlm",
        )
        # Record captions as a single "chart_unextracted" pseudo-chart so
        # the data is preserved in chart_data.csv rather than dropped.
        chart_id = f"chart_{pdf_sha[:20]}_captions"
        chart_rows.append({
            "chart_id": chart_id,
            "source_asset_id": source_asset_id,
            "chart_type": "caption_only",
            "title": f"Captions extracted from {pdf_path.name}",
            "x_label": "", "x_unit": "", "x_scale": "linear",
            "y_label": "", "y_unit": "", "y_scale": "linear",
            "data_point_count": len(captions),
            "legend": "",
            "extracted_at": datetime.now(UTC).isoformat(),
            "model_name": "pdfplumber_captions",
            "source_label": source_label,
        })
        for cap_idx, cap in enumerate(captions, 1):
            point_rows.append({
                "point_id": f"{chart_id}_c{cap_idx}",
                "chart_id": chart_id,
                "x_value": str(cap_idx),
                "y_value": cap,
                "series_label": "caption",
                "confidence": "",
            })
        return chart_rows, point_rows, [{
            "source_asset_id": source_asset_id,
            "sha256": pdf_sha,
            "tier": "L3_captions",
            "captions": captions,
        }]

    # ---- All tiers failed ------------------------------------------------
    if l1_failed:
        raise ChartExtractionError(
            f"All chart extraction tiers failed for {pdf_path} "
            "(L1 image extraction error, L2 no tables, L3 no captions)"
        )
    raise ChartExtractionError(
        f"All chart extraction tiers failed for {pdf_path} "
        f"(L1 no images extracted or all VLM calls failed, "
        f"L2 no tables, L3 no captions)"
    )


# ---------------------------------------------------------------------------
# Function tool
# ---------------------------------------------------------------------------


@function_tool(
    name_override="extract_chart_data_vlm",
    description_override=(
        "Extract structured chart data (chart_type, axes, data_points, legend) "
        "from a paper figure image or PDF using the Qwen-VL visual model. "
        "Accepts PNG/JPG/WEBP/GIF images (e.g., from capture_web_page) or "
        "PDF files (e.g., from download_supplementary). For PDFs, extracts "
        "embedded images and runs VLM on each (up to 10 per file). "
        "Writes chart_data.csv and chart_data_points.csv to "
        "parsed/chart_data/. Falls back to pdfplumber tables (L2) then "
        "caption text (L3) if VLM fails. Raises an error if all tiers fail."
    ),
)
async def extract_chart_data_vlm(
    ctx: RunContextWrapper[Any],
    source_path: str,
    hint: str = "",
) -> str:
    """Extract chart data from an image or PDF file.

    Args:
        source_path: Path to a PNG/JPG/WEBP/GIF image or a PDF file. Must
            be under the task work directory (typically
            ``source_assets/figures/`` for images or ``source_assets/``
            for PDFs).
        hint: Optional extraction hint (e.g., "scatter plot, log scale",
            "bar chart with error bars"). Appended to the VLM prompt to
            improve accuracy on ambiguous figures.

    Returns:
        JSON string with status, source_file, outputs (CSV paths),
        charts (list of chart summaries), and an optional warning.

    Raises:
        Tool returns JSON with an ``error`` field (does not raise) for
        recoverable failures; ``ChartExtractionError`` is caught and
        reported as error JSON. The Agent loop sees the error and can
        decide whether to retry with a different source.
    """
    run_ctx: RunContext = ctx.context
    path = Path(source_path)

    if not path.exists():
        return json.dumps({
            "status": "error",
            "error": f"source file not found: {source_path}",
            "source_file": Path(source_path).name,
        }, ensure_ascii=False)

    ext = path.suffix.lower()
    source_label = path.name

    # Build the prompt (with optional hint)
    prompt = _VLM_PROMPT
    if hint.strip():
        prompt = f"{_VLM_PROMPT}\n\nAdditional hint: {hint.strip()}"

    chart_rows: list[dict[str, Any]] = []
    point_rows: list[dict[str, Any]] = []
    metas: list[dict[str, Any]] = []

    try:
        if ext in _IMAGE_EXTENSIONS:
            rows, pts, meta = await _extract_from_image(
                path, run_ctx,
                source_label=source_label,
                chart_idx_offset=1,
                prompt=prompt,
            )
            chart_rows.extend(rows)
            point_rows.extend(pts)
            metas.append(meta)
        elif ext == _PDF_EXTENSION:
            rows, pts, img_metas = await _extract_from_pdf(
                path, run_ctx, source_label=source_label, prompt=prompt,
            )
            chart_rows.extend(rows)
            point_rows.extend(pts)
            metas.extend(img_metas)
        else:
            return json.dumps({
                "status": "error",
                "error": (
                    f"unsupported file type: {ext} "
                    f"(supported: {sorted(_IMAGE_EXTENSIONS | {_PDF_EXTENSION})})"
                ),
                "source_file": source_label,
            }, ensure_ascii=False)
    except ChartExtractionError as exc:
        run_ctx.log_query(
            str(path), "extract_chart_data_vlm", QueryStatus.FAILED, 0
        )
        run_ctx.add_warning(
            severity="error",
            message=f"chart extraction failed for {path.name}: {exc}",
            source="extract_chart_data_vlm",
        )
        return json.dumps({
            "status": "error",
            "error": str(exc),
            "source_file": source_label,
        }, ensure_ascii=False)
    except Exception as exc:
        logger.exception("unexpected error extracting chart data from %s", path)
        run_ctx.log_query(
            str(path), "extract_chart_data_vlm", QueryStatus.FAILED, 0
        )
        return json.dumps({
            "status": "error",
            "error": f"unexpected error: {exc}",
            "source_file": source_label,
        }, ensure_ascii=False)

    # Write CSV artifacts
    chart_data_dir = _chart_data_dir(run_ctx.work_dir)
    chart_csv, points_csv = _write_chart_csvs(
        chart_data_dir, chart_rows, point_rows
    )

    # Register parsed datasets
    run_ctx.parsed_datasets.append(str(chart_csv))
    run_ctx.parsed_datasets.append(str(points_csv))
    run_ctx.log_query(
        str(path), "extract_chart_data_vlm", QueryStatus.SUCCESS, len(chart_rows)
    )

    # Emit progress
    await run_ctx.emit_progress(
        stage=StageName.PROCESSING,
        kind="chart_data_extracted",
        current=len(chart_rows),
        total=len(chart_rows),
        detail={
            "source": "extract_chart_data_vlm",
            "source_file": source_label,
            "charts": len(chart_rows),
            "data_points": len(point_rows),
            "tiers_used": [m.get("tier", "L1_vlm") for m in metas],
        },
    )

    # Build response
    charts_summary = [
        {
            "chart_id": row["chart_id"],
            "chart_type": row["chart_type"],
            "data_point_count": row["data_point_count"],
            "source_asset_id": row["source_asset_id"],
        }
        for row in chart_rows
    ]

    response: dict[str, Any] = {
        "status": "ok",
        "source_file": source_label,
        "source_path": str(path),
        "outputs": [str(chart_csv), str(points_csv)],
        "charts": charts_summary,
        "total_charts": len(chart_rows),
        "total_data_points": len(point_rows),
        "metas": [
            {
                "source_asset_id": m.get("source_asset_id"),
                "sha256": m.get("sha256"),
                "tier": m.get("tier", "L1_vlm"),
                "was_copied": m.get("was_copied", False),
            }
            for m in metas
        ],
    }

    # Note any L2/L3 degradation in the response
    tiers_used = [m.get("tier", "L1_vlm") for m in metas]
    if any(t != "L1_vlm" for t in tiers_used):
        response["degradation"] = tiers_used

    return json.dumps(response, ensure_ascii=False)


# ---------------------------------------------------------------------------
# Skill registration
# ---------------------------------------------------------------------------


extract_chart_data_vlm_skill = SkillDef(
    name="extract_chart_data_vlm",
    category=SkillCategory.PROCESSING,
    description=(
        "Extract structured chart data (chart_type, axes, data_points) from "
        "paper figure images or PDFs using the Qwen-VL visual model. "
        "Accepts any acquired paper artifact: PNG screenshots from "
        "web_visual_capture, PDFs from download_supplementary, or standalone "
        "JPG/WEBP images. Three-tier degradation: L1 Qwen-VL → L2 pdfplumber "
        "tables → L3 caption text. Raises on full failure (no silent "
        "empty-data fallback)."
    ),
    instructions=(
        "Use extract_chart_data_vlm when you need structured data from a "
        "paper chart, plot, or figure that you've already acquired as a "
        "PNG/JPG image or PDF. Accepts outputs of capture_web_page, "
        "capture_page_section, and download_supplementary. The tool writes "
        "chart_data.csv and chart_data_points.csv under parsed/chart_data/. "
        "Do NOT use this for pure text extraction — use extract_pdf_tables "
        "for tables, extract_pdf_metadata for titles/authors/abstracts."
    ),
    tools=[extract_chart_data_vlm],
    supported_sources=["extract_chart_data_vlm", "vlm", "chart_extraction"],
    version="0.1.0",
)

skill_registry.register(extract_chart_data_vlm_skill)
