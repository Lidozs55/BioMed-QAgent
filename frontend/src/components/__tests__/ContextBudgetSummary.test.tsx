import { render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { ContextBudgetSummary } from "@/components/ContextBudgetSummary";

const exact = (n: number) => n.toLocaleString();

describe("ContextBudgetSummary", () => {
  beforeAll(() => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: false, media: query, onchange: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
      addListener: vi.fn(), removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
  });

  it("displays catalog source, context window, output limit, safety reserve, and available input", () => {
    render(
      <ContextBudgetSummary
        contextWindow={32768}
        source="catalog"
        maxOutputTokens={4096}
        safetyReserveTokens={16384}
        availableInputTokens={12288}
      />,
    );

    expect(screen.getByText("Context Budget")).toBeInTheDocument();
    expect(screen.getByText(`${exact(32768)} tokens`)).toBeInTheDocument();
    expect(screen.getByText("catalog")).toBeInTheDocument();
    expect(screen.getByText(`${exact(4096)} tokens`)).toBeInTheDocument();
    expect(screen.getByText(`${exact(16384)} tokens`)).toBeInTheDocument();
    expect(screen.getByText(`${exact(12288)} tokens`)).toBeInTheDocument();
  });

  it("shows user source", () => {
    render(
      <ContextBudgetSummary
        contextWindow={65536}
        source="user"
        maxOutputTokens={8192}
        safetyReserveTokens={16384}
        availableInputTokens={40960}
      />,
    );
    expect(screen.getByText("user")).toBeInTheDocument();
  });

  it("shows unknown source", () => {
    render(
      <ContextBudgetSummary
        contextWindow={0}
        source="unknown"
        maxOutputTokens={4096}
        safetyReserveTokens={16384}
        availableInputTokens={0}
      />,
    );
    expect(screen.getByText("unknown")).toBeInTheDocument();
  });

  it("renders all metric labels for accessibility", () => {
    render(
      <ContextBudgetSummary
        contextWindow={131072}
        source="catalog"
        maxOutputTokens={16384}
        safetyReserveTokens={16384}
        availableInputTokens={98304}
      />,
    );

    expect(screen.getByText("Context Window")).toBeInTheDocument();
    expect(screen.getByText("Source")).toBeInTheDocument();
    expect(screen.getByText("Max Output")).toBeInTheDocument();
    expect(screen.getByText("Safety Reserve")).toBeInTheDocument();
    expect(screen.getByText("Available Input")).toBeInTheDocument();
  });

  it("renders zero values as 0 tokens", () => {
    render(
      <ContextBudgetSummary
        contextWindow={0}
        source="unknown"
        maxOutputTokens={0}
        safetyReserveTokens={0}
        availableInputTokens={0}
      />,
    );

    expect(screen.getAllByText("0 tokens").length).toBeGreaterThanOrEqual(3);
  });
});
