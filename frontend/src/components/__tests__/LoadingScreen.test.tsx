import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { LoadingScreen } from "@/components/LoadingScreen";

describe("LoadingScreen", () => {
  it("announces the loading state to assistive technology", () => {
    render(<LoadingScreen />);
    const status = screen.getByRole("status", { name: "正在加载对话" });
    expect(status).toHaveAttribute("aria-busy", "true");
  });

  it("renders the simplified logo mark centered on a solid background", () => {
    render(<LoadingScreen />);
    const logo = screen.getByRole("img", { name: "BioMed QAgent" });
    expect(logo).toHaveAttribute("draggable", "false");
    expect(screen.getByText("正在加载对话…")).toBeDefined();
  });
});
