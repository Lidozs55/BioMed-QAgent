import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ContextBudgetControls } from "@/components/ContextBudgetControls";

describe("ContextBudgetControls", () => {
  const defaultProps = {
    safetyReserveRatio: 0.05,
    compactionTriggerRatio: 0.85,
    compactionTargetRatio: 0.60,
    contextWindowOverrideStr: "",
    showAdvanced: true,
    source: "catalog" as const,
    onChange: vi.fn(),
  };

  it("renders all ratio inputs with labels", () => {
    render(<ContextBudgetControls {...defaultProps} />);

    expect(screen.getByLabelText("Safety Reserve Ratio")).toBeInTheDocument();
    expect(screen.getByLabelText("Compaction Trigger")).toBeInTheDocument();
    expect(screen.getByLabelText("Compaction Target")).toBeInTheDocument();
  });

  it("shows current ratio values", () => {
    render(<ContextBudgetControls {...defaultProps} />);

    expect(screen.getByDisplayValue("0.05")).toBeInTheDocument();
    expect(screen.getByDisplayValue("0.85")).toBeInTheDocument();
    expect(screen.getByDisplayValue("0.6")).toBeInTheDocument();
  });

  it("calls onChange when safety_reserve_ratio is changed to a valid value", () => {
    const onChange = vi.fn();
    render(<ContextBudgetControls {...defaultProps} onChange={onChange} />);

    fireEvent.change(screen.getByLabelText("Safety Reserve Ratio"), {
      target: { value: "0.10" },
    });

    expect(onChange).toHaveBeenCalledWith({
      safetyReserveRatio: 0.10,
      compactionTriggerRatio: 0.85,
      compactionTargetRatio: 0.60,
      contextWindowOverrideStr: "",
    });
  });

  it("calls onChange when compaction trigger is changed", () => {
    const onChange = vi.fn();
    render(<ContextBudgetControls {...defaultProps} onChange={onChange} />);

    fireEvent.change(screen.getByLabelText("Compaction Trigger"), {
      target: { value: "0.90" },
    });

    expect(onChange).toHaveBeenCalledWith({
      safetyReserveRatio: 0.05,
      compactionTriggerRatio: 0.90,
      compactionTargetRatio: 0.60,
      contextWindowOverrideStr: "",
    });
  });

  it("applies aria-invalid when safety_reserve_ratio exceeds 0.25", () => {
    render(<ContextBudgetControls {...defaultProps} safetyReserveRatio={0.50} />);

    const input = screen.getByLabelText("Safety Reserve Ratio");
    expect(input).toHaveAttribute("aria-invalid", "true");
  });

  it("applies aria-invalid when compaction ratios violate 0 < target < trigger < 1", () => {
    const { rerender } = render(
      <ContextBudgetControls {...defaultProps} compactionTriggerRatio={0.50} compactionTargetRatio={0.60} />,
    );

    const trigger = screen.getByLabelText("Compaction Trigger");
    expect(trigger).toHaveAttribute("aria-invalid", "true");
    const target = screen.getByLabelText("Compaction Target");
    expect(target).toHaveAttribute("aria-invalid", "true");

    // Fix ratios should clear aria-invalid
    rerender(<ContextBudgetControls {...defaultProps} compactionTriggerRatio={0.85} compactionTargetRatio={0.60} />);
    expect(trigger).not.toHaveAttribute("aria-invalid");
    expect(target).not.toHaveAttribute("aria-invalid");
  });

  it("shows context_window override input when showAdvanced is true", () => {
    render(<ContextBudgetControls {...defaultProps} showAdvanced />);

    expect(screen.getByLabelText("Context Window Override")).toBeInTheDocument();
  });

  it("hides context_window override when showAdvanced is false", () => {
    render(<ContextBudgetControls {...defaultProps} showAdvanced={false} />);

    expect(screen.queryByLabelText("Context Window Override")).not.toBeInTheDocument();
  });

  it("calls onChange with contextWindowOverrideStr when changed", () => {
    const onChange = vi.fn();
    render(<ContextBudgetControls {...defaultProps} showAdvanced onChange={onChange} />);

    fireEvent.change(screen.getByLabelText("Context Window Override"), {
      target: { value: "65536" },
    });

    expect(onChange).toHaveBeenCalledWith({
      safetyReserveRatio: 0.05,
      compactionTriggerRatio: 0.85,
      compactionTargetRatio: 0.60,
      contextWindowOverrideStr: "65536",
    });
  });

  it("shows error text when safety_reserve_ratio is out of range", () => {
    render(<ContextBudgetControls {...defaultProps} safetyReserveRatio={0.50} />);

    expect(screen.getByText("Must be between 0 and 0.25")).toBeInTheDocument();
  });

  it("shows error text when compaction ratios are invalid", () => {
    render(<ContextBudgetControls {...defaultProps} compactionTriggerRatio={0.40} compactionTargetRatio={0.60} />);

    const errors = screen.getAllByText("Must satisfy 0 < target < trigger < 1");
    expect(errors.length).toBeGreaterThanOrEqual(1);
  });
});
