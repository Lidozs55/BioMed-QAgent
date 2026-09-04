# Dataset Core Deterministic Flow Diagram Implementation Plan

## Vertical Revision Override

This approved revision supersedes the landscape and left-to-right layout details
below. Regenerate the diagram as a compact top-to-bottom Core flow (final canvas
980x1320) with narrow cards and variable vertical gaps. Arrange the right-side
column as a mirrored timeline of the main axis - controlled inputs beside stages
01-02, the 2x2 non-publication grid beside the compatibility gate, dynamic
extension (narrow panel) beside stages 05-06, reliability beside stages 07-08,
and the authority note closing the column. In the non-publication grid, put the
two wired cells (Rejected, Review pending) in the left column facing the failure
corridor; route the longer product-gate failure edge around the outside of the
band so every edge stays crossing-free and passes through no shape. Keep only
architecture-level labels and the contracts `DatasetExecutionSpec`,
`SourceAsset`, `OperationResult`, `ProductAssessment`, and `DatasetPublication`.
Re-export and re-run the same structural, visual, and documentation checks
defined by this plan.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce an editable, presentation-quality draw.io diagram that highlights BioMed-QAgent's deterministic Dataset Core processing flow and trust gates.

**Architecture:** A tall top-to-bottom diagram uses one Core-owned deterministic
trust spine. Registered families enter at the top; dynamic FamilySpec transforms
enter later as candidate results that Core must re-admit. Processing, result
commitment, ProductAssessment, and immutable publication remain inside the Core
authority boundary. Reliability is summarized in a light side panel.

**Tech Stack:** draw.io XML, draw.io Desktop CLI, bundled `drawio-skill` validation and PNG-repair scripts.

## Global Constraints

- Treat current TypeScript Dataset Core code and current architecture documents as the source of truth.
- Keep the frontend, general Agent runtime, database bridge, and unrelated application-host topology out of the figure.
- Show `in_process_unisolated` honestly as non-isolated and without publication authority.
- Do not imply that Agent-authored values, arbitrary DAGs, empty primary data, or validation failures can publish.
- Use Chinese-first labels with essential contract and artifact names in English.
- Use orthogonal edges, avoid edge-node crossings, and optimize the canvas for
  top-to-bottom reading.

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

Create a tall single-page canvas with these regions:

```text
title and invariant strip
controlled inputs ──→ deterministic Core trust spine ──→ explicit non-publication states
                            ↓
                    immutable Publication
                    reliability side panel
```

Use draw.io's default light palette: blue Core flow, purple dynamic input, yellow
trust gates, green trusted outputs, red terminal failures, and a light grey
reliability panel. Do not add a legend.

- [ ] **Step 3: Add the deterministic processing stages**

Create numbered nodes in this exact semantic order:

```text
01 输入准入
02 获取与资产注册
03 解析与规范化
04 兼容性门禁
05 确定性构建
06 结果提交
07 产品评估与发布门禁
08 原子发布
```

The `05` node must name integration, deterministic derivation, and Family
assembly. The `07` node must name validation, provenance closure, review policy,
and Core-owned ProductAssessment without internal phase identifiers.

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

- [ ] **Step 3: Inspect region tiles cut from the preview**

Crop the preview into overlapping 2x2 tiles with a small Python/Pillow script
and read each tile as its own image. This exposes per-region defects (clipped
text, stacked edges, border collisions) that a single downscaled read hides.

- [ ] **Step 4: Apply at most two correction rounds**

Edit only the necessary XML geometry or styling, re-run structural validation,
and overwrite the same PNG preview after each round.

- [ ] **Step 5: Run repository documentation checks**

```powershell
pnpm docs:check
git diff --check
```

Expected: both commands exit with code 0.

- [ ] **Step 6: Commit the verified preview**

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

This draw.io build additionally writes a wrong CRC into the embedded
`mxGraphModel` zTXt chunk. After `repair_png.py`, recompute every chunk CRC
(zlib.crc32 over chunk type + body) and patch mismatches; strict decoders such
as Pillow refuse the file until the zTXt CRC is fixed. Verify with
`Image.open(...).load()` and by decompressing the zTXt payload
(`zlib.decompress(payload, -15)` then URL-decode) back into the diagram XML.

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
