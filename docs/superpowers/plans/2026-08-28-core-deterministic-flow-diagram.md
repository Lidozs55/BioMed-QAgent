# Dataset Core Deterministic Flow Diagram Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce an editable, presentation-quality draw.io diagram that highlights BioMed-QAgent's deterministic Dataset Core processing flow and trust gates.

**Architecture:** A 16:9 left-to-right diagram uses two controlled input lanes—registered families and dynamic FamilySpec transforms—that converge into one Core-owned deterministic trust spine. Processing, result commitment, validation, ProductAssessment, and immutable publication remain visually inside the Core authority boundary, with reliability mechanisms shown as a continuous lower rail.

**Tech Stack:** draw.io XML, draw.io Desktop CLI, bundled `drawio-skill` validation and PNG-repair scripts.

## Global Constraints

- Treat current TypeScript Dataset Core code and current architecture documents as the source of truth.
- Keep the frontend, general Agent runtime, database bridge, and unrelated application-host topology out of the figure.
- Show `in_process_unisolated` honestly as non-isolated and without publication authority.
- Do not imply that Agent-authored values, arbitrary DAGs, empty primary data, or validation failures can publish.
- Use Chinese-first labels with essential contract and artifact names in English.
- Use orthogonal edges, avoid edge-node crossings, and keep the canvas suitable for 16:9 slides.

---

### Task 1: Author the editable Core diagram

**Files:**
- Create: `docs/architecture/biomed-qagent-core-deterministic-flow.drawio`

**Interfaces:**
- Consumes: the approved design in `docs/superpowers/specs/2026-08-28-core-deterministic-flow-diagram-design.md`
- Produces: a valid draw.io XML document with stable cell IDs and a single page named `Deterministic Core`

- [ ] **Step 1: Read the draw.io architecture and XML-authoring conventions**

Read the `Architecture` section of `references/diagram-types.md` and all of
`references/xml-authoring.md` from the selected drawio skill before writing XML.

- [ ] **Step 2: Build the high-level layout**

Create a 16:9 landscape canvas with these regions:

```text
title and invariant strip
registered-family lane ─┐
                        ├─ deterministic Core trust spine ─ immutable Publication
dynamic-family lane ────┘
reliability and audit rail
```

Use a deep-blue Core boundary, purple dynamic lane, amber trust gates, teal
trusted outputs, red terminal failures, and a charcoal reliability rail.

- [ ] **Step 3: Add the deterministic processing stages**

Create numbered nodes in this exact semantic order:

```text
01 输入准入
02 获取与资产注册
03 解析与适配
04 语义规范化
05 兼容性门禁
06 确定性构建
07 结果提交
08 可信验证与产品评估
09 原子发布
```

The `06` node must name integrate, fixed derive slot, and Family assembly. The
`08` node must name Validation/B3, provenance closure, confidence/HIL, and
Core-owned ProductAssessment.

- [ ] **Step 4: Add authority and terminal semantics**

Add compact callouts for these exact rules:

```text
Agent proposes specifications; Core owns values, topology, and publication.
Dynamic transforms produce candidate bytes; Core re-hashes and admits OperationResult.
Run completion does not imply Publication.
```

Route failed gates to `Rejected / NO_DATA / Failed / Cancelled`; route successful
assessment to immutable Publication containing Manifest, primary/supporting tables,
Schema, provenance, and audit evidence.

- [ ] **Step 5: Save and inspect the XML structure**

Run:

```powershell
python C:\Users\cheng\.agents\skills\drawio-skill\scripts\validate.py docs\architecture\biomed-qagent-core-deterministic-flow.drawio --score
```

Expected: no dangling edges, duplicate/reserved IDs, broken parents, or overlaps.

- [ ] **Step 6: Commit the editable source**

```powershell
git add docs\architecture\biomed-qagent-core-deterministic-flow.drawio
git commit -m "docs(core): add deterministic flow diagram"
```

### Task 2: Export and visually verify the review preview

**Files:**
- Create: `docs/images/biomed-qagent-core-deterministic-flow.png`
- Modify: `docs/architecture/biomed-qagent-core-deterministic-flow.drawio` only if visual corrections are required

**Interfaces:**
- Consumes: the validated draw.io source from Task 1
- Produces: a width-capped, non-embedded PNG for visual review

- [ ] **Step 1: Export a clean preview**

Resolve the installed draw.io CLI binary and run its Windows equivalent of:

```powershell
drawio -x -f png --width 2000 -b 20 -o docs\images\biomed-qagent-core-deterministic-flow.png docs\architecture\biomed-qagent-core-deterministic-flow.drawio
```

Expected: a readable PNG no wider than 2000 pixels, exported without `-e`.

- [ ] **Step 2: Inspect the preview visually**

Check for clipped labels, overlapping shapes, missing connections, off-canvas
content, edge-shape crossings, stacked edges, and weak visual hierarchy.

- [ ] **Step 3: Apply at most two correction rounds**

Edit only the necessary XML geometry or styling, re-run structural validation,
and overwrite the same PNG preview after each round.

- [ ] **Step 4: Run repository documentation checks**

```powershell
pnpm docs:check
git diff --check
```

Expected: both commands exit with code 0.

- [ ] **Step 5: Commit the verified preview**

```powershell
git add docs\architecture\biomed-qagent-core-deterministic-flow.drawio docs\images\biomed-qagent-core-deterministic-flow.png
git commit -m "docs(core): export deterministic flow preview"
```

### Task 3: Produce the approved final editable export

**Files:**
- Create: `docs/images/biomed-qagent-core-deterministic-flow.drawio.png`
- Modify: `docs/architecture/biomed-qagent-core-deterministic-flow.drawio` only for user-approved revisions

**Interfaces:**
- Consumes: user approval of the review preview
- Produces: an embedded-diagram PNG that can be reopened and edited in draw.io

- [ ] **Step 1: Apply targeted user feedback**

Preserve the established layout for node-level edits. Regenerate only if the
requested change alters the overall flow direction or grouping.

- [ ] **Step 2: Export the embedded final PNG**

Run the resolved draw.io CLI binary with:

```powershell
drawio -x -f png -e -s 2 -b 20 -o docs\images\biomed-qagent-core-deterministic-flow.drawio.png docs\architecture\biomed-qagent-core-deterministic-flow.drawio
python C:\Users\cheng\.agents\skills\drawio-skill\scripts\repair_png.py docs\images\biomed-qagent-core-deterministic-flow.drawio.png
```

Expected: the PNG has a valid IEND chunk and retains embedded editable diagram XML.

- [ ] **Step 3: Re-run final checks**

```powershell
python C:\Users\cheng\.agents\skills\drawio-skill\scripts\validate.py docs\architecture\biomed-qagent-core-deterministic-flow.drawio --score
pnpm docs:check
git diff --check
```

Expected: all commands exit with code 0.

- [ ] **Step 4: Commit the final export**

```powershell
git add docs\architecture\biomed-qagent-core-deterministic-flow.drawio docs\images\biomed-qagent-core-deterministic-flow.drawio.png
git commit -m "docs(core): finalize deterministic flow diagram"
```

- [ ] **Step 5: Report deliverables**

Provide clickable paths to the `.drawio` source, review PNG, and embedded final
PNG, and offer to open the source in draw.io Desktop for fine tuning.

