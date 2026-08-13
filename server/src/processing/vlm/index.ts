export {
  ChartExtractionError,
  CHART_DATA_COLUMNS,
  CHART_DATA_POINTS_COLUMNS,
  normalizeChartJson,
  parseVlmJson,
  VLM_PROMPT,
  type ChartPointRow,
  type ChartRow,
  type NormalizeChartOptions,
} from "./chart-json.js";
export {
  CHART_CSV_NAME,
  CHART_POINTS_CSV_NAME,
  validateChartData,
  validateChartExtraction,
  writeChartCsvs,
} from "./chart-csv.js";
export {
  createVlmClient,
  DEFAULT_DASHSCOPE_BASE_URL,
  encodeImageBase64,
  MAX_VLM_IMAGE_BYTES,
  VL_MODEL_NAME,
  type VlmClient,
  type VlmConfig,
} from "./vlm-client.js";
export {
  extractPdfImages,
  MAX_PDF_IMAGES_PER_FILE,
  type ExtractedPdfImage,
  type PdfImageExtraction,
} from "./pdf-images.js";
export {
  createVlmTools,
  ensureImageInFigures,
  resolveVlmConfig,
  sha256File,
  type EnsureFigureResult,
  type VlmChartMeta,
  type VlmChartSummary,
  type VlmResult,
  type VlmResultError,
  type VlmResultOk,
  type VlmToolHooks,
  type VlmTools,
  type VlmToolsConfig,
} from "./chart-extraction.js";
