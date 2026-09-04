# Skill Repository Architecture Documentation Update Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the over-engineered architecture documents and oversized TODO with the team-approved OpenAI Agents SDK-centered Skill Repository design.

**Architecture:** Keep the existing Main Agent, Runner, RunContext, WebSocket, and SDK Function Tools. Add one unified, category-based Skill repository in which Skills package instructions and Tools, known websites use website-level Tools, and learned Skills are stored separately with an evolution log.

**Tech Stack:** Python 3.12, OpenAI Agents SDK, DashScope OpenAI-compatible Chat Completions, FastAPI, React, Markdown documentation.

## Global Constraints

- OpenAI Agents SDK remains the runtime core; do not introduce a parallel AgentRuntime abstraction.
- The runtime is not a mandatory `Agent -> SkillExecutor -> Tool` pipeline.
- A Skill is an on-demand capability package; a Tool is the SDK-callable execution unit.
- Use four primary Skill categories: discovery, acquisition, processing, and analysis.
- Parsing is part of processing but remains a separate step from downloading.
- Known large databases have website-level search/download Tools; related Tools may share one Skill.
- Separate built-in Skills from learned Skills; learned Skills must keep an evolution log.
- Browser automation is the fallback for unknown or changed websites.
- Download Tools may save raw files and metadata but must not parse them.
- Preserve unrelated uncommitted backend dependency and test changes.

---

### Task 1: Establish the Canonical Architecture Document

**Files:**
- Create: `docs/ARCHITECTURE.md`
- Modify: `docs/superpowers/specs/2026-07-11-core-architecture-foundation-design.md`

**Interfaces:**
- Produces: one canonical description of Main Agent, Skill Repository, Tool, RunContext, task workspace, and learned-Skill evolution.

- [ ] **Step 1:** Write `docs/ARCHITECTURE.md` with sections for product scope, current runtime, Agent/Skill/Tool boundaries, four Skill categories, repository layout, end-to-end data flow, website adaptation, learned-Skill evolution, outputs, testing, and non-goals.
- [ ] **Step 2:** State explicitly that paper discovery and paper-data extraction are first-class Skills, while paper files still pass through acquisition and processing boundaries.
- [ ] **Step 3:** State explicitly that one website should normally map to one or more Tools, not one Skill; related websites or workflows can share a Skill.
- [ ] **Step 4:** Replace the old foundation design with a short superseded notice pointing to `docs/ARCHITECTURE.md` so two architectures cannot be followed simultaneously.
- [ ] **Step 5:** Search the canonical document and ensure it contains no `AgentRuntime`, `SkillExecutor`, `ports/`, `Repository Protocol`, or `SiteRecipe` requirement.

### Task 2: Rewrite the Development TODO

**Files:**
- Replace: `docs/TODO.md`

**Interfaces:**
- Consumes: `docs/ARCHITECTURE.md`.
- Produces: a concise P0/P1/P2 development board aligned with the approved architecture.

- [ ] **Step 1:** Replace the current fifteen-stage TODO with sections for current state, P0 closed loop, four Skill categories, large-database Tools, learned Skills, frontend/API, testing, team ownership, sprint order, MVP definition, and deferred work.
- [ ] **Step 2:** Keep GEO, GDC, UCSC Xena, and RCSB PDB as the first website-level acquisition Tool integrations.
- [ ] **Step 3:** Add paper discovery, paper download, PDF/table/figure extraction, and paper-derived data provenance tasks.
- [ ] **Step 4:** Add the invariant `download only downloads; parsing happens later` to both requirements and tests.
- [ ] **Step 5:** Add learned-Skill requirements: separate directory, description, source/evolution log, validation record, and manual enable/disable state.
- [ ] **Step 6:** Remove requirements for a general SkillExecutor, mandatory sub-agents, a custom durable workflow platform, autonomous production promotion, and vector cache from P0.

### Task 3: Retire the Superseded Implementation Plan

**Files:**
- Modify: `docs/superpowers/plans/2026-07-11-core-architecture-foundation.md`

**Interfaces:**
- Produces: an unambiguous pointer from the superseded plan to the current architecture and TODO.

- [ ] **Step 1:** Replace the old implementation plan with a superseded notice explaining that the team retained Agents SDK as the core and rejected the parallel runtime/layered application redesign.
- [ ] **Step 2:** Preserve a short list of still-valid concerns: SDK event mapping, frontend WebSocket ownership, file safety, and executable tests.

### Task 4: Verify, Commit, and Push

**Files:**
- Verify: all changed Markdown files.

**Interfaces:**
- Produces: one documentation commit pushed to the current upstream branch.

- [ ] **Step 1:** Run `rg` checks for contradictory required architecture terms and inspect every hit.
- [ ] **Step 2:** Run a Markdown placeholder scan for `TBD`, unfinished placeholders, and contradictory Skill counts.
- [ ] **Step 3:** Run `git diff --check` and inspect `git diff --stat` plus the full staged documentation diff.
- [ ] **Step 4:** Stage only documentation files from this plan; do not stage `backend/pyproject.toml`, `backend/uv.lock`, or `backend/tests/`.
- [ ] **Step 5:** Commit with message `docs: align architecture around skill repository`.
- [ ] **Step 6:** Rebase or resolve only if the remote branch advanced; then push the documentation commit.

## Plan Self-Review

- The plan covers every agreement in the supplied team chat.
- It distinguishes website-level Tools from category-level Skills.
- It includes paper-derived data and learned-Skill logging.
- It removes the previously proposed parallel runtime and SiteRecipe design.
- It preserves unrelated working-tree changes.
