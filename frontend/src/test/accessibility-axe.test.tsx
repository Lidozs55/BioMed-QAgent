import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { axe } from "vitest-axe";
import "vitest-axe/extend-expect";
import * as matchers from "vitest-axe/matchers";

import { AgentComposer } from "@/components/AgentComposer";

expect.extend(matchers);

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
    expect(results).toHaveNoViolations();
  });
});