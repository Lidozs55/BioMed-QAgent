import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { CodeBlock } from "../CodeBlock";
import { DiffView } from "../DiffView";
import { JsonBlock } from "../JsonBlock";

describe("JsonBlock", () => {
  it("pretty-prints and highlights the value", () => {
    render(<JsonBlock value={{ query: "lung cancer", limit: 5 }} />);
    const block = screen.getByTestId("json-block");
    expect(block.textContent).toContain('"query": "lung cancer"');
    expect(block.textContent).toContain('"limit": 5');
    const keySpan = block.querySelector(".text-primary");
    expect(keySpan?.textContent).toContain("query");
  });

  it("offers a copy button", () => {
    render(<JsonBlock value={{ a: 1 }} />);
    expect(screen.getByRole("button", { name: "复制" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "复制" }));
  });
});

describe("CodeBlock", () => {
  it("defaults to the readable text and toggles to raw output", () => {
    render(
      <CodeBlock
        text="print(1)"
        rawText='{"content":[{"type":"text","text":"print(1)"}]}'
      />,
    );
    expect(screen.getByText("print(1)")).toBeInTheDocument();
    const toggle = screen.getByRole("button", { name: "原始输出" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(toggle);
    expect(screen.getByText(/"content"/)).toBeInTheDocument();
    expect(toggle).toHaveAttribute("aria-pressed", "true");
  });

  it("hides the toggle when raw text equals the readable text", () => {
    render(<CodeBlock text="plain" rawText="plain" />);
    expect(screen.queryByRole("button", { name: "原始输出" })).not.toBeInTheDocument();
  });
});

describe("DiffView", () => {
  it("renders deleted lines with destructive classes and added lines with success", () => {
    render(
      <DiffView deleted={["const a = 1;"]} added={["const a = 2;", "const b = 3;"]} />,
    );
    const removed = screen.getByText("const a = 1;").closest("[class*='border-l-destructive']");
    expect(removed).not.toBeNull();
    const added = screen.getByText("const a = 2;").closest("[class*='border-l-success']");
    expect(added).not.toBeNull();
    expect(screen.getByText("−", { selector: "span[aria-hidden='true']" })).toBeInTheDocument();
    expect(screen.getAllByText("+", { selector: "span[aria-hidden='true']" })).toHaveLength(2);
  });

  it("keeps empty lines visible", () => {
    const { container } = render(<DiffView added={["", "x"]} />);
    // NBSP 文本会被 testing-library 的 normalizer 归一化,改查行结构。
    const rows = container.querySelectorAll("[class*='border-l-success']");
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toBe("+\u00A0");
  });
});
