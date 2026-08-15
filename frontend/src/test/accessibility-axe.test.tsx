import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { axe } from "vitest-axe";

import { AgentComposer } from "@/components/AgentComposer";

describe("axe accessibility", () => {
  it("AgentComposer has no critical accessibility violations", async () => {
    const { container } = render(
      <AgentComposer
        value=""
        onChange={() => undefined}
        onSubmit={() => undefined}
        onKeyDown={() => undefined}
        placeholder="输入研究目标..."
        ariaLabel="研究目标"
      />,
    );
    const results = await axe(container);
    expect(results.violations).toHaveLength(0);
  });
});
