import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const GREETING_OPTIONS = [
  { value: "greeting_zh", label: "中文问候" },
  { value: "greeting_en", label: "English Greeting" },
] as const;

/**
 * Contract: the closed trigger renders the human-readable label of the
 * selected item, never the raw machine value.
 *
 * Base UI's `Select.Value` renders the raw value unless the Root receives an
 * `items` prop (unlike Radix, which resolves labels from mounted items). The
 * shared `Select` wrapper must keep working for callers that only render
 * `SelectItem`s in the popup.
 */
function GreetingSelect() {
  return (
    <Select
      items={GREETING_OPTIONS}
      value="greeting_en"
      onValueChange={() => undefined}
    >
      <SelectTrigger aria-label="问候语">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {GREETING_OPTIONS.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

describe("Select trigger label contract", () => {
  it("renders the selected item label in the closed trigger", () => {
    render(<GreetingSelect />);
    expect(screen.getByRole("combobox", { name: "问候语" })).toHaveTextContent(
      "English Greeting",
    );
  });

  it("keeps labels out of the raw value (regression guard)", () => {
    render(<GreetingSelect />);
    const trigger = screen.getByRole("combobox", { name: "问候语" });
    expect(trigger).not.toHaveTextContent("greeting_en");
  });

  it("updates the trigger label after selecting another option", async () => {
    const { rerender } = render(
      <Select
        items={GREETING_OPTIONS}
        value="greeting_zh"
        onValueChange={() => undefined}
      >
        <SelectTrigger aria-label="问候语">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {GREETING_OPTIONS.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>,
    );
    expect(screen.getByRole("combobox", { name: "问候语" })).toHaveTextContent(
      "中文问候",
    );

    rerender(
      <Select
        items={GREETING_OPTIONS}
        value="greeting_en"
        onValueChange={() => undefined}
      >
        <SelectTrigger aria-label="问候语">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {GREETING_OPTIONS.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>,
    );
    expect(screen.getByRole("combobox", { name: "问候语" })).toHaveTextContent(
      "English Greeting",
    );
  });

  it("keeps existing SelectItem layout behavior", () => {
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
