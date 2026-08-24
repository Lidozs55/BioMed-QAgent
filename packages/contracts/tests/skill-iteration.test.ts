import { describe, expect, test } from "vitest";

import {
  parseSkillIterationCandidate,
  parseSkillIterationContext,
} from "../src/skill-iteration.js";

const digest = "a".repeat(64);

describe("skill iteration wire contracts", () => {
  test("parses bounded context and candidate responses", () => {
    expect(parseSkillIterationContext({
      schema_version: "1.0",
      targets: [{ name: "geo", description: "GEO", category: "acquisition", source_digest: digest }],
      history_tasks: [{
        task_id: "task_1",
        title: "TP53",
        updated_at: "2026-08-24T00:00:00Z",
        message_count: 2,
      }],
      defaults: { max_tasks: 12, max_messages_per_task: 20 },
      privacy_notice: "History is redacted before model use.",
    }).targets[0]?.name).toBe("geo");

    expect(parseSkillIterationCandidate({
      schema_version: "1.0",
      iteration_id: "iter_1",
      status: "candidate",
      created_at: "2026-08-24T00:00:00Z",
      target_skill: "geo",
      source_digest: digest,
      model_id: "qwen-plus",
      history_task_ids: ["task_1"],
      history_message_count: 2,
      summary: "Prefer provenance-first GEO processing.",
      signals: [{
        category: "data_processing",
        requirement: "Preserve source identifiers.",
        action: "Record accession and processing method.",
        confidence: "explicit",
        evidence_refs: ["task_1:m1"],
      }],
      data_processing_preferences: [{
        stage: "normalization",
        method: "Keep raw and normalized fields distinct.",
        applies_when: "Normalization changes representation.",
        verification: "Compare raw and normalized columns.",
        evidence_refs: ["task_1:m1"],
      }],
      proposed_skill_markdown: "---\nname: geo\ndescription: GEO.\n---\n\n# GEO\n",
      warnings: ["Candidate requires review."],
    }).signals[0]?.confidence).toBe("explicit");
  });

  test("rejects malformed enum and digest values", () => {
    expect(() => parseSkillIterationContext({
      schema_version: "1.0",
      targets: [{ name: "geo", description: "GEO", category: "other", source_digest: digest }],
      history_tasks: [],
      defaults: { max_tasks: 12, max_messages_per_task: 20 },
      privacy_notice: "notice",
    })).toThrow(/category/);

    expect(() => parseSkillIterationCandidate({
      schema_version: "1.0",
      iteration_id: "iter_1",
      status: "candidate",
      created_at: "now",
      target_skill: "geo",
      source_digest: "bad",
      model_id: "m",
      history_task_ids: [],
      history_message_count: 0,
      summary: "summary",
      signals: [],
      data_processing_preferences: [],
      proposed_skill_markdown: "skill",
      warnings: [],
    })).toThrow(/source_digest/);
  });
});
