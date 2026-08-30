// Usage: node scripts/gold-watch.cjs <task_id> [tail_events]
const [TASK, tailArg] = process.argv.slice(2);
if (!TASK) { console.error("task_id required"); process.exit(1); }
const TAIL = Number(tailArg ?? 14);
const BASE = "http://127.0.0.1:8000";
(async () => {
  const t = await (await fetch(`${BASE}/api/v1/tasks/${TASK}`)).json();
  const run = t.runs.at(-1);
  console.log(`STATUS=${t.task.status} seq=${t.task.latest_sequence} pubs=${t.publications.length} usage=${JSON.stringify(run.summary?.usage ?? null)}`);
  const e = await (await fetch(`${BASE}/api/v1/tasks/${TASK}/events?after_sequence=${Math.max(0, t.task.latest_sequence - TAIL)}&limit=${TAIL}`)).json();
  for (const x of e.events) {
    let l = `seq${x.sequence} ${x.type}`;
    if (x.payload.tool_name) l += ` ${x.payload.tool_name}`;
    if (x.type === "tool_started") l += ` ${JSON.stringify(x.payload.arguments ?? {}).slice(0, 110)}`;
    if (x.type === "tool_completed") l += ` err=${x.payload.is_error} ${String(x.payload.output ?? "").replace(/\s+/g, " ").slice(0, 130)}`;
    if (x.payload.capability) l += ` [${x.payload.capability}] ${String(x.payload.command ?? "").slice(0, 130)}`;
    if (x.payload.publication_id) l += ` ${x.payload.publication_id}`;
    if (x.payload.error) l += ` ERR=${x.payload.error}`;
    console.log(l);
  }
})();
