# Gold Exec Routing Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep Gold runs moving after known `workspace_exec` acquisition bypasses while preserving fail-closed handling for unknown commands.

**Architecture:** Reject subprocess network transport at the production workspace boundary. In the external formal supervisor, deny recognized shell/network bypasses and resume the same run; keep unknown requests as human-review stops. Align Agent instructions and current documentation with those executable policies.

**Tech Stack:** Node.js 22.19+, TypeScript, Vitest, dependency-free Node supervisor, Markdown.

## Global Constraints

- Do not expand the automatic permission allow-list.
- Do not execute or approve the reproduced Gold7/8 commands.
- Keep Dataset Core as the only formal publication boundary.
- Use test-first RED -> GREEN for every behavior change.

---

### Task 1: Reject direct network subprocesses

**Files:**
- Modify: `server/tests/workspace-tools.test.ts`
- Modify: `server/src/agent/workspace/exec.ts`

**Interfaces:**
- Consumes: `executeWorkspaceCommand()` input `{ executable, args, timeoutMs? }`.
- Produces: pre-permission `WorkspaceExecResult` with `policy: "rejected"` and governed-tool guidance.

- [ ] Add a test using a non-existent fixture path whose basename is `curl.exe` and the Gold8 URL arguments; assert `policy: "rejected"`, `exitCode: null`, and governed acquisition guidance.
- [ ] Run `pnpm --filter @biomed/server test -- workspace-tools.test.ts` and confirm the assertion fails because the command reaches process execution.
- [ ] Add the minimal executable/URL classifier to `validateCommand()`.
- [ ] Re-run the test and confirm it passes.

### Task 2: Deny known formal-supervisor bypasses

**Files:**
- Modify: `server/tests/gold-formal-supervisor.test.ts`
- Modify: `scripts/gold-formal-supervisor.mjs`

**Interfaces:**
- Consumes: durable `permission_requested` payloads.
- Produces: classifier action `deny` for known shell/network bypasses; `allow` for fixed parsers; `stop` otherwise.

- [ ] Add classifier tests for the exact Gold7 PowerShell and Gold8 curl shapes plus an unrelated unknown command.
- [ ] Run `pnpm --filter @biomed/server test -- gold-formal-supervisor.test.ts` and confirm the known bypasses still return `stop`.
- [ ] Implement the minimal known-bypass classifier and permission resolution branch for `decision: "deny"`.
- [ ] Re-run the supervisor test and confirm it passes.

### Task 3: Align instructions and documentation

**Files:**
- Modify: `server/tests/pi-adapter.test.ts`
- Modify: `server/src/agent/phase1-prompt.ts`
- Modify: `.pi/skills/dataset-construction/SKILL.md`
- Modify: `docs/gold-formal-rerun.md`
- Modify: `docs/ISSUES.md`

**Interfaces:**
- Consumes: route preflight status and workspace command rejection.
- Produces: one consistent recovery rule and current Gold rerun evidence.

- [ ] Add a prompt contract assertion covering governed acquisition and missing extraction-carrier blockers.
- [ ] Run the targeted prompt test and confirm RED.
- [ ] Add the minimal prompt/skill wording; run the prompt test to GREEN.
- [ ] Correct the formal supervisor allow-list text and record the fresh Gold7/8 diagnosis in `docs/ISSUES.md`.
- [ ] Run `pnpm docs:check`.

### Task 4: Verify and integrate

**Files:**
- Verify all modified files.

**Interfaces:**
- Consumes: Tasks 1-3.
- Produces: tested branch ready for merge.

- [ ] Run `pnpm --filter @biomed/server test`.
- [ ] Run `pnpm lint`, `pnpm typecheck`, and `pnpm build`.
- [ ] Run `git diff --check` and inspect the final diff.
- [ ] Commit with a conventional message, sync/rebase with `origin/main`, re-run required gates if the base changed, merge to `main`, push, and post the Commonly `[DONE]` check-in.

