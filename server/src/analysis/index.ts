/**
 * Analysis capability tier (P5-09): statistical primitives + deterministic
 * PNG rendering mirroring the Python analysis tools
 * (backend/app/skills/builtin/analysis/stats.py) with scipy/pandas parity.
 */

export { betainc, lgamma, studentTTwoSidedSurvival } from "./ibeta.js";
export { welchTTest, type WelchResult } from "./welch.js";
export { bhAdjust } from "./bh.js";
export {
  columnIndex,
  parseCsv,
  type ParsedTable,
} from "./csv.js";
export {
  describeColumn,
  pyFloatStr,
  pyRound,
  safeFloat,
  type ColumnStats,
} from "./stats.js";
export {
  correlationMatrix,
  type CorrelationMethod,
} from "./correlation.js";
export {
  euclideanDistance,
  leavesOrder,
  linkageAverage,
  type LinkageRow,
} from "./clustering.js";
export {
  colormap,
  colormapBytes,
  type ColormapName,
} from "./colormaps.js";
export {
  COLOR_BLACK,
  COLOR_BLUE,
  COLOR_GREY,
  COLOR_RED,
  COLOR_WHITE,
  createCanvas,
  drawText,
  encodePng,
  getPixel,
  PNG_SIGNATURE,
  correlationLayout,
  heatmapLayout,
  renderCorrelation,
  renderHeatmap,
  renderVolcano,
  setPixel,
  textHeight,
  textWidth,
  volcanoLayout,
  type CorrelationRenderOptions,
  type HeatmapRenderOptions,
  type VolcanoPoint,
  type VolcanoRenderOptions,
} from "./plot.js";
