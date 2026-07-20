import { describe, expect, it } from "vitest";

import { formatToolCall } from "@/components/conversation/toolLabels";

describe("formatToolCall", () => {
  it("maps search_pubmed_adapter with query details", () => {
    const label = formatToolCall("search_pubmed_adapter", {
      query: "lung cancer",
    });
    expect(label).toEqual({
      verb: "检索",
      target: "PubMed",
      details: '查询: "lung cancer"',
    });
  });

  it("maps search_pubmed_adapter without args (null degrades gracefully)", () => {
    const label = formatToolCall("search_pubmed_adapter", null);
    expect(label).toEqual({
      verb: "检索",
      target: "PubMed",
      details: undefined,
    });
  });

  it("maps download_supplementary with pmid and suppl_kind", () => {
    const label = formatToolCall("download_supplementary", {
      pmid: "12345",
      suppl_kind: "excel",
    });
    expect(label).toEqual({
      verb: "阅读",
      target: "论文 PMID 12345",
      details: "附件类型: excel",
    });
  });

  it("maps download_supplementary without args (falls back to '论文')", () => {
    const label = formatToolCall("download_supplementary", null);
    expect(label).toEqual({
      verb: "阅读",
      target: "论文",
      details: undefined,
    });
  });

  it("maps download_geo with accession", () => {
    const label = formatToolCall("download_geo", { accession: "GSE178352" });
    expect(label).toEqual({
      verb: "下载",
      target: "GEO 数据集 GSE178352",
    });
  });

  it("maps parse_excel with file_path details", () => {
    const label = formatToolCall("parse_excel", {
      file_path: "/tmp/data.xlsx",
    });
    expect(label).toEqual({
      verb: "解析",
      target: "Excel 文件",
      details: "/tmp/data.xlsx",
    });
  });

  it("maps parse_pdf with file_path details", () => {
    const label = formatToolCall("parse_pdf", { file_path: "/tmp/paper.pdf" });
    expect(label).toEqual({
      verb: "解析",
      target: "PDF 文件",
      details: "/tmp/paper.pdf",
    });
  });

  it("maps parse_cache_export_zip without details", () => {
    const label = formatToolCall("parse_cache_export_zip", null);
    expect(label).toEqual({
      verb: "解析",
      target: "缓存包 ZIP",
    });
  });

  it("maps run_research_pipeline", () => {
    const label = formatToolCall("run_research_pipeline", null);
    expect(label).toEqual({
      verb: "启动",
      target: "研究流水线",
    });
  });

  it("maps review_query_strategy", () => {
    const label = formatToolCall("review_query_strategy", null);
    expect(label).toEqual({
      verb: "审查",
      target: "查询策略",
    });
  });

  it("maps commit_to_cache", () => {
    const label = formatToolCall("commit_to_cache", null);
    expect(label).toEqual({
      verb: "导入",
      target: "缓存",
    });
  });

  it("maps extract_chart_data_vlm with image_path", () => {
    const label = formatToolCall("extract_chart_data_vlm", {
      image_path: "/tmp/chart.png",
    });
    expect(label).toEqual({
      verb: "提取",
      target: "图表数据",
      details: "/tmp/chart.png",
    });
  });

  it("maps capture_web_page with url", () => {
    const label = formatToolCall("capture_web_page", {
      url: "https://example.com",
    });
    expect(label).toEqual({
      verb: "采集",
      target: "网页截图",
      details: "https://example.com",
    });
  });

  it("maps capture_page_section with url", () => {
    const label = formatToolCall("capture_page_section", {
      url: "https://example.com/section",
    });
    expect(label).toEqual({
      verb: "采集",
      target: "网页区域截图",
      details: "https://example.com/section",
    });
  });

  it("falls back to '调用 {toolName}' for unknown tools", () => {
    const label = formatToolCall("some_unknown_tool", { foo: "bar" });
    expect(label).toEqual({
      verb: "调用",
      target: "some_unknown_tool",
    });
  });

  it("falls back to '调用 {toolName}' for unknown tools with null args", () => {
    const label = formatToolCall("another_unknown", null);
    expect(label).toEqual({
      verb: "调用",
      target: "another_unknown",
    });
  });
});
