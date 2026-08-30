// Usage: node scripts/gold-archive.cjs <task_id> <run_id> <evidence_dir> <case_label> <commit> <prompt_file>
// Archives a finished gold run from the durable store + Host API into an evidence pack:
// events-durable.jsonl, assistant-messages.md, artifacts.jsonl, closure.json (with run_usage
// and pre/post-publication token split), prompt copy. Idempotent (overwrite).
const fs = require("fs");
const path = require("path");
const [TASK, RUN, EV, LABEL, COMMIT, PROMPT] = process.argv.slice(2);
if (!TASK || !RUN || !EV || !LABEL || !COMMIT || !PROMPT) {
  console.error("usage: gold-archive.cjs <task_id> <run_id> <evidence_dir> <case> <commit> <prompt_file>");
  process.exit(1);
}
const BASE = "http://127.0.0.1:8000";
(async () => {
  fs.mkdirSync(EV, { recursive: true });
  const t = await (await fetch(`${BASE}/api/v1/tasks/${TASK}`)).json();
  const run = t.runs.find((r) => r.run_id === RUN) ?? t.runs.at(-1);
  fs.copyFileSync(`data/output/tasks/${TASK}/events.jsonl`, path.join(EV, "events-durable.jsonl"));
  fs.copyFileSync(PROMPT, path.join(EV, `prompt-${LABEL}.txt`));
  const events = fs.readFileSync(path.join(EV, "events-durable.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const pub = t.publications.at(-1);
  const pubDetail = pub ? await (await fetch(`${BASE}/api/v1/publications/${pub.publication_id}?task_id=${TASK}`)).json() : null;
  fs.writeFileSync(path.join(EV, "artifacts.jsonl"), (pubDetail?.artifacts ?? []).map((a) => JSON.stringify(a)).join("\n") + "\n");
  const usageEvents = events.filter((e) => e.type === "context_usage");
  const pubSeq = events.find((e) => e.type === "publication_created")?.sequence ?? Infinity;
  const u = usageEvents.filter((e) => e.payload.usage);
  const phase = (list) => ({
    calls: list.length,
    input: list.reduce((s, e) => s + e.payload.usage.input_tokens, 0),
    output: list.reduce((s, e) => s + e.payload.usage.output_tokens, 0),
    cache: list.reduce((s, e) => s + e.payload.usage.cache_read_tokens, 0),
    total: list.reduce((s, e) => s + e.payload.usage.total_tokens, 0),
    seconds: list.length ? Math.round((new Date(list.at(-1).timestamp) - new Date(list[0].timestamp)) / 1000) : 0,
  });
  const tools = {};
  for (const e of events) if (e.type === "tool_started") tools[e.payload.tool_name] = (tools[e.payload.tool_name] ?? 0) + 1;
  const wall = run.finished_at ? Math.round((new Date(run.finished_at) - new Date(run.started_at ?? run.created_at)) / 1000) : null;
  const classification = run.status === "completed" && pub ? "succeeded_publication"
    : run.status === "completed" ? "blocked_no_publication" : "failed_or_cancelled";
  fs.writeFileSync(path.join(EV, "closure.json"), JSON.stringify({
    schema_version: "1.0", case_label: LABEL, observed_commit: COMMIT, task_id: TASK, run_id: run.run_id,
    model_verified: "pi-session model_change asserted pre-launch (qwen3.8-flash)",
    terminal: { status: run.status, classification },
    wall: { started_at: run.started_at ?? run.created_at, finished_at: run.finished_at, seconds: wall },
    events_total: events.length,
    context_peak_tokens: Math.max(...usageEvents.map((e) => e.payload.tokens ?? 0)),
    compactions: events.filter((e) => e.type === "conversation_compacted").length,
    permission_stops: events.filter((e) => e.type === "permission_requested").length,
    hil: events.filter((e) => e.type === "user_input_required").length,
    publication: pub ?? null,
    publication_artifacts: (pubDetail?.artifacts ?? []).map((a) => a.artifact_id),
    phase_split: { pre_publication: phase(u.filter((e) => e.sequence < pubSeq)), post_publication: phase(u.filter((e) => e.sequence >= pubSeq)) },
    tool_counts: tools,
    tool_errors: events.filter((e) => e.type === "tool_completed" && e.payload.is_error).map((e) => `${e.payload.tool_name}@${e.sequence}`),
    run_usage: run.summary?.usage ?? null,
  }, null, 2) + "\n");
  const msgs = t.messages.filter((m) => m.role === "assistant");
  fs.writeFileSync(path.join(EV, "assistant-messages.md"),
    msgs.map((m, i) => `## assistant message ${i + 1} (${m.created_at})\n\n${m.content}`).join("\n\n---\n\n"));
  console.log(JSON.stringify({ classification, wall, usage: run.summary?.usage ?? null, peak: Math.max(...usageEvents.map((e) => e.payload.tokens ?? 0)) }, null, 1));
})();
