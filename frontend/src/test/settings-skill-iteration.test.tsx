import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SkillIterationSettingsSection } from "@/components/settings/sections/SkillIterationSettingsSection";
import type { SettingsAPIClient } from "@/hooks/useAPI";

const digest = "a".repeat(64);

describe("SkillIterationSettingsSection", () => {
  it("loads bounded history and requests a review-only candidate", async () => {
    const fetchSkillIterationContext = vi.fn().mockResolvedValue({
      schema_version: "1.0",
      targets: [{
        name: "dataset-construction",
        description: "Trusted dataset construction.",
        category: "analysis",
        source_digest: digest,
      }],
      history_tasks: [
        { task_id: "task_1", title: "GEO expression", updated_at: "2026-08-24T00:00:00Z", message_count: 4 },
        { task_id: "task_2", title: "GDC cohort", updated_at: "2026-08-23T00:00:00Z", message_count: 6 },
      ],
      defaults: { max_tasks: 12, max_messages_per_task: 20 },
      privacy_notice: "历史在发送前脱敏。",
    });
    const startSkillIteration = vi.fn().mockResolvedValue({
      schema_version: "1.0",
      iteration_id: "skill_iter_1",
      status: "candidate",
      created_at: "2026-08-24T01:00:00Z",
      target_skill: "dataset-construction",
      source_digest: digest,
      model_id: "qwen-plus",
      history_task_ids: ["task_1", "task_2"],
      history_message_count: 10,
      summary: "Preserve provenance and explicit validation.",
      signals: [{
        category: "data_processing",
        requirement: "Preserve raw values.",
        action: "Keep raw and normalized values distinct.",
        confidence: "repeated",
        evidence_refs: ["task_1:m1", "task_2:m2"],
      }],
      data_processing_preferences: [{
        stage: "normalization",
        method: "Preserve raw values.",
        applies_when: "Normalized values are derived.",
        verification: "Verify the output schema.",
        evidence_refs: ["task_1:m1"],
      }],
      proposed_skill_markdown: "---\nname: dataset-construction\ndescription: Trusted.\n---\n",
      warnings: ["候选未自动激活。"],
    });
    const api = {
      fetchSkillIterationContext,
      startSkillIteration,
    } as unknown as SettingsAPIClient;

    render(<SkillIterationSettingsSection api={api} />);

    expect(await screen.findByText("GEO expression · 4 条")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("本次迭代重点"), {
      target: { value: "优先保留原始值与 provenance。" },
    });
    fireEvent.click(screen.getByRole("button", { name: "调用模型生成候选" }));

    await waitFor(() => expect(startSkillIteration).toHaveBeenCalledWith({
      schema_version: "1.0",
      target_skill: "dataset-construction",
      task_ids: ["task_1", "task_2"],
      user_focus: "优先保留原始值与 provenance。",
    }));
    expect(await screen.findByText("Preserve provenance and explicit validation."))
      .toBeInTheDocument();
    expect(screen.getByText("候选未自动激活。")).toBeInTheDocument();
  });

  it("disables generation when no terminal history is available", async () => {
    const api = {
      fetchSkillIterationContext: vi.fn().mockResolvedValue({
        schema_version: "1.0",
        targets: [{
          name: "dataset-construction",
          description: "Trusted dataset construction.",
          category: "analysis",
          source_digest: digest,
        }],
        history_tasks: [],
        defaults: { max_tasks: 12, max_messages_per_task: 20 },
        privacy_notice: "历史在发送前脱敏。",
      }),
      startSkillIteration: vi.fn(),
    } as unknown as SettingsAPIClient;

    render(<SkillIterationSettingsSection api={api} />);

    const button = await screen.findByRole("button", { name: "调用模型生成候选" });
    expect(button).toBeDisabled();
  });
});
