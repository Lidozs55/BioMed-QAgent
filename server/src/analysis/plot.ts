/**
 * PNG rendering for the analysis tools via pngjs (P5-09 analysis).
 *
 * No pixel-level parity with matplotlib is attempted (P5-09 explicitly
 * allows this); the requirement is that ON-PLOT values and labels match:
 *   - volcano: log2FC x-axis, -log10(p) y-axis, threshold lines at
 *     +/-log2fc_threshold and -log10(pval_threshold), grey/red/blue series
 *     with the Python counts, top_n gene labels;
 *   - heatmap: per-row z-scores when zscore=True, RdBu_r-like colormap,
 *     clustering order from scipy-parity UPGMA, gene/sample labels;
 *   - correlation: coolwarm-like colormap, vmin=-1/vmax=1, annotated values.
 *
 * Layouts are fully deterministic and exported (volcanoLayout /
 * heatmapLayout / correlationLayout) so tests can compute exact pixel
 * positions for color assertions.
 *
 * Text is drawn with an embedded 5x7 bitmap font (ASCII subset; unknown
 * glyphs render as '?'). Titles use ASCII spellings ("log2 Fold Change")
 * instead of matplotlib's unicode subscripts.
 */

import { PNG } from "pngjs";

import { colormapBytes, type ColormapName } from "./colormaps.js";

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Matplotlib named colors used by the Python volcano plot.
export const COLOR_GREY: readonly [number, number, number] = [128, 128, 128]; // 0.50196
export const COLOR_RED: readonly [number, number, number] = [255, 0, 0];
export const COLOR_BLUE: readonly [number, number, number] = [0, 0, 255];
export const COLOR_BLACK: readonly [number, number, number] = [0, 0, 0];
export const COLOR_WHITE: readonly [number, number, number] = [255, 255, 255];

// ---------------------------------------------------------------------------
// 5x7 bitmap font (bit 4 = leftmost column)
// ---------------------------------------------------------------------------

const FONT: Readonly<Record<string, readonly number[]>> = {
  " ": [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
  "!": [0x04, 0x04, 0x04, 0x04, 0x04, 0x00, 0x04],
  "(": [0x02, 0x04, 0x08, 0x08, 0x08, 0x04, 0x02],
  ")": [0x08, 0x04, 0x02, 0x02, 0x02, 0x04, 0x08],
  "*": [0x00, 0x15, 0x0e, 0x1f, 0x0e, 0x15, 0x00],
  "+": [0x00, 0x04, 0x04, 0x1f, 0x04, 0x04, 0x00],
  ",": [0x00, 0x00, 0x00, 0x00, 0x06, 0x04, 0x08],
  "-": [0x00, 0x00, 0x00, 0x1f, 0x00, 0x00, 0x00],
  ".": [0x00, 0x00, 0x00, 0x00, 0x00, 0x0c, 0x0c],
  "/": [0x01, 0x02, 0x02, 0x04, 0x08, 0x08, 0x10],
  "0": [0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e],
  "1": [0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e],
  "2": [0x0e, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1f],
  "3": [0x1f, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0e],
  "4": [0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02],
  "5": [0x1f, 0x10, 0x1e, 0x01, 0x01, 0x11, 0x0e],
  "6": [0x06, 0x08, 0x10, 0x1e, 0x11, 0x11, 0x0e],
  "7": [0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
  "8": [0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e],
  "9": [0x0e, 0x11, 0x11, 0x0f, 0x01, 0x02, 0x0c],
  ":": [0x00, 0x0c, 0x0c, 0x00, 0x0c, 0x0c, 0x00],
  ";": [0x00, 0x0c, 0x0c, 0x00, 0x0c, 0x04, 0x08],
  "<": [0x02, 0x04, 0x08, 0x10, 0x08, 0x04, 0x02],
  "=": [0x00, 0x00, 0x1f, 0x00, 0x1f, 0x00, 0x00],
  ">": [0x08, 0x04, 0x02, 0x01, 0x02, 0x04, 0x08],
  "?": [0x0e, 0x11, 0x01, 0x02, 0x04, 0x00, 0x04],
  "%": [0x19, 0x1a, 0x02, 0x04, 0x08, 0x0b, 0x13],
  A: [0x0e, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  B: [0x1e, 0x11, 0x11, 0x1e, 0x11, 0x11, 0x1e],
  C: [0x0e, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0e],
  D: [0x1e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x1e],
  E: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x1f],
  F: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x10],
  G: [0x0e, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0f],
  H: [0x11, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  I: [0x0e, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0e],
  J: [0x07, 0x02, 0x02, 0x02, 0x02, 0x12, 0x0c],
  K: [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11],
  L: [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1f],
  M: [0x11, 0x1b, 0x15, 0x15, 0x11, 0x11, 0x11],
  N: [0x11, 0x19, 0x15, 0x13, 0x11, 0x11, 0x11],
  O: [0x0e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  P: [0x1e, 0x11, 0x11, 0x1e, 0x10, 0x10, 0x10],
  Q: [0x0e, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0d],
  R: [0x1e, 0x11, 0x11, 0x1e, 0x14, 0x12, 0x11],
  S: [0x0f, 0x10, 0x10, 0x0e, 0x01, 0x01, 0x1e],
  T: [0x1f, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
  U: [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  V: [0x11, 0x11, 0x11, 0x11, 0x11, 0x0a, 0x04],
  W: [0x11, 0x11, 0x11, 0x15, 0x15, 0x15, 0x0a],
  X: [0x11, 0x11, 0x0a, 0x04, 0x0a, 0x11, 0x11],
  Y: [0x11, 0x11, 0x0a, 0x04, 0x04, 0x04, 0x04],
  Z: [0x1f, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1f],
  _: [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x1f],
  "|": [0x04, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
  a: [0x00, 0x00, 0x0e, 0x01, 0x0f, 0x11, 0x0f],
  b: [0x10, 0x10, 0x16, 0x19, 0x11, 0x11, 0x1e],
  c: [0x00, 0x00, 0x0e, 0x10, 0x10, 0x11, 0x0e],
  d: [0x01, 0x01, 0x0d, 0x13, 0x11, 0x11, 0x0f],
  e: [0x00, 0x00, 0x0e, 0x11, 0x1f, 0x10, 0x0e],
  f: [0x06, 0x09, 0x08, 0x1c, 0x08, 0x08, 0x08],
  g: [0x00, 0x0f, 0x11, 0x11, 0x0f, 0x01, 0x0e],
  h: [0x10, 0x10, 0x16, 0x19, 0x11, 0x11, 0x11],
  i: [0x04, 0x00, 0x0c, 0x04, 0x04, 0x04, 0x0e],
  j: [0x02, 0x00, 0x06, 0x02, 0x02, 0x12, 0x0c],
  k: [0x10, 0x10, 0x12, 0x14, 0x18, 0x14, 0x12],
  l: [0x0c, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0e],
  m: [0x00, 0x00, 0x1a, 0x15, 0x15, 0x15, 0x15],
  n: [0x00, 0x00, 0x16, 0x19, 0x11, 0x11, 0x11],
  o: [0x00, 0x00, 0x0e, 0x11, 0x11, 0x11, 0x0e],
  p: [0x00, 0x00, 0x1e, 0x11, 0x1e, 0x10, 0x10],
  q: [0x00, 0x00, 0x0d, 0x13, 0x0f, 0x01, 0x01],
  r: [0x00, 0x00, 0x16, 0x19, 0x10, 0x10, 0x10],
  s: [0x00, 0x00, 0x0f, 0x10, 0x0e, 0x01, 0x1e],
  t: [0x08, 0x08, 0x1c, 0x08, 0x08, 0x09, 0x06],
  u: [0x00, 0x00, 0x11, 0x11, 0x11, 0x13, 0x0d],
  v: [0x00, 0x00, 0x11, 0x11, 0x11, 0x0a, 0x04],
  w: [0x00, 0x00, 0x11, 0x15, 0x15, 0x15, 0x0a],
  x: [0x00, 0x00, 0x11, 0x0a, 0x04, 0x0a, 0x11],
  y: [0x00, 0x00, 0x11, 0x11, 0x0f, 0x01, 0x0e],
  z: [0x00, 0x00, 0x1f, 0x02, 0x04, 0x08, 0x1f],
};

const GLYPH_WIDTH = 5;
const GLYPH_HEIGHT = 7;
const CHAR_STEP = 6; // 5px glyph + 1px spacing

/** Rendered text width in pixels for the given scale. */
export function textWidth(text: string, scale = 1): number {
  return text.length * CHAR_STEP * scale;
}

/** Rendered text height in pixels for the given scale. */
export function textHeight(scale = 1): number {
  return GLYPH_HEIGHT * scale;
}

// ---------------------------------------------------------------------------
// Drawing primitives
// ---------------------------------------------------------------------------

export interface Canvas {
  data: Buffer;
  width: number;
  height: number;
}

export function createCanvas(width: number, height: number): Canvas {
  const data = Buffer.alloc(width * height * 4);
  data.fill(255); // white background, opaque
  return { data, width, height };
}

export function encodePng(canvas: Canvas): Buffer {
  const png = new PNG({ width: canvas.width, height: canvas.height });
  png.data = canvas.data;
  // The ambient pngjs typings (src/processing/vlm/pngjs.d.ts) type
  // sync.write as Uint8Array; at runtime it returns the Buffer we need.
  return Buffer.from(PNG.sync.write(png));
}

export function setPixel(
  canvas: Canvas,
  x: number,
  y: number,
  color: readonly number[],
): void {
  if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return;
  const offset = (y * canvas.width + x) * 4;
  canvas.data[offset] = color[0];
  canvas.data[offset + 1] = color[1];
  canvas.data[offset + 2] = color[2];
  canvas.data[offset + 3] = 255;
}

export function getPixel(
  canvas: Canvas,
  x: number,
  y: number,
): [number, number, number, number] {
  const offset = (y * canvas.width + x) * 4;
  return [
    canvas.data[offset],
    canvas.data[offset + 1],
    canvas.data[offset + 2],
    canvas.data[offset + 3],
  ];
}

export function fillRect(
  canvas: Canvas,
  x: number,
  y: number,
  width: number,
  height: number,
  color: readonly number[],
): void {
  for (let yy = y; yy < y + height; yy += 1) {
    for (let xx = x; xx < x + width; xx += 1) {
      setPixel(canvas, xx, yy, color);
    }
  }
}

function drawLine(
  canvas: Canvas,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  color: readonly number[],
): void {
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  let x = x0;
  let y = y0;
  for (;;) {
    setPixel(canvas, x, y, color);
    if (x === x1 && y === y1) break;
    const twice = 2 * err;
    if (twice >= dy) {
      err += dy;
      x += sx;
    }
    if (twice <= dx) {
      err += dx;
      y += sy;
    }
  }
}

export function fillCircle(
  canvas: Canvas,
  cx: number,
  cy: number,
  radius: number,
  color: readonly number[],
): void {
  for (let y = cy - radius; y <= cy + radius; y += 1) {
    for (let x = cx - radius; x <= cx + radius; x += 1) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= radius * radius) setPixel(canvas, x, y, color);
    }
  }
}

export function drawText(
  canvas: Canvas,
  x: number,
  y: number,
  text: string,
  color: readonly number[],
  scale = 1,
): void {
  let cursor = x;
  for (const ch of text) {
    const glyph = FONT[ch] ?? FONT["?"];
    for (let row = 0; row < GLYPH_HEIGHT; row += 1) {
      const bits = glyph[row];
      for (let col = 0; col < GLYPH_WIDTH; col += 1) {
        if ((bits & (1 << (GLYPH_WIDTH - 1 - col))) !== 0) {
          if (scale === 1) {
            setPixel(canvas, cursor + col, y + row, color);
          } else {
            fillRect(canvas, cursor + col * scale, y + row * scale, scale, scale, color);
          }
        }
      }
    }
    cursor += CHAR_STEP * scale;
  }
}

// ---------------------------------------------------------------------------
// Volcano plot
// ---------------------------------------------------------------------------

export interface VolcanoPoint {
  x: number; // log2FC
  y: number; // -log10(pvalue)
  gene: string;
  category: "ns" | "up" | "down";
}

export interface VolcanoLayout {
  width: number;
  height: number;
  left: number;
  top: number;
  plotWidth: number;
  plotHeight: number;
  xmin: number;
  xmax: number;
  ymin: number;
  ymax: number;
  toPixel(x: number, y: number): { px: number; py: number };
}

export const VOLCANO_WIDTH = 1000;
export const VOLCANO_HEIGHT = 700;
const VOLCANO_LEFT = 80;
const VOLCANO_TOP = 70;
const VOLCANO_RIGHT = 30;
const VOLCANO_BOTTOM = 70;

export function volcanoLayout(
  points: readonly VolcanoPoint[],
): VolcanoLayout {
  let minX = 0;
  let maxX = 0;
  let maxY = 0;
  for (const point of points) {
    if (point.x < minX) minX = point.x;
    if (point.x > maxX) maxX = point.x;
    if (point.y > maxY) maxY = point.y;
  }
  const xPad = 0.05 * Math.max(maxX - minX, 0.5);
  const xmin = minX - xPad;
  const xmax = maxX + xPad;
  const ymin = 0;
  const ymax = Math.max(maxY * 1.05, 1);
  const plotWidth = VOLCANO_WIDTH - VOLCANO_LEFT - VOLCANO_RIGHT;
  const plotHeight = VOLCANO_HEIGHT - VOLCANO_TOP - VOLCANO_BOTTOM;
  return {
    width: VOLCANO_WIDTH,
    height: VOLCANO_HEIGHT,
    left: VOLCANO_LEFT,
    top: VOLCANO_TOP,
    plotWidth,
    plotHeight,
    xmin,
    xmax,
    ymin,
    ymax,
    toPixel(x, y) {
      return {
        px: Math.round(this.left + ((x - this.xmin) / (this.xmax - this.xmin)) * this.plotWidth),
        py: Math.round(this.top + ((this.ymax - y) / (this.ymax - this.ymin)) * this.plotHeight),
      };
    },
  };
}

export interface VolcanoRenderOptions {
  points: VolcanoPoint[];
  pvalThreshold: number;
  log2fcThreshold: number;
  significantUp: number;
  significantDown: number;
  /** Gene labels for the top_n DEGs (drawn next to their points). */
  labels: readonly { x: number; y: number; text: string }[];
}

export function renderVolcano(options: VolcanoRenderOptions): Buffer {
  const { points, pvalThreshold, log2fcThreshold, significantUp, significantDown } = options;
  const layout = volcanoLayout(points);
  const canvas = createCanvas(layout.width, layout.height);

  // Threshold lines (matplotlib grey).
  const hlineY = layout.toPixel(0, -Math.log10(Math.max(pvalThreshold, 1e-300))).py;
  const vlinePx = layout.toPixel(log2fcThreshold, 0).px;
  const vlineNx = layout.toPixel(-log2fcThreshold, 0).px;
  drawLine(canvas, layout.left, hlineY, layout.left + layout.plotWidth, hlineY, COLOR_GREY);
  drawLine(canvas, vlinePx, layout.top, vlinePx, layout.top + layout.plotHeight, COLOR_GREY);
  drawLine(canvas, vlineNx, layout.top, vlineNx, layout.top + layout.plotHeight, COLOR_GREY);

  // Series: ns (grey, r=3), up (red, r=4), down (blue, r=4).
  for (const point of points) {
    const { px, py } = layout.toPixel(point.x, point.y);
    if (point.category === "up") fillCircle(canvas, px, py, 4, COLOR_RED);
    else if (point.category === "down") fillCircle(canvas, px, py, 4, COLOR_BLUE);
    else fillCircle(canvas, px, py, 3, COLOR_GREY);
  }

  // Top_n gene labels.
  for (const label of options.labels) {
    const { px, py } = layout.toPixel(label.x, label.y);
    drawText(canvas, px + 5, py - 7, label.text, COLOR_BLACK, 1);
  }

  // Title (two lines, like the Python plot).
  drawText(canvas, Math.floor((layout.width - textWidth("Volcano Plot", 2)) / 2), 12,
    "Volcano Plot", COLOR_BLACK, 2);
  const subtitle =
    `Up: ${significantUp} | Down: ${significantDown} (p < ${pvalThreshold}, |log2FC| > ${log2fcThreshold})`;
  drawText(canvas, Math.floor((layout.width - textWidth(subtitle)) / 2), 40,
    subtitle, COLOR_BLACK, 1);

  // Axis labels.
  drawText(canvas, 8, layout.top + 12, "-log10(p-value)", COLOR_BLACK, 1);
  const xLabel = "log2 Fold Change";
  drawText(canvas, Math.floor((layout.width - textWidth(xLabel)) / 2),
    layout.height - 26, xLabel, COLOR_BLACK, 1);

  // Legend (top right of the plot area).
  const legendX = layout.left + layout.plotWidth - 130;
  let legendY = layout.top + 8;
  fillCircle(canvas, legendX + 3, legendY + 3, 3, COLOR_GREY);
  drawText(canvas, legendX + 10, legendY, "NS", COLOR_BLACK, 1);
  legendY += 12;
  fillCircle(canvas, legendX + 3, legendY + 3, 3, COLOR_RED);
  drawText(canvas, legendX + 10, legendY, `Up (${significantUp})`, COLOR_BLACK, 1);
  legendY += 12;
  fillCircle(canvas, legendX + 3, legendY + 3, 3, COLOR_BLUE);
  drawText(canvas, legendX + 10, legendY, `Down (${significantDown})`, COLOR_BLACK, 1);

  return encodePng(canvas);
}

// ---------------------------------------------------------------------------
// Heatmap
// ---------------------------------------------------------------------------

export interface HeatmapLayout {
  width: number;
  height: number;
  cellSize: number;
  originX: number;
  originY: number;
  cellCenter(row: number, col: number): { px: number; py: number };
}

const HEATMAP_CELL = 26;

export function heatmapLayout(
  rowCount: number,
  colCount: number,
  rowLabels: readonly string[],
  colLabels: readonly string[],
): HeatmapLayout {
  const longestRowLabel = rowLabels.reduce((m, l) => Math.max(m, l.length), 0);
  const longestColLabel = colLabels.reduce((m, l) => Math.max(m, l.length), 0);
  const left = 14 + longestRowLabel * CHAR_STEP;
  const top = 52;
  const bottom = 20 + longestColLabel * CHAR_STEP + 14;
  const width = left + colCount * HEATMAP_CELL + 24;
  const height = top + rowCount * HEATMAP_CELL + bottom;
  return {
    width,
    height,
    cellSize: HEATMAP_CELL,
    originX: left,
    originY: top,
    cellCenter(row, col) {
      return {
        px: this.originX + col * this.cellSize + Math.floor(this.cellSize / 2),
        py: this.originY + row * this.cellSize + Math.floor(this.cellSize / 2),
      };
    },
  };
}

export interface HeatmapRenderOptions {
  /** Values in display order (rows/cols pre-clustered by the caller). */
  matrix: readonly (readonly number[])[];
  rowLabels: readonly string[];
  colLabels: readonly string[];
  cmap: ColormapName;
  zscore: boolean;
}

export function renderHeatmap(options: HeatmapRenderOptions): Buffer {
  const { matrix, rowLabels, colLabels, cmap, zscore } = options;
  const layout = heatmapLayout(matrix.length, matrix[0]?.length ?? 0, rowLabels, colLabels);
  const canvas = createCanvas(layout.width, layout.height);

  // Global min/max normalization (seaborn default: no center, no robust).
  let vmin = Number.POSITIVE_INFINITY;
  let vmax = Number.NEGATIVE_INFINITY;
  for (const row of matrix) {
    for (const value of row) {
      if (!Number.isFinite(value)) continue;
      if (value < vmin) vmin = value;
      if (value > vmax) vmax = value;
    }
  }
  const range = vmax - vmin;

  for (let r = 0; r < matrix.length; r += 1) {
    for (let c = 0; c < matrix[r].length; c += 1) {
      const value = matrix[r][c];
      let color: readonly number[] = COLOR_WHITE;
      if (Number.isFinite(value)) {
        const t = range > 0 ? (value - vmin) / range : 0.5;
        color = colormapBytes(cmap, t);
      }
      fillRect(canvas, layout.originX + c * layout.cellSize,
        layout.originY + r * layout.cellSize, layout.cellSize, layout.cellSize, color);
    }
  }

  // Row labels (gene names, right-aligned) — drawn when rows <= 80 like Python.
  if (rowLabels.length <= 80) {
    rowLabels.forEach((label, r) => {
      const width = textWidth(label);
      drawText(canvas, layout.originX - 8 - width,
        layout.originY + r * layout.cellSize + 9, label, COLOR_BLACK, 1);
    });
  }
  // Column labels (sample names, centered).
  colLabels.forEach((label, c) => {
    drawText(canvas,
      layout.originX + c * layout.cellSize + Math.floor((layout.cellSize - textWidth(label)) / 2),
      layout.originY + matrix.length * layout.cellSize + 4, label, COLOR_BLACK, 1);
  });

  const title = `Clustered Heatmap${zscore ? " (Z-score normalized)" : ""}`;
  drawText(canvas, Math.floor((layout.width - textWidth(title, 2)) / 2), 10, title, COLOR_BLACK, 2);
  drawText(canvas, 8, layout.originY + 12, "Genes", COLOR_BLACK, 1);
  const xLabel = "Samples";
  drawText(canvas, Math.floor((layout.width - textWidth(xLabel)) / 2),
    layout.height - 12, xLabel, COLOR_BLACK, 1);

  return encodePng(canvas);
}

// ---------------------------------------------------------------------------
// Correlation matrix
// ---------------------------------------------------------------------------

export interface CorrelationLayout {
  width: number;
  height: number;
  cellSize: number;
  originX: number;
  originY: number;
  cellCenter(row: number, col: number): { px: number; py: number };
}

const CORR_CELL = 52;

export function correlationLayout(
  count: number,
  labels: readonly string[],
): CorrelationLayout {
  const longest = labels.reduce((m, l) => Math.max(m, l.length), 0);
  const left = 14 + longest * CHAR_STEP;
  const top = 52;
  const bottom = 20 + longest * CHAR_STEP + 14;
  return {
    width: left + count * CORR_CELL + 24,
    height: top + count * CORR_CELL + bottom,
    cellSize: CORR_CELL,
    originX: left,
    originY: top,
    cellCenter(row, col) {
      return {
        px: this.originX + col * this.cellSize + Math.floor(this.cellSize / 2),
        py: this.originY + row * this.cellSize + Math.floor(this.cellSize / 2),
      };
    },
  };
}

export interface CorrelationRenderOptions {
  values: readonly (readonly number[])[];
  labels: readonly string[];
  method: string;
  cmap: ColormapName;
}

/** Python format(v, ".2f") equivalent for the annotations. */
function format2(value: number): string {
  return value.toFixed(2);
}

export function renderCorrelation(options: CorrelationRenderOptions): Buffer {
  const { values, labels, method, cmap } = options;
  const count = values.length;
  const layout = correlationLayout(count, labels);
  const canvas = createCanvas(layout.width, layout.height);
  const annotate = count <= 20; // seaborn: annot=(len <= 20)

  for (let i = 0; i < count; i += 1) {
    for (let j = 0; j < count; j += 1) {
      const x = layout.originX + j * layout.cellSize;
      const y = layout.originY + i * layout.cellSize;
      // Upper triangle masked (np.triu k=1): plain axes background (white).
      if (j > i) {
        fillRect(canvas, x, y, layout.cellSize, layout.cellSize, COLOR_WHITE);
        continue;
      }
      const value = values[i][j];
      let color: readonly number[] = COLOR_WHITE;
      if (Number.isFinite(value)) {
        // seaborn: vmin=-1, vmax=1, center=0.
        color = colormapBytes(cmap, (value + 1) / 2);
      }
      fillRect(canvas, x, y, layout.cellSize, layout.cellSize, color);
      if (annotate && Number.isFinite(value)) {
        const text = format2(value);
        const { px, py } = layout.cellCenter(i, j);
        drawText(canvas, px - Math.floor(textWidth(text) / 2), py - 3, text, COLOR_BLACK, 1);
      }
    }
  }

  // Diagonal + lower labels.
  labels.forEach((label, k) => {
    const width = textWidth(label);
    // Bottom labels (columns).
    drawText(canvas, layout.originX + k * layout.cellSize +
      Math.floor((layout.cellSize - width) / 2),
      layout.originY + count * layout.cellSize + 4, label, COLOR_BLACK, 1);
    // Left labels (rows).
    drawText(canvas, layout.originX - 8 - width,
      layout.originY + k * layout.cellSize + 18, label, COLOR_BLACK, 1);
  });

  const title = `${method.charAt(0).toUpperCase() + method.slice(1)} Correlation Matrix (${count} variables)`;
  drawText(canvas, Math.floor((layout.width - textWidth(title, 2)) / 2), 10, title, COLOR_BLACK, 2);

  return encodePng(canvas);
}
