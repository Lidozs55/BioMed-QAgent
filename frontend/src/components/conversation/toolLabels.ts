export interface ToolLabel {
  verb: string;
  target: string;
  details?: string;
}

type ToolLabelFormatter = (args: Record<string, unknown> | null) => ToolLabel;

const TOOL_LABEL_MAP: Record<string, ToolLabelFormatter> = {
  search_pubmed_adapter: (args) => ({
    verb: "检索",
    target: "PubMed",
    details: args?.query ? `查询: "${String(args.query)}"` : undefined,
  }),
  download_supplementary: (args) => ({
    verb: "阅读",
    target: args?.pmid ? `论文 PMID ${args.pmid}` : "论文",
    details: args?.suppl_kind ? `附件类型: ${String(args.suppl_kind)}` : undefined,
  }),
  download_geo: (args) => ({
    verb: "下载",
    target: args?.accession ? `GEO 数据集 ${args.accession}` : "GEO 数据集",
  }),
  parse_excel: (args) => ({
    verb: "解析",
    target: "Excel 文件",
    details: args?.file_path ? String(args.file_path) : undefined,
  }),
  parse_pdf: (args) => ({
    verb: "解析",
    target: "PDF 文件",
    details: args?.file_path ? String(args.file_path) : undefined,
  }),
  parse_cache_export_zip: () => ({ verb: "解析", target: "缓存包 ZIP" }),
  run_research_pipeline: () => ({ verb: "启动", target: "研究流水线" }),
  review_query_strategy: () => ({ verb: "审查", target: "查询策略" }),
  commit_to_cache: () => ({ verb: "导入", target: "缓存" }),
  extract_chart_data_vlm: (args) => ({
    verb: "提取",
    target: "图表数据",
    details: args?.image_path ? String(args.image_path) : undefined,
  }),
  capture_web_page: (args) => ({
    verb: "采集",
    target: "网页截图",
    details: args?.url ? String(args.url) : undefined,
  }),
  capture_page_section: (args) => ({
    verb: "采集",
    target: "网页区域截图",
    details: args?.url ? String(args.url) : undefined,
  }),
  find_skill: () => ({ verb: "检索", target: "技能" }),
  invoke_skill: (args) => ({
    verb: "调用",
    target: args?.skill ? String(args.skill) : "技能",
  }),
};

export function formatToolCall(
  toolName: string,
  args: Record<string, unknown> | null,
): ToolLabel {
  const formatter = TOOL_LABEL_MAP[toolName];
  if (formatter) return formatter(args);
  return { verb: "调用", target: toolName };
}
