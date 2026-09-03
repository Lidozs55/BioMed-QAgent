import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SearchInfoStep } from "@/components/conversation/SearchInfoStep";
import type { SearchInfoItem } from "@/runtime/types";

const base: SearchInfoItem = {
  itemId: "search_info:run_1",
  runId: "run_1",
  sequence: 3,
  createdAt: "2026-09-03T00:00:00.000Z",
  kind: "search_info",
  results: [
    { site_name: "Nature", url: "https://www.nature.com/articles/x", title: "A study" },
    { site_name: "", url: "https://pubmed.ncbi.nlm.nih.gov/123/" },
  ],
};

describe("SearchInfoStep", () => {
  it("renders a collapsed summary with the hit count", () => {
    render(<SearchInfoStep item={base} />);
    expect(screen.getByText("联网搜索来源（2）")).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("expands into per-source links and collapses again", () => {
    render(<SearchInfoStep item={base} />);

    fireEvent.click(screen.getByRole("button", { name: "联网搜索来源（2）" }));

    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(2);
    expect(links[0]).toHaveAttribute("href", "https://www.nature.com/articles/x");
    expect(links[0]).toHaveAttribute("rel", "noreferrer");
    expect(links[0]).toHaveAttribute("title", "A study");
    // Empty site_name falls back to the URL hostname (appears twice in the link).
    const pubmedLink = screen.getByRole("link", { name: /pubmed\.ncbi\.nlm\.nih\.gov/ });
    expect(pubmedLink).toHaveAttribute("href", "https://pubmed.ncbi.nlm.nih.gov/123/");

    fireEvent.click(screen.getByRole("button", { name: "联网搜索来源（2）" }));
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});
