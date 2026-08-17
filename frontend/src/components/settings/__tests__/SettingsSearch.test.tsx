import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SettingsSearch } from "@/components/settings/SettingsSearch";

describe("SettingsSearch", () => {
  const renderSearch = () =>
    render(<SettingsSearch onNavigate={vi.fn()} />);

  it("does not open an empty popover when the input receives focus", () => {
    renderSearch();

    fireEvent.focus(screen.getByRole("textbox", { name: "搜索设置" }));

    expect(document.querySelector('[data-slot="popover-content"]')).not.toBeInTheDocument();
  });

  it("keeps focus in the input while displaying search results", () => {
    renderSearch();
    const input = screen.getByRole("textbox", { name: "搜索设置" });

    fireEvent.change(input, { target: { value: "模型" } });

    expect(input).toHaveFocus();
    expect(screen.getByRole("option", { name: /模型/ })).toBeInTheDocument();
  });

  it("shows an empty state for a non-empty query without matches", () => {
    renderSearch();

    fireEvent.change(screen.getByRole("textbox", { name: "搜索设置" }), {
      target: { value: "不存在的设置" },
    });

    expect(screen.getByText("无匹配项")).toBeInTheDocument();
  });

  it("uses a wider responsive popover for result content", () => {
    renderSearch();

    fireEvent.change(screen.getByRole("textbox", { name: "搜索设置" }), {
      target: { value: "模型" },
    });

    expect(document.querySelector('[data-slot="popover-content"]')).toHaveClass(
      "w-[min(26rem,var(--available-width))]",
    );
  });
});