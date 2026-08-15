import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AgentComposer } from "@/components/AgentComposer";

describe("AgentComposer accessibility", () => {
  it("exposes an accessible input, attachment control, and send button", () => {
    render(
      <AgentComposer
        value=""
        onChange={() => undefined}
        onSubmit={() => undefined}
        onKeyDown={() => undefined}
        placeholder="输入研究目标..."
        ariaLabel="研究目标"
      />,
    );

    expect(screen.getByRole("textbox", { name: "研究目标" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "添加附件" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "发送" })).toBeInTheDocument();
  });
});