export interface ToolLabel {
  verb: string;
  target: string;
  details?: string;
}

type ToolLabelFormatter = (args: Record<string, unknown> | null) => ToolLabel;

const TOOL_LABEL_MAP: Record<string, ToolLabelFormatter> = {
  // PubMed (legacy alias kept for replaying pre-Phase 2 events.jsonl)
  search_pubmed_adapter: (args) => searchLabel("PubMed", args),
  search_pubmed: (args) => searchLabel("PubMed", args),
  download_supplementary: (args) => ({
    verb: "阅读",
    target: args?.pmid ? `论文 PMID ${args.pmid}` : "论文",
    details: args?.suppl_kind ? `附件类型: ${String(args.suppl_kind)}` : undefined,
  }),
  // GEO
  search_geo: (args) => searchLabel("GEO", args),
  describe_geo: (args) => ({
    verb: "查看",
    target: args?.accession ? `GEO ${String(args.accession)}` : "GEO 数据集",
  }),
  list_geo_supplementary_files: (args) => ({
    verb: "列出",
    target: args?.accession ? `GEO ${args.accession} 补充文件` : "GEO 补充文件",
  }),
  download_geo: (args) => ({
    verb: "下载",
    target: args?.accession ? `GEO 数据集 ${args.accession}` : "GEO 数据集",
  }),
  download_geo_platform_annotation: (args) => ({
    verb: "下载",
    target: args?.gpl ? `GEO 平台注释 ${args.gpl}` : "GEO 平台注释",
  }),
  // GDC
  search_gdc: (args) => searchLabel("GDC", args),
  describe_gdc: (args) => ({
    verb: "查看",
    target: args?.project_id ? `GDC 项目 ${String(args.project_id)}` : "GDC 项目",
  }),
  download_gdc: () => ({
    verb: "下载",
    target: "GDC 数据文件",
  }),
  // Xena
  search_xena: (args) => searchLabel("Xena", args),
  download_xena: () => ({
    verb: "下载",
    target: "Xena 数据集",
  }),
  // PDB
  search_pdb: (args) => searchLabel("PDB", args),
  describe_pdb: (args) => ({
    verb: "查看",
    target: args?.pdb_id ? `PDB ${args.pdb_id}` : "PDB 结构",
  }),
  download_pdb: (args) => ({
    verb: "下载",
    target: args?.pdb_id ? `PDB ${args.pdb_id}` : "PDB 结构",
  }),
  // PubChem
  search_pubchem: (args) => searchLabel("PubChem", args),
  get_compound: (args) => ({
    verb: "获取",
    target: args?.cid ? `PubChem 化合物 CID ${args.cid}` : "PubChem 化合物",
  }),
  download_pubchem: (args) => ({
    verb: "下载",
    target: args?.cid ? `PubChem 结构 CID ${args.cid}` : "PubChem 结构",
  }),
  // Reactome
  search_reactome: (args) => searchLabel("Reactome", args),
  get_pathway: (args) => ({
    verb: "获取",
    target: args?.pathway_id ? `Reactome 通路 ${args.pathway_id}` : "Reactome 通路",
  }),
  download_reactome: (args) => ({
    verb: "下载",
    target: args?.pathway_id ? `Reactome 通路 ${args.pathway_id}` : "Reactome 通路",
  }),
  // ChEMBL / UniProt / literature understanding
  search_chembl: (args) => searchLabel("ChEMBL", args),
  search_uniprot: (args) => searchLabel("UniProt", args),
  analyze_papers: () => ({ verb: "分析", target: "论文标题" }),
  // Browser fallback / visual capture
  navigate_page: (args) => ({
    verb: "浏览",
    target: "网页",
    details: args?.url ? String(args.url) : undefined,
  }),
  download_from_page: (args) => ({
    verb: "下载",
    target: "网页文件",
    details: args?.url ? String(args.url) : undefined,
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
  // Local cache
  search_local_cache: (args) => searchLabel("本地缓存", args),
  describe_local_cache: () => ({ verb: "查看", target: "缓存数据集" }),
  get_cache_dataset: () => ({ verb: "读取", target: "缓存数据" }),
  // PDF / chart extraction
  extract_pdf_tables: (args) => ({
    verb: "提取",
    target: "PDF 表格",
    details: args?.file_path ? String(args.file_path) : undefined,
  }),
  extract_pdf_metadata: (args) => ({
    verb: "提取",
    target: "PDF 元数据",
    details: args?.file_path ? String(args.file_path) : undefined,
  }),
  extract_chart_data_vlm: (args) => ({
    verb: "提取",
    target: "图表数据",
    details: args?.image_path ? String(args.image_path) : undefined,
  }),
  // Statistical analysis
  run_differential_expression: () => ({ verb: "计算", target: "差异表达" }),
  generate_heatmap: () => ({ verb: "生成", target: "热图" }),
  basic_statistics: () => ({ verb: "计算", target: "描述统计" }),
  generate_correlation_matrix: () => ({ verb: "计算", target: "相关性矩阵" }),
  // Research-data strategy SOP
  get_research_data_guidance: (args) => ({
    verb: "加载",
    target: args?.topic ? `科研策略指导 ${args.topic}` : "科研策略指导",
  }),
  // Legacy pipeline / import tools (unchanged)
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
};

function searchLabel(
  target: string,
  args: Record<string, unknown> | null,
): ToolLabel {
  return {
    verb: "检索",
    target,
    details: args?.query ? `查询: "${String(args.query)}"` : undefined,
  };
}

export function formatToolCall(
  toolName: string,
  args: Record<string, unknown> | null,
): ToolLabel {
  const formatter = TOOL_LABEL_MAP[toolName];
  if (formatter) return formatter(args);
  return { verb: "调用", target: toolName };
}
