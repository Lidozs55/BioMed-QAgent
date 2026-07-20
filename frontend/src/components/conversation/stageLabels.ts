import type { StageName } from "@/runtime/contracts";

export const STAGE_LABELS: Record<StageName, string> = {
  discovery: "文献/数据发现",
  acquisition: "数据获取",
  processing: "数据处理",
  artifact_build: "产物构建",
  validation: "结果验证",
};

export const PROGRESS_LABELS: Record<string, string> = {
  discovered_records: "已发现记录",
  downloaded_bytes: "已下载",
  downloaded_records: "已下载记录",
  parsed: "已解析",
  cleaned_rows: "已清洗行数",
};
