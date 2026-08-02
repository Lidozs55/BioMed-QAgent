import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  parseFindSkillOutput,
  SkillMarker,
} from "@/components/conversation/SkillMarker";
import type { ToolCallItem } from "@/runtime/types";

const TIMESTAMP = "2026-07-20T00:00:00Z";

function makeSkillCall(overrides: Partial<ToolCallItem>): ToolCallItem {
  return {
    itemId: "skill-call-1",
    runId: "run-1",
    sequence: 1,
    createdAt: TIMESTAMP,
    kind: "tool_call",
    toolCallId: "call-1",
    toolName: "find_skill",
    arguments: { text: "网页截图" },
    status: "completed",
    output: null,
    completedSequence: 2,
    ...overrides,
  };
}

describe("parseFindSkillOutput", () => {
  it("extracts names and total from find_skill output", () => {
    const summary = parseFindSkillOutput(
      JSON.stringify({
        status: "ok",
        skills: [
          { name: "web_visual_capture", display_name: "网页视觉采集" },
          { name: "parse_excel", display_name: "Excel 解析" },
          { name: "parse_pdf", display_name: "PDF 解析" },
        ],
      }),
    );
    expect(summary).toEqual({
      total: 3,
      names: ["网页视觉采集", "Excel 解析", "PDF 解析"],
    });
  });

  it("falls back to name when display_name is missing", () => {
    const summary = parseFindSkillOutput(
      JSON.stringify({ status: "ok", skills: [{ name: "parse_excel" }] }),
    );
    expect(summary?.names).toEqual(["parse_excel"]);
  });

  it("returns null for null, empty, or unparseable output", () => {
    expect(parseFindSkillOutput(null)).toBeNull();
    expect(parseFindSkillOutput("")).toBeNull();
    expect(parseFindSkillOutput('{"status":"ok","skills":[')).toBeNull();
    expect(parseFindSkillOutput("not json")).toBeNull();
  });
});

describe("SkillMarker", () => {
  it("shows '检索技能中...' with spinner while find_skill is running", () => {
    render(
      <SkillMarker item={makeSkillCall({ status: "running", output: null })} />,
    );
    expect(screen.getByText("检索技能中...")).toBeInTheDocument();
    expect(document.querySelector(".animate-spin")).not.toBeNull();
    expect(screen.queryByText("结果摘要")).not.toBeInTheDocument();
  });

  it("shows '检索技能' when find_skill completes and expands to keywords + summary", () => {
    render(
      <SkillMarker
        item={makeSkillCall({
          output: JSON.stringify({
            status: "ok",
            skills: [
              { name: "web_visual_capture", display_name: "网页视觉采集" },
              { name: "parse_excel", display_name: "Excel 解析" },
              { name: "parse_pdf", display_name: "PDF 解析" },
            ],
          }),
        })}
      />,
    );
    expect(screen.getByText("检索技能")).toBeInTheDocument();
    expect(screen.queryByText("调用 find_skill")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("关键词")).toBeInTheDocument();
    expect(screen.getByText("网页截图")).toBeInTheDocument();
    expect(screen.getByText("结果摘要")).toBeInTheDocument();
    expect(
      screen.getByText("共 3 个技能：网页视觉采集、Excel 解析 …"),
    ).toBeInTheDocument();
  });

  it("shows only the first two names plus the total", () => {
    const skills = Array.from({ length: 5 }, (_, i) => ({
      name: `skill_${i}`,
    }));
    render(
      <SkillMarker
        item={makeSkillCall({
          output: JSON.stringify({ status: "ok", skills }),
        })}
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("共 5 个技能：skill_0、skill_1 …")).toBeInTheDocument();
  });

  it("shows '未找到匹配技能' when find_skill found nothing", () => {
    render(
      <SkillMarker
        item={makeSkillCall({
          output: JSON.stringify({ status: "ok", skills: [] }),
        })}
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("未找到匹配技能")).toBeInTheDocument();
  });

  it("falls back to the raw output when find_skill output is truncated", () => {
    render(
      <SkillMarker
        item={makeSkillCall({ output: '{"status":"ok","skills":[' })}
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText('{"status":"ok","skills":[')).toBeInTheDocument();
  });

  it("shows '无输出' when find_skill has no output", () => {
    render(<SkillMarker item={makeSkillCall({})} />);
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("无输出")).toBeInTheDocument();
  });

  it("labels invoke_skill as '调用 <skill>' and expands flat to input + output", () => {
    render(
      <SkillMarker
        item={makeSkillCall({
          toolName: "invoke_skill",
          arguments: {
            skill: "web_visual_capture",
            operation: "capture_web_page",
            arguments: { url: "https://example.com" },
          },
          output: '{"status":"ok","result":"done"}',
        })}
      />,
    );
    expect(screen.getByText("调用 web_visual_capture")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("输入参数")).toBeInTheDocument();
    expect(screen.getByText(/"operation": "capture_web_page"/)).toBeInTheDocument();
    expect(screen.getByText("输出")).toBeInTheDocument();
    expect(
      screen.getByText('{"status":"ok","result":"done"}'),
    ).toBeInTheDocument();
    // 统一规定：展开后输入输出直接平铺，不再嵌套折叠
    expect(document.querySelectorAll("details")).toHaveLength(0);
  });

  it("shows spinner while invoke_skill is running", () => {
    render(
      <SkillMarker
        item={makeSkillCall({
          toolName: "invoke_skill",
          arguments: { skill: "web_visual_capture" },
          status: "running",
        })}
      />,
    );
    expect(screen.getByText("调用 web_visual_capture")).toBeInTheDocument();
    expect(document.querySelector(".animate-spin")).not.toBeNull();
  });

  it("marks invoke_skill error output and omits 输入参数 when arguments is null", () => {
    render(
      <SkillMarker
        item={makeSkillCall({
          toolName: "invoke_skill",
          arguments: null,
          status: "error",
          output: "boom",
        })}
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("输出（错误）")).toBeInTheDocument();
    expect(screen.queryByText("输入参数")).not.toBeInTheDocument();
    expect(screen.getByText("调用 技能")).toBeInTheDocument();
  });
});
