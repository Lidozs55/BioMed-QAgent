import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import type {
  SkillIterationCandidate,
  SkillIterationContext,
  SkillIterationDataProcessingPreference,
  SkillIterationSignal,
  StartSkillIterationRequest,
} from "@biomed/contracts";

import type { BioMedModelConfig } from "../contracts.js";
import { generateOneShotText } from "../pi-adapter.js";
import { SKILL_TOOL_MAP } from "../skills/skill-tool-map.js";
import { writeJsonAtomic } from "../../persistence/atomic-json.js";
import { DurableTaskRepository } from "../../runtime/task-repository.js";
import { SAFE_ID } from "../../runtime/safe-id.js";

const MAX_CONTEXT_TASKS = 30;
const MAX_SELECTED_TASKS = 12;
const MAX_MESSAGES_PER_TASK = 20;
const MAX_MESSAGE_CHARACTERS = 4_000;
const MAX_TRANSCRIPT_CHARACTERS = 60_000;
const MAX_FOCUS_CHARACTERS = 4_000;
const MAX_SIGNALS = 24;
const MAX_LIST_ITEMS = 24;
const MAX_FIELD_CHARACTERS = 1_000;
const MAX_SUMMARY_CHARACTERS = 2_000;
const MAX_SKILL_CHARACTERS = 30_000;

const PRIVACY_NOTICE =
  "仅发送所选已结束任务中的用户/助手消息；系统、工具与推理消息被排除，常见密钥模式会脱敏，单条和总长度均受限。";

const FORBIDDEN_SKILL_TERMS = [
  "find_skill",
  "invoke_skill",
  "create_skill",
  "SkillBuilderAgent",
  "FastAPI",
];

export interface SkillIterationServiceOptions {
  repositoryRoot: string;
  tasksRoot: string;
  settingsDir: string;
  resolveModel: () => Promise<BioMedModelConfig>;
  generate?: (input: {
    model: BioMedModelConfig;
    systemPrompt: string;
    prompt: string;
    cwd: string;
    signal: AbortSignal;
  }) => Promise<string>;
  id?: () => string;
  now?: () => Date;
}

interface TranscriptMessage {
  evidence_ref: string;
  task_id: string;
  role: "user" | "assistant";
  created_at: string;
  content: string;
}

interface ParsedModelOutput {
  summary: string;
  signals: SkillIterationSignal[];
  dataProcessingPreferences: SkillIterationDataProcessingPreference[];
  proposedSkillMarkdown: string;
  warnings: string[];
}

export class SkillIterationError extends Error {
  constructor(readonly status: number, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SkillIterationError";
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function plainObject(value: unknown, pathName: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SkillIterationError(502, pathName + " must be an object");
  }
  return value as Record<string, unknown>;
}

function boundedString(value: unknown, pathName: string, max: number): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > max) {
    throw new SkillIterationError(
      502,
      pathName + " must be a non-empty string up to " + max + " characters",
    );
  }
  return value;
}

function boundedStringArray(value: unknown, pathName: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_LIST_ITEMS) {
    throw new SkillIterationError(502, pathName + " must be an array up to 24 items");
  }
  return value.map((item, index) =>
    boundedString(item, pathName + "[" + index + "]", MAX_FIELD_CHARACTERS));
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/sk-[A-Za-z0-9_-]{8,}/gu, "[REDACTED_API_KEY]")
    .replace(/(bearer\s+)[A-Za-z0-9._~+/-]{8,}/giu, "$1[REDACTED_TOKEN]")
    .replace(
      /((?:api[_ -]?key|token|password|secret)\s*[:=]\s*)[^\s,;]+/giu,
      "$1[REDACTED_SECRET]",
    )
    .replace(
      /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu,
      "[REDACTED_JWT]",
    );
}

function slashPaths(value: string): ReadonlySet<string> {
  return new Set(
    [...value.matchAll(/\/[A-Za-z0-9][A-Za-z0-9._/-]*/gu)]
      .map((match) => match[0]),
  );
}

function parseModelOutput(
  raw: string,
  targetName: string,
  mappedTools: readonly string[],
  currentSkillMarkdown: string,
  allowedEvidence: ReadonlyMap<string, TranscriptMessage>,
  selectedTaskIds: readonly string[],
): ParsedModelOutput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new SkillIterationError(
      502,
      "Iteration model did not return strict JSON",
      { cause: error },
    );
  }
  const object = plainObject(parsed, "model output");
  const signalsValue = Reflect.get(object, "signals");
  if (!Array.isArray(signalsValue) || signalsValue.length > MAX_SIGNALS) {
    throw new SkillIterationError(502, "model output.signals must contain at most 24 items");
  }
  const signals = signalsValue.map((value, index): SkillIterationSignal => {
    const signal = plainObject(value, "model output.signals[" + index + "]");
    const category = Reflect.get(signal, "category");
    const confidence = Reflect.get(signal, "confidence");
    if (
      category !== "interaction" &&
      category !== "data_processing" &&
      category !== "output" &&
      category !== "constraint"
    ) {
      throw new SkillIterationError(502, "model output contains an invalid signal category");
    }
    if (confidence !== "explicit" && confidence !== "repeated" && confidence !== "tentative") {
      throw new SkillIterationError(502, "model output contains an invalid signal confidence");
    }
    const evidenceRefs = boundedStringArray(
      Reflect.get(signal, "evidence_refs"),
      "model output.signals[" + index + "].evidence_refs",
    );
    if (confidence !== "tentative" && evidenceRefs.length === 0) {
      throw new SkillIterationError(502, "non-tentative signals require evidence");
    }
    if (evidenceRefs.some((reference) => !allowedEvidence.has(reference))) {
      throw new SkillIterationError(502, "model output cites evidence outside the selected history");
    }
    if (
      confidence !== "tentative" &&
      !evidenceRefs.some((reference) => allowedEvidence.get(reference)?.role === "user")
    ) {
      throw new SkillIterationError(502, "non-tentative signals require user-authored evidence");
    }
    if (confidence === "repeated") {
      if (evidenceRefs.length < 2) {
        throw new SkillIterationError(502, "repeated signals require at least two evidence references");
      }
      const availableTasks = new Set([...allowedEvidence.values()].map((message) => message.task_id));
      const citedTasks = new Set(
        evidenceRefs.map((reference) => allowedEvidence.get(reference)?.task_id),
      );
      if (availableTasks.size > 1 && citedTasks.size < 2) {
        throw new SkillIterationError(502, "repeated signals must cite distinct tasks when available");
      }
    }
    return {
      category,
      requirement: boundedString(
        Reflect.get(signal, "requirement"),
        "model output.signals[" + index + "].requirement",
        MAX_FIELD_CHARACTERS,
      ),
      action: boundedString(
        Reflect.get(signal, "action"),
        "model output.signals[" + index + "].action",
        MAX_FIELD_CHARACTERS,
      ),
      confidence,
      evidence_refs: evidenceRefs,
    };
  });

  const proposedSkillMarkdown = boundedString(
    Reflect.get(object, "proposed_skill_markdown"),
    "model output.proposed_skill_markdown",
    MAX_SKILL_CHARACTERS,
  );
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(proposedSkillMarkdown);
  const name = frontmatter?.[1]?.split(/\r?\n/u)
    .map((line) => /^name:\s*(.+)$/u.exec(line)?.[1]?.trim())
    .find((value) => value !== undefined);
  if (name !== targetName) {
    throw new SkillIterationError(502, "Candidate frontmatter name must match the target skill");
  }
  for (const tool of mappedTools) {
    if (!proposedSkillMarkdown.includes(tool)) {
      throw new SkillIterationError(502, "Candidate omitted mapped tool " + tool);
    }
  }
  const allowedPaths = slashPaths(currentSkillMarkdown);
  for (const candidatePath of slashPaths(proposedSkillMarkdown)) {
    if (!allowedPaths.has(candidatePath)) {
      throw new SkillIterationError(
        502,
        "Candidate introduced a path or API surface outside the current Skill: " + candidatePath,
      );
    }
  }
  for (const forbidden of FORBIDDEN_SKILL_TERMS) {
    if (proposedSkillMarkdown.includes(forbidden)) {
      throw new SkillIterationError(502, "Candidate contains forbidden term " + forbidden);
    }
  }
  if (selectedTaskIds.some((taskId) => proposedSkillMarkdown.includes(taskId))) {
    throw new SkillIterationError(502, "Candidate must not embed task identifiers");
  }

  return {
    summary: boundedString(
      Reflect.get(object, "summary"),
      "model output.summary",
      MAX_SUMMARY_CHARACTERS,
    ),
    signals,
    dataProcessingPreferences: (() => {
      const value = Reflect.get(object, "data_processing_preferences");
      if (!Array.isArray(value) || value.length > MAX_LIST_ITEMS) {
        throw new SkillIterationError(
          502,
          "model output.data_processing_preferences must contain at most 24 items",
        );
      }
      return value.map((item, index): SkillIterationDataProcessingPreference => {
        const preference = plainObject(
          item,
          "model output.data_processing_preferences[" + index + "]",
        );
        const evidenceRefs = boundedStringArray(
          Reflect.get(preference, "evidence_refs"),
          "model output.data_processing_preferences[" + index + "].evidence_refs",
        );
        if (
          evidenceRefs.length === 0 ||
          evidenceRefs.some((reference) => !allowedEvidence.has(reference))
        ) {
          throw new SkillIterationError(
            502,
            "data-processing preferences require selected-history evidence",
          );
        }
        const prefix = "model output.data_processing_preferences[" + index + "]";
        return {
          stage: boundedString(Reflect.get(preference, "stage"), prefix + ".stage", MAX_FIELD_CHARACTERS),
          method: boundedString(Reflect.get(preference, "method"), prefix + ".method", MAX_FIELD_CHARACTERS),
          applies_when: boundedString(
            Reflect.get(preference, "applies_when"),
            prefix + ".applies_when",
            MAX_FIELD_CHARACTERS,
          ),
          verification: boundedString(
            Reflect.get(preference, "verification"),
            prefix + ".verification",
            MAX_FIELD_CHARACTERS,
          ),
          evidence_refs: evidenceRefs,
        };
      });
    })(),
    proposedSkillMarkdown,
    warnings: boundedStringArray(Reflect.get(object, "warnings"), "model output.warnings"),
  };
}

function validateRequest(value: StartSkillIterationRequest): StartSkillIterationRequest {
  if (value.schema_version !== "1.0") {
    throw new SkillIterationError(422, "schema_version must be 1.0");
  }
  if (!/^[a-z][a-z0-9_-]*$/u.test(value.target_skill)) {
    throw new SkillIterationError(422, "target_skill is invalid");
  }
  if (
    !Array.isArray(value.task_ids) ||
    value.task_ids.length < 1 ||
    value.task_ids.length > MAX_SELECTED_TASKS ||
    value.task_ids.some((taskId) => typeof taskId !== "string" || !SAFE_ID.test(taskId))
  ) {
    throw new SkillIterationError(422, "task_ids must contain 1 to 12 task IDs");
  }
  if (new Set(value.task_ids).size !== value.task_ids.length) {
    throw new SkillIterationError(422, "task_ids must be unique");
  }
  if (typeof value.user_focus !== "string" || value.user_focus.length > MAX_FOCUS_CHARACTERS) {
    throw new SkillIterationError(422, "user_focus must be a string up to 4000 characters");
  }
  return value;
}

export class SkillIterationService {
  private readonly repository: DurableTaskRepository;
  private readonly skillsRoot: string;
  private readonly guidePath: string;
  private readonly candidateRoot: string;
  private readonly generate: NonNullable<SkillIterationServiceOptions["generate"]>;
  private readonly id: () => string;
  private readonly now: () => Date;
  private running = false;

  constructor(private readonly options: SkillIterationServiceOptions) {
    this.repository = new DurableTaskRepository(options.tasksRoot);
    this.skillsRoot = path.join(options.repositoryRoot, ".pi", "skills");
    this.guidePath = path.join(
      options.repositoryRoot,
      "server",
      "src",
      "agent",
      "skill-iteration",
      "personalized-skill-evolver",
      "SKILL.md",
    );
    this.candidateRoot = path.join(options.settingsDir, "skill-iterations");
    this.generate = options.generate ?? (async (input) =>
      generateOneShotText({
        model: input.model,
        systemPrompt: input.systemPrompt,
        prompt: input.prompt,
        cwd: input.cwd,
        signal: input.signal,
      }));
    this.id = options.id ?? randomUUID;
    this.now = options.now ?? (() => new Date());
  }

  async context(): Promise<SkillIterationContext> {
    const [page, targets] = await Promise.all([
      this.repository.listTasks(100),
      Promise.all(SKILL_TOOL_MAP.map(async (entry) => {
        const content = await readFile(path.join(this.skillsRoot, entry.name, "SKILL.md"), "utf8");
        return {
          name: entry.name,
          description: entry.description,
          category: entry.category,
          source_digest: sha256(content),
        };
      })),
    ]);
    const historyTasks = await Promise.all(page.items.slice(0, MAX_CONTEXT_TASKS).map(async (task) => {
      const snapshot = await this.repository.getSnapshot(task.task_id);
      const messageCount = snapshot?.messages.filter(
        (message) => message.role === "user" || message.role === "assistant",
      ).length ?? 0;
      return {
        task_id: task.task_id,
        title: task.title,
        updated_at: task.updated_at,
        message_count: messageCount,
      };
    }));
    return {
      schema_version: "1.0",
      targets: targets.sort((left, right) => left.name.localeCompare(right.name)),
      history_tasks: historyTasks.filter((task) => task.message_count > 0),
      defaults: {
        max_tasks: MAX_SELECTED_TASKS,
        max_messages_per_task: MAX_MESSAGES_PER_TASK,
      },
      privacy_notice: PRIVACY_NOTICE,
    };
  }

  async iterate(
    requestValue: StartSkillIterationRequest,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<SkillIterationCandidate> {
    if (this.running) throw new SkillIterationError(409, "A skill iteration is already running");
    const request = validateRequest(requestValue);
    const mapping = SKILL_TOOL_MAP.find((entry) => entry.name === request.target_skill);
    if (mapping === undefined) throw new SkillIterationError(404, "Target skill not found");
    this.running = true;
    try {
      const targetPath = path.join(this.skillsRoot, mapping.name, "SKILL.md");
      const [targetContent, guide, selectedSnapshots, model] = await Promise.all([
        readFile(targetPath, "utf8"),
        readFile(this.guidePath, "utf8"),
        Promise.all(request.task_ids.map((taskId) => this.repository.getSnapshot(taskId))),
        this.options.resolveModel(),
      ]);
      const transcript: TranscriptMessage[] = [];
      let transcriptCharacters = 0;
      for (let index = 0; index < selectedSnapshots.length; index += 1) {
        const snapshot = selectedSnapshots[index];
        const taskId = request.task_ids[index]!;
        if (snapshot === null) throw new SkillIterationError(404, "History task not found: " + taskId);
        if (snapshot.task.active_run_id !== null) {
          throw new SkillIterationError(409, "Active tasks cannot be used as iteration history");
        }
        const messages = snapshot.messages
          .filter((message) => message.role === "user" || message.role === "assistant")
          .slice(-MAX_MESSAGES_PER_TASK);
        for (const message of messages) {
          const redacted = redactSensitiveText(message.content).slice(0, MAX_MESSAGE_CHARACTERS);
          if (redacted.trim() === "") continue;
          const remaining = MAX_TRANSCRIPT_CHARACTERS - transcriptCharacters;
          if (remaining <= 0) break;
          const content = redacted.slice(0, remaining);
          transcript.push({
            evidence_ref: taskId + ":" + message.message_id,
            task_id: taskId,
            role: message.role as "user" | "assistant",
            created_at: message.created_at,
            content,
          });
          transcriptCharacters += content.length;
        }
      }
      if (transcript.length === 0) {
        throw new SkillIterationError(422, "Selected history contains no eligible messages");
      }
      const prompt = [
        "Apply the system skill exactly. Analyze only the supplied bounded input.",
        "Do not repeat raw history in the candidate. Return one strict JSON object.",
        "INPUT:",
        JSON.stringify({
          target: {
            name: mapping.name,
            category: mapping.category,
            description: mapping.description,
            source_digest: sha256(targetContent),
            mapped_tools: mapping.tools,
            current_skill_markdown: targetContent,
          },
          user_focus: request.user_focus,
          history_transcript: transcript,
        }, null, 2),
      ].join("\n");
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 180_000);
      const abort = (): void => controller.abort();
      signal.addEventListener("abort", abort, { once: true });
      let raw: string;
      try {
        raw = await this.generate({
          model,
          systemPrompt: guide,
          prompt,
          cwd: this.options.repositoryRoot,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
        signal.removeEventListener("abort", abort);
      }
      const allowedEvidence = new Map(
        transcript.map((message) => [message.evidence_ref, message] as const),
      );
      const output = parseModelOutput(
        raw,
        mapping.name,
        mapping.tools,
        targetContent,
        allowedEvidence,
        request.task_ids,
      );
      const candidate: SkillIterationCandidate = {
        schema_version: "1.0",
        iteration_id: "skill_iter_" + this.id(),
        status: "candidate",
        created_at: this.now().toISOString(),
        target_skill: mapping.name,
        source_digest: sha256(targetContent),
        model_id: model.modelId,
        history_task_ids: [...request.task_ids],
        history_message_count: transcript.length,
        summary: output.summary,
        signals: output.signals,
        data_processing_preferences: output.dataProcessingPreferences,
        proposed_skill_markdown: output.proposedSkillMarkdown,
        warnings: [
          ...output.warnings,
          "候选未自动激活；提升到 .pi/skills 前必须人工审查、验证并保留回滚点。",
        ],
      };
      await mkdir(this.candidateRoot, { recursive: true });
      await writeJsonAtomic(
        path.join(this.candidateRoot, candidate.iteration_id + ".json"),
        candidate,
        { private: true },
      );
      return candidate;
    } catch (error) {
      if (error instanceof SkillIterationError) throw error;
      throw new SkillIterationError(503, "Skill iteration failed", { cause: error });
    } finally {
      this.running = false;
    }
  }
}
