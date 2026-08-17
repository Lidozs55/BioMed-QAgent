import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";

describe("SelectItem", () => {
  it("aligns a primary label and its description consistently", () => {
    render(
      <Select defaultOpen>
        <SelectTrigger aria-label="回复语气" />
        <SelectContent>
          <SelectItem value="warm">
            <span className="leading-5">亲和</span>
            <span className="text-xs leading-5 text-muted-foreground">
              温暖、协作、贴心
            </span>
          </SelectItem>
        </SelectContent>
      </Select>,
    );

    const itemText = screen.getByRole("option").firstElementChild;
    expect(itemText).toHaveClass("items-center", "gap-2");
    expect(itemText?.firstElementChild).toHaveTextContent("亲和");
    expect(itemText?.firstElementChild).toHaveClass("leading-5");
    expect(screen.getByText("温暖、协作、贴心")).toHaveClass("leading-5");
  });
});